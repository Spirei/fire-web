"""F05 screenshot/file import and exact record exports, independent of F34 backup."""

import hashlib
import json
import math
from decimal import Decimal
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import UploadFile

from .fx_provider_parser import unique
from .legacy_flat_orders import TransactionDB
from .legacy_identity import assert_native_origin, native_identity, web_identity
from .legacy_order_workbooks import build_xlsx
from .native_app_auth import CLIENT
from .portfolio_records import record_dto
from .profile_http import bounded_body
from .record_file_imports import RecordImports, encoded
from .security import COOKIE, identity


async def actor(request, db, *, write=False):
    from .legacy_optional_credentials import credentials_present
    canonical = request.url.path.startswith(("/api/portfolio/", "/api/personal-data-transfer/")) or request.url.path in {
        "/api/activities/imported", "/api/activities/daily-summary",
    }
    if "authorization" in request.headers or COOKIE not in request.cookies or not canonical:
        credentials_present(request)
    if request.headers.get("authorization", "").startswith("Bearer fat_"):
        assert_native_origin(request, db.settings)
        who, grant = await native_identity(request, db, "portfolio.write" if write else "portfolio.read")
        if grant["client_id"] != CLIENT:
            raise HTTPException(401, "连接已失效，请重新连接")
        return who
    if "authorization" not in request.headers and canonical and COOKIE in request.cookies:
        return await identity(request)
    return (await web_identity(request, db, allow_platform="authorization" not in request.headers, allow_legacy_bearer=True))[0]


def mount_record_file_imports(app, db):
    service = RecordImports(db)
    app.state.record_file_imports = service

    async def raw_json(request, limit=1048576):
        try:
            return json.loads(
                await bounded_body(request, limit),
                object_pairs_hook=unique,
                parse_float=Decimal,
                parse_constant=lambda value: (_ for _ in ()).throw(ValueError("nonfinite")),
            )
        except (ValueError, UnicodeDecodeError) as exc:
            raise HTTPException(400, "JSON格式无效") from exc

    @app.get("/api/portfolio/record-imports/capabilities")
    async def capabilities(request: Request):
        who = await actor(request, db)
        async with db.connection() as conn, conn.transaction():
            await service.records.read_lock(conn, who.id, who)
        targets = service.ocr.available(who)
        return {
            "targets": targets,
            "ocrState": "available" if targets else "unavailable",
            "limits": {
                "imageBytes": 8 * 1024 * 1024,
                "jsonBytes": 10 * 1024 * 1024,
                "xlsxBytes": 16 * 1024 * 1024,
                "previewRows": 2000,
                "ocrPreviewRows": 100,
            },
            "formats": ["image", "json", "xlsx"],
            "automaticExternalCall": False,
            "fullSiteBackupSupported": False,
        }

    async def upload(request, who, *, legacy=False):
        if not await app.state.rate_limit(db, "record-import-source:" + who.id, 10, window_seconds=60):
            raise HTTPException(429, "识别或导入过于频繁")
        await bounded_body(request, 16 * 1024 * 1024 + 65536)
        form = await request.form(max_files=1, max_fields=4, max_part_size=16 * 1024 * 1024)
        if set(form) - {"file", "requestId", "format", "targetId"} or any(
            len(form.getlist(key)) != 1 for key in form
        ):
            raise HTTPException(400, "文件上传字段无效")
        file = form.get("file")
        if not isinstance(file, UploadFile):
            raise HTTPException(400, "请选择要导入的文件")
        raw = await file.read(16 * 1024 * 1024 + 1)
        rid = form.get("requestId") or request.headers.get("x-alcor-request-id")
        explicit = rid is not None
        rid = rid or str(uuid4())
        fmt = "image" if legacy else form.get("format")
        target = form.get("targetId")
        if legacy and not target:
            # Old upload is explicit consent; a unique already-approved owner
            # provider is the only unambiguous legacy configuration.
            targets = [value for value in service.ocr.available(who) if not value.get("fallbackOnly")]
            if len(targets) == 1:
                target = targets[0]["id"]
        result = await service.upload(who, rid, raw, fmt, file.filename or "records", target)
        result = {**result, "legacyClientIdempotency": explicit}
        if legacy and result.get("state") == "recognized":
            from .record_image_ocr import identity
            candidates = result.get("rows", [])
            resolved, matches = [], []
            async with db.connection() as conn, conn.transaction():
                await service.records.read_lock(conn, who.id, who)
                await conn.execute("SELECT pg_advisory_xact_lock_shared(hashtextextended('asset-lookup-catalog',0))")
                for candidate in candidates:
                    symbol, market = identity(candidate.get("code", ""), candidate.get("market", ""))
                    assets = await (await conn.execute(
                        "SELECT e.market,e.name FROM asset_catalog_entries e JOIN asset_catalog_sources s ON s.id=e.source_id "
                        "WHERE e.type='stock' AND upper(e.code)=%s AND (%s='' OR upper(e.market)=%s) "
                        "AND s.manifest->>'publicMetadataConfirmed'='true' AND NOT EXISTS "
                        "(SELECT 1 FROM asset_catalog_tombstones t WHERE t.asset_id=e.id AND t.restored_at IS NULL) ORDER BY e.id LIMIT 2",
                        (symbol, market, market),
                    )).fetchall()
                    match = assets[0] if len(assets) == 1 else None
                    resolved.append({**candidate, "code": symbol, "market": market or (match["market"] if match else ""),
                                     "name": candidate.get("name") or (match["name"] if match else "")})
                    matches.append(match)
            proof = await service.preview(who, {"sourceId": result["sourceId"], "rows": resolved})
            projected = []
            for row, match in zip(proof["rows"], matches, strict=True):
                numeric = {}
                for field in ("qty", "price", "cost"):
                    exact = row.get(field)
                    value = float(exact) if exact is not None else None
                    numeric[field] = value if value is None or math.isfinite(value) and (value != 0 or Decimal(exact) == 0) else None
                    numeric[field + "Exact"] = exact
                change = resolved[len(projected)].get("changePct")
                change_value = float(change) if change is not None else None
                projected.append({**row, **numeric, "changePct": change_value if change_value is None or math.isfinite(change_value) else None,
                                  "changePctExact": change,
                                  "status": "skip" if row["status"] != "ready" else "update" if row["action"] == "update" else "new",
                                  "matched": match is not None, **({"matchedName": match["name"]} if match else {})})
            result = {**result, "rows": projected, "previewId": proof["previewId"]}
        status = 200
        if legacy and result.get("state") in {"unavailable", "unknown"}:
            status = 503
            result = {**result, "error": result.get("reason") or "识别当前不可用，请查询原UUID"}
        elif legacy and (result.get("state") == "rejected" or result.get("state") == "recognized" and not result.get("rows")):
            status = 422
            result = {**result, "error": result.get("reason") or "没有从截图中识别到股票，请换一张持仓或行情截图"}
        return JSONResponse(result, status_code=status, headers={"Cache-Control": "no-store", "X-Alcor-Request-Id": str(rid)})

    @app.post("/api/portfolio/record-imports/sources")
    async def source(request: Request):
        return await upload(request, await actor(request, db, write=True))

    @app.post("/api/records/import-image")
    async def old_image(request: Request):
        return await upload(request, await actor(request, db, write=True), legacy=True)

    @app.get("/api/portfolio/record-imports/operations/{request_id}")
    async def operation(request: Request, request_id: UUID):
        return await service.operation(await actor(request, db), request_id)

    @app.post("/api/portfolio/record-imports/previews")
    async def preview(request: Request):
        return await service.preview(await actor(request, db, write=True), await raw_json(request))

    @app.post("/api/portfolio/record-imports/submissions")
    async def submit(request: Request):
        return await service.submit(await actor(request, db, write=True), await raw_json(request, 16384))

    @app.get("/api/portfolio/record-imports/sources/{source_id}/original")
    async def original(request: Request, source_id: UUID):
        who = await actor(request, db)
        async with db.connection() as conn, conn.transaction():
            await service.records.read_lock(conn, who.id, who)
            row = await (
                await conn.execute(
                    "SELECT raw,sha256 FROM record_import_sources WHERE owner_id=%s AND id=%s",
                    (who.id, source_id),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "原件不存在")
            raw = bytes(row["raw"])
            if hashlib.sha256(raw).hexdigest() != row["sha256"]:
                raise HTTPException(409, "原件完整性核对失败")
            return Response(
                raw,
                media_type="application/octet-stream",
                headers={
                    "Cache-Control": "no-store",
                    "Content-Disposition": 'attachment; filename="record-source.bin"',
                    "X-Content-SHA256": row["sha256"],
                    "X-Content-Type-Options": "nosniff",
                },
            )

    @app.post("/api/records/import-apply")
    async def old_apply(request: Request):
        who = await actor(request, db, write=True)
        raw = await raw_json(request)
        if (
            not isinstance(raw, dict)
            or set(raw) - {"rows", "groupId", "requestId"}
            or not isinstance(raw.get("rows"), list)
        ):
            raise HTTPException(400, "导入记录无效")
        request_id = raw.get("requestId") or request.headers.get("x-alcor-request-id")
        explicit = request_id is not None
        try:
            rid = str(UUID(request_id)) if request_id else str(uuid4())
        except ValueError as exc:
            raise HTTPException(400, "原UUID无效") from exc
        # Legacy null means "retain an existing observation"; canonical edited
        # rows distinguish a missing field from an explicitly unknown null.
        rows = [
            {k: v for k, v in row.items() if v is not None} if isinstance(row, dict) else row
            for row in raw["rows"]
        ]
        async with db.connection() as conn, conn.transaction():
            await service.records.lock(conn, who.id, who)
            prior = await (
                await conn.execute(
                    "SELECT result FROM record_import_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if prior:
                original = (
                    await (
                        await conn.execute(
                            "SELECT p.plan FROM record_import_operations o JOIN record_import_previews p ON p.owner_id=o.owner_id AND p.id=o.preview_id WHERE o.owner_id=%s AND o.request_id=%s",
                            (who.id, rid),
                        )
                    ).fetchone()
                )["plan"]
                if original.get("legacyInput") != encoded(raw):
                    raise HTTPException(409, "原UUID对应不同导入记录")
                return JSONResponse(
                    prior["result"], headers={"Cache-Control": "no-store", "X-Alcor-Request-Id": rid,
                                               "X-Alcor-Legacy-Client-Idempotency": str(explicit).lower()}
                )
            bridge = RecordImports(TransactionDB(db, conn))
            source_id = str(uuid5(NAMESPACE_URL, "alcor.record-import-source:" + who.id + ":" + rid))
            source = await bridge.upload(
                who,
                source_id,
                json.dumps(encoded({"rows": rows}), ensure_ascii=False).encode(),
                "json",
                "legacy-record-rows.json",
            )
            proof = await bridge.preview(
                who,
                {"sourceId": source["sourceId"], "rows": rows, "groupId": raw.get("groupId", "")},
                legacy_input=encoded(raw),
            )
            # Persist legacy input in its immutable preview before it is used.
            # Preview generation owns this field through an optional parameter;
            # no stored source or already-issued preview is rewritten.
            result = await bridge.submit(
                who, {"requestId": rid, "previewId": proof["previewId"], "confirm": True}
            )
            return JSONResponse(
                result,
                headers={"Cache-Control": "no-store", "X-Alcor-Request-Id": rid,
                         "X-Alcor-Legacy-Client-Idempotency": str(explicit).lower()},
            )

    async def export(request: Request):
        who = await actor(request, db)
        async with db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            revision = await service.records.read_lock(conn, who.id, who)
            from .scope_coverage import require_global

            await require_global(conn, who.id)
            history_allowed = True
            if getattr(who, "native_client", False):
                from .native_app_auth import active_grant

                grant = await active_grant(conn, who.grant_id)
                history_allowed = bool(grant and "orders.read" in grant["scope"].split())
            rows = await (
                await conn.execute(
                    "SELECT * FROM portfolio_records WHERE owner_id=%s ORDER BY id LIMIT 10001", (who.id,)
                )
            ).fetchall()
            if len(rows) > 10000:
                raise HTTPException(409, "记录导出超过完整范围预算")
            history = {}
            for table in (
                "trade_ledger",
                "trade_amendments",
                "trade_fee_corrections",
                "broker_position_transfers",
                "record_import_links",
            ):
                # Fixed platform table names only; raw originals stay private to owner.
                if table != "record_import_links" and not history_allowed:
                    continue
                data = await (
                    await conn.execute("SELECT * FROM " + table + " WHERE owner_id=%s LIMIT 20001", (who.id,))
                ).fetchall()
                if len(data) > 20000:
                    raise HTTPException(409, "历史超过本次完整导出预算")
                history[table] = encoded(data)
            payload = {
                "format": "alcor-records-transfer",
                "version": 1,
                "owner": who.id,
                "collectionRevision": revision,
                "records": [
                    record_dto(row) if row["deleted_at"] is None else {**encoded(row), "deleted": True}
                    for row in rows
                ],
                "originalRecords": encoded(rows),
                "history": history,
                "financialHistoryIncluded": history_allowed,
                "financialHistoryUnavailableReason": None if history_allowed else "missing_orders_read_scope",
                "recordScopeComplete": True,
                "fullSiteBackup": False,
                "unrepresentedDomains": [
                    "siteSettings",
                    "funds",
                    "cards",
                    "activities",
                    "userSettings",
                    "watchGroups",
                ],
            }
        if request.query_params.get("format") == "xlsx":
            columns = [
                "name",
                "code",
                "market",
                "qty",
                "price",
                "cost",
                "id",
                "user_id",
                "source",
                "note",
                "brokerAccountId",
                "accountMarket",
            ]
            data = [columns] + [
                [
                    str((record_dto(row) if row["deleted_at"] is None else {}).get(key) or "")
                    if key != "user_id"
                    else who.id
                    for key in columns
                ]
                for row in rows
                if row["deleted_at"] is None
            ]
            return Response(
                build_xlsx([("记录", data)]),
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={
                    "Cache-Control": "no-store",
                    "Content-Disposition": 'attachment; filename="records.xlsx"',
                    "X-Alcor-History-Included": "false",
                },
            )
        return JSONResponse(payload, headers={"Cache-Control": "no-store", "X-Alcor-Scope": "records-only"})

    app.add_api_route(
        "/api/portfolio/records/export", export, methods=["GET"], operation_id="portfolio_records_export"
    )
