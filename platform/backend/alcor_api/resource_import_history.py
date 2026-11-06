"""Resource-source history only; never imports bytes, probes paths or grants scope."""

from fastapi import HTTPException, Request, Response

from .security import identity, lock_mutation_identity
from .source_authority import physical_identity_hash
from .source_history import paging


def mount_resource_import_history(app):
    db = app.state.db
    service = app.state.resource_import

    async def member(request, response):
        response.headers["Cache-Control"] = "no-store, private"
        if "authorization" in request.headers:
            raise HTTPException(403, "请使用当前网页登录会话")
        return await identity(request)

    @app.get("/api/resource-import/registration-options")
    async def options(request: Request, response: Response):
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        who = await member(request, response)
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=True)
            items = []
            for alias in service.resources:
                definition = service.authority.registry.get(alias)
                if not definition:
                    continue
                claims = await (
                    await conn.execute(
                        "SELECT c.source_owner,u.id,u.username,u.uid FROM legacy_source_owner_claims c JOIN users u ON u.id=c.owner_id WHERE c.source_instance=%s AND c.physical_identity_hash=%s AND c.source_owner=ANY(%s) AND u.active ORDER BY c.source_owner",
                        (definition.instance, physical_identity_hash(definition), list(definition.owners)),
                    )
                ).fetchall()
                items.append(
                    {
                        "alias": alias,
                        "sourceInstance": definition.instance,
                        "scope": "resources.migrate",
                        "migrationWindow": definition.window_status(),
                        "owners": [
                            {
                                "sourceOwner": r["source_owner"],
                                "targetUserId": r["id"],
                                "targetName": r["username"],
                                "targetPublicUid": r["uid"],
                            }
                            for r in claims
                        ],
                        "unclaimedOwnerCount": len(
                            set(definition.owners) - {r["source_owner"] for r in claims}
                        ),
                    }
                )
            return {"items": items}

    @app.get("/api/resource-import/manifests")
    async def manifests(request: Request, response: Response):
        limit, cursor = paging(request.query_params)
        who = await member(request, response)
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            after = None
            if cursor:
                after = await (
                    await conn.execute(
                        "SELECT id,created_at FROM resource_import_manifests WHERE owner_id=%s AND id=%s",
                        (who.id, cursor),
                    )
                ).fetchone()
                if not after:
                    raise HTTPException(400, "分页位置无效")
            rows = await (
                await conn.execute(
                    "SELECT id,consent_id,consent_revision,state,digest,manifest,created_at FROM resource_import_manifests WHERE owner_id=%s AND (%s::timestamptz IS NULL OR (created_at,id)<(%s::timestamptz,%s::uuid)) ORDER BY created_at DESC,id DESC LIMIT %s",
                    (
                        who.id,
                        after["created_at"] if after else None,
                        after["created_at"] if after else None,
                        after["id"] if after else None,
                        limit + 1,
                    ),
                )
            ).fetchall()
            items = []
            for row in rows[:limit]:
                summary = await service.summary(conn, row["id"])
                summary["targetImportCompleted"] = row["state"] == "sealed" and summary["remaining"] == 0
                items.append(
                    {
                        "id": str(row["id"]),
                        "consentId": str(row["consent_id"]),
                        "consentRevision": row["consent_revision"],
                        "state": row["state"],
                        "digest": row["digest"],
                        "manifest": row["manifest"],
                        "createdAt": row["created_at"].isoformat(),
                        **summary,
                    }
                )
            return {"items": items, "nextCursor": str(rows[limit - 1]["id"]) if len(rows) > limit else None}

    @app.get("/api/resource-import/operations")
    async def operations(request: Request, response: Response):
        limit, cursor = paging(request.query_params)
        who = await member(request, response)
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=False)
            query = """SELECT request_id,created_at,result FROM resource_import_operations WHERE owner_id=%s
                UNION ALL SELECT m.request_id,m.created_at,jsonb_build_object('requestId',m.request_id::text,'manifestId',m.id::text,'state','pending','targetImportCompleted',false) result FROM resource_import_manifests m WHERE m.owner_id=%s AND m.state='capturing' AND NOT EXISTS(SELECT 1 FROM resource_import_operations o WHERE o.owner_id=m.owner_id AND o.request_id=m.request_id)"""
            after = None
            if cursor:
                after = await (
                    await conn.execute(
                        "SELECT request_id,created_at FROM (" + query + ") r WHERE request_id=%s",
                        (who.id, who.id, cursor),
                    )
                ).fetchone()
                if not after:
                    raise HTTPException(400, "分页位置无效")
            rows = await (
                await conn.execute(
                    "SELECT * FROM ("
                    + query
                    + ") r WHERE (%s::timestamptz IS NULL OR (created_at,request_id)<(%s::timestamptz,%s::uuid)) ORDER BY created_at DESC,request_id DESC LIMIT %s",
                    (
                        who.id,
                        who.id,
                        after["created_at"] if after else None,
                        after["created_at"] if after else None,
                        after["request_id"] if after else None,
                        limit + 1,
                    ),
                )
            ).fetchall()
            return {
                "items": [
                    {
                        "requestId": str(r["request_id"]),
                        "createdAt": r["created_at"].isoformat(),
                        "result": r["result"],
                    }
                    for r in rows[:limit]
                ],
                "nextCursor": str(rows[limit - 1]["request_id"]) if len(rows) > limit else None,
            }
