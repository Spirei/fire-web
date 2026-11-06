"""Legacy backup controls and versioned administrator scheduling, no mutation on GET."""

import json
from uuid import UUID, uuid4

from fastapi import HTTPException, Request

from .backup_schedule import BackupSchedule
from .card_preferences_protocol import card_member, wire_response
from .legacy_optional_credentials import credentials_present
from .profile_http import bounded_body
from .security import identity


def mount_backup_schedule(app, db):
    service = BackupSchedule(db)
    app.state.backup_schedule = service

    async def member(request, legacy=False):
        credentials_present(request, platform=not legacy)
        if legacy:
            who = await card_member(request, db)
        else:
            if "authorization" in request.headers:
                raise HTTPException(403, "请使用当前管理员Web会话")
            who = await identity(request)
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        return who

    async def execute(request, action, legacy=False):
        headers = {"Cache-Control": "no-store, private", "Vary": "Cookie, Authorization"}
        try:
            who = await member(request, legacy)
            if action == "read":
                async with db.connection() as conn, conn.transaction():
                    await service.lock(conn, who)
                    result = await service.read_on_connection(conn)
                    if legacy:
                        rows = await (
                            await conn.execute(
                                "SELECT b.*,r.state AS retention_state FROM backups b LEFT JOIN LATERAL (SELECT state FROM backup_retention_results WHERE backup_id=b.id ORDER BY created_at DESC LIMIT 1) r ON true WHERE b.source_instance=%s ORDER BY b.created_at DESC LIMIT 100",
                                (db.settings.instance_id,),
                            )
                        ).fetchall()
                if legacy:
                    result = {
                        **result,
                        "backups": [
                            {
                                "id": str(r["id"]),
                                "createdAt": r["created_at"].isoformat(),
                                "bytes": r["bytes"],
                                "sha256": r["sha256"],
                                "verifiedAt": r["verified_at"].isoformat() if r["verified_at"] else None,
                                "state": "retired"
                                if r["retention_state"] == "deleted"
                                else "unknown"
                                if r["retention_state"] in {"admitted", "unknown"}
                                else "registered",
                            }
                            for r in rows
                        ],
                    }
                return wire_response(result, headers)
            body = await bounded_body(request, 16384)

            def reject(_):
                raise ValueError("nonfinite")

            from .fx_provider_parser import unique

            raw = json.loads(body, object_pairs_hook=unique, parse_constant=reject) if body else {}
            allowed = {"requestId", "expectedRevision", "password", "code"} | (
                {"enabled", "intervalHours", "keep"} if action == "save" else set()
            )
            if not isinstance(raw, dict) or set(raw) - allowed:
                raise HTTPException(400, "备份字段无效")
            generated = legacy and not raw.get("requestId")
            if not raw.get("requestId"):
                if not legacy:
                    raise HTTPException(400, "备份操作需要原UUID")
                raw["requestId"] = str(uuid4())
            raw["requestId"] = str(UUID(str(raw["requestId"])))
            result = (
                await service.save(who, raw, legacy=legacy)
                if action == "save"
                else await service.create(who, raw["requestId"])
            )
            return wire_response(
                {**result, "legacyClientIdempotency": not generated},
                headers,
                202 if action == "create" else 200,
            )
        except HTTPException as exc:
            headers.update(exc.headers or {})
            error = {"error": str(exc.detail)}
            if not legacy and headers.get("X-Alcor-Proof-Rejected") == "true":
                error = {"error": {"message": str(exc.detail), "code": "backup_schedule_proof_rejected"}}
            elif exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return wire_response(error, headers, exc.status_code)
        except (ValueError, TypeError, UnicodeError):
            return wire_response({"error": "备份请求格式无效"}, headers, 400)

    for prefix, legacy in (("/api/backup", True), ("/api/backups/schedule", False)):
        for method, action in (
            (("GET", "read"), ("PUT", "save")) if legacy else (("GET", "read"), ("POST", "save"))
        ):

            def endpoint(selected, old):
                async def handler(request: Request):
                    return await execute(request, selected, old)

                return handler

            app.add_api_route(
                prefix,
                endpoint(action, legacy),
                methods=[method],
                operation_id=("legacy_" if legacy else "canonical_") + "backup_schedule_" + method.lower(),
            )

    @app.post("/api/backup")
    async def create(request: Request):
        return await execute(request, "create", True)

    @app.get("/api/backups/schedule/operations/{identifier}")
    async def receipt(identifier: UUID, request: Request):
        return wire_response(
            await service.receipt(await member(request), identifier), {"Cache-Control": "no-store, private"}
        )

    return service
