"""Public exact lookup and administrator-confirmed metadata import; no provider IO."""

import json
import re
from uuid import UUID

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse

from .asset_lookup_catalog import AssetCatalog
from .asset_lookup_contract import alias_path, parse_lookup, reject_constant
from .legacy_identity import assert_native_origin
from .native_app_auth import CLIENT, authenticate
from .profile_http import bounded_body
from .security import administrator, digest
from .system_asset_api import content


def mount_asset_catalog(app, settings, db):
    from .legacy_asset_directory import LegacyAssetDirectory, public_upload_root
    from .legacy_card_directory import LegacyCardDirectory
    app.state.legacy_asset_directory = LegacyAssetDirectory(public_upload_root(settings))
    app.state.legacy_card_directory = LegacyCardDirectory(public_upload_root(settings))
    app.state.legacy_card_directory.asset_directory = app.state.legacy_asset_directory
    from .asset_library_access import mount_material_access, assert_material_read
    mount_material_access(app, db)
    service = AssetCatalog(db, app.state.legacy_asset_directory)
    app.state.asset_lookup_catalog = service

    async def admin(request):
        if "authorization" in request.headers:
            raise HTTPException(403, "请使用当前网页管理员会话")
        return await administrator(request)

    async def body(request, fields):
        try:
            raw = json.loads(await bounded_body(request, 65536), parse_constant=reject_constant)
            if not isinstance(raw, dict) or set(raw) != set(fields):
                raise ValueError()
            return raw
        except (ValueError, UnicodeError, RecursionError):
            raise HTTPException(400, "素材清单请求无效") from None

    async def v2(request):
        try:
            assert_native_origin(request, settings)
            if "authorization" in request.headers:
                matched = re.fullmatch(r"Bearer (fat_[A-Za-z0-9_-]{43})", request.headers["authorization"])
                if not matched:
                    raise HTTPException(401, "需要有效的 App 连接")
                async with db.connection() as conn:
                    grant = await authenticate(conn, matched[1])
                if grant["client_id"] != CLIENT:
                    raise HTTPException(401, "连接已失效，请重新连接")
        except HTTPException as exc:
            return JSONResponse(
                {
                    "code": 40102 if exc.detail == "连接已失效，请重新连接" else exc.status_code * 100 + 1,
                    "message": str(exc.detail),
                },
                status_code=exc.status_code,
                headers={"Cache-Control": "no-store"},
            )

    async def lookup(request, version=None):
        if version == 2:
            denied = await v2(request)
            if denied is not None:
                return denied
        headers = {
            "Cache-Control": "no-store, private",
            **({"X-Alcor-API-Version": "2"} if version == 2 else {}),
        }
        try:
            await assert_material_read(request, db)
            ip = request.client.host if request.client else "unknown"
            if not await app.state.read_rate_limit(
                db, digest("asset-lookup:" + ip), 120, window_seconds=60
            ) or not await app.state.read_rate_limit(db, "asset-lookup-global", 1200, window_seconds=60):
                raise HTTPException(429, "请求过于频繁")
            keys = parse_lookup(
                request.query_params.getlist("keys")[0] if request.query_params.getlist("keys") else None
            )
            result = await service.lookup(keys)
            if version == 2 and "authorization" in request.headers:
                denied = await v2(request)
                if denied is not None:
                    return denied
            return JSONResponse(
                {"code": 0, "message": "ok", "data": result["assets"]} if version else result,
                headers={**headers, "X-Alcor-Source-Coverage": "platform-public-metadata"},
            )
        except HTTPException as exc:
            return JSONResponse(
                {"code": exc.status_code * 100 + 1, "message": str(exc.detail)}
                if version
                else {"error": str(exc.detail)},
                status_code=exc.status_code,
                headers=headers,
            )

    @app.get("/api/v1/assets/lookup")
    async def old_v1(request: Request):
        return await lookup(request, 1)

    @app.get("/api/v2/assets/lookup")
    async def old_v2(request: Request):
        return await lookup(request, 2)

    @app.get("/api/asset-catalog/lookup")
    async def canonical_lookup(request: Request):
        return await lookup(request)

    @app.get("/api/asset-catalog")
    async def directory(request: Request):
        await assert_material_read(request, db)
        kind = request.query_params.get("type")
        if kind is not None and kind not in (
            "stock",
            "market",
            "flag",
            "crypto",
            "metal",
            "broker",
            "group",
            "card",
        ):
            raise HTTPException(400, "素材分类无效")
        if request.query_params.get("paged") == "1":
            from .asset_catalog_management import page_number
            return await app.state.asset_catalog_management.listing(
                kind=kind, q=request.query_params.get("q", ""),
                market=request.query_params.get("market") or None,
                page=page_number(request.query_params.get("page")),
                page_size=page_number(request.query_params.get("pageSize"), 50, 100),
            )
        return await service.directory(kind)

    @app.get("/api/admin/asset-catalog")
    async def snapshot(request: Request):
        return await service.snapshot(await admin(request))

    @app.post("/api/admin/asset-catalog/preview")
    async def preview(request: Request):
        who = await admin(request)
        data = await body(request, ("manifestText", "sourceLabel"))
        return await service.preview(who, data["manifestText"], data["sourceLabel"])

    @app.post("/api/admin/asset-catalog/imports")
    async def import_source(request: Request):
        who = await admin(request)
        data = await body(
            request, ("manifestText", "sourceLabel", "requestId", "expectedRevision", "expectedSha256")
        )
        try:
            identifier = UUID(data["requestId"])
            if str(identifier) != data["requestId"]:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(400, "原请求编号无效") from None
        return await service.import_source(
            who,
            identifier,
            data["expectedRevision"],
            data["expectedSha256"],
            data["manifestText"],
            data["sourceLabel"],
        )

    @app.get("/api/admin/asset-catalog/operations/{identifier}")
    async def receipt(identifier: UUID, request: Request):
        return await service.receipt(await admin(request), identifier)

    @app.get("/api/admin/asset-catalog/sources/{identifier}")
    async def source(identifier: UUID, request: Request):
        return await service.source(await admin(request), identifier)

    @app.post("/api/admin/asset-catalog/operations/{identifier}/close")
    async def close(identifier: UUID, request: Request):
        who = await admin(request)
        if (await bounded_body(request, 128)).strip() not in (b"", b"{}"):
            raise HTTPException(400, "关闭请求不能携带素材内容")
        return await service.close(who, identifier)

    @app.get("/api/asset-catalog/alias")
    async def resolve(request: Request):
        await assert_material_read(request, db)
        return await service.resolve_alias(alias_path(request.query_params.get("url")))

    @app.get("/api/asset-image/{key}")
    async def image(key: str, request: Request):
        access = await assert_material_read(request, db)
        if not re.fullmatch(r"[a-f0-9]{24}", key):
            return Response("Not Found", status_code=404, headers={"Cache-Control": "no-store"})
        try:
            row, stream = await service.original(key)
        except HTTPException as exc:
            return Response(
                "Not Found" if exc.status_code == 404 else "Image Unavailable",
                status_code=exc.status_code,
                headers={"Cache-Control": "no-store"},
            )
        etag = '"' + row["served_sha256"][:12] + '"'
        if "range" not in request.headers and request.headers.get("if-none-match") == etag:
            stream.close()
            return Response(status_code=304, headers={"Cache-Control": "public, no-cache" if access["guest"] else "private, no-store", "Vary":"Cookie, Authorization", "ETag": etag})
        # The outer old route only compares its short ETag without a Range header.
        checked = Request(
            {
                **request.scope,
                "headers": [
                    (name, value)
                    for name, value in request.scope["headers"]
                    if name.lower() != b"if-none-match"
                ],
            }
        )
        response = content(checked, row, stream)
        response.headers["ETag"] = etag
        response.headers["Cache-Control"] = "public, no-cache" if access["guest"] else "private, no-store"
        response.headers["Vary"] = "Cookie, Authorization"
        return response

    from .asset_catalog_management_api import mount_asset_management

    mount_asset_management(app, db, service, admin, v2)
