"""Ordinary public asset directory and administrator-only metadata mutations."""

import json
from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .asset_catalog_management import TYPES, V1_TYPES, AssetManagement, page_number
from .asset_lookup_contract import reject_constant, trim
from .asset_web_keys import select_web_keys
from .asset_web_paging import web_page_number
from .card_preferences import js_text
from .card_preferences_protocol import card_member
from .profile_http import bounded_body


def mount_asset_management(app, db, catalog, canonical_admin, v2_access):
    service = AssetManagement(catalog, getattr(app.state, "legacy_asset_directory", None), getattr(app.state, "legacy_card_directory", None))
    app.state.asset_catalog_management = service
    headers = {
        "Cache-Control": "private, no-store",
        "Vary": "Cookie, Authorization",
        "X-Alcor-Source-Coverage": "platform-public-metadata",
    }

    def result(data, version=None, meta=None, status=200):
        body = (
            {"code": 0, "message": "ok", "data": data, **({"meta": meta} if meta else {})}
            if version
            else data
        )
        return JSONResponse(
            body,
            status_code=status,
            headers={**headers, **({"X-Alcor-API-Version": "2"} if version == 2 else {})},
        )

    def error(exc, version=None):
        return JSONResponse(
            {"code": exc.status_code * 100 + 1, "message": str(exc.detail)}
            if version
            else {"error": str(exc.detail)},
            status_code=exc.status_code,
            headers={
                **headers,
                **({"X-Alcor-Retire-Context": "true"} if exc.status_code in (401, 403) else {}),
                **({"X-Alcor-API-Version": "2"} if version == 2 else {}),
            },
        )

    async def member(request, legacy):
        who = await card_member(request, db) if legacy else await canonical_admin(request)
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        if legacy:
            async with db.connection() as conn:
                web = await (
                    await conn.execute(
                        "SELECT 1 FROM sessions WHERE token_hash=%s AND user_id=%s AND client_id='legacy-web'",
                        (who.token_hash, who.id),
                    )
                ).fetchone()
            if not web:
                raise HTTPException(401, "未登录")
        return who

    async def read_body(request):
        try:
            return json.loads(await bounded_body(request, 16384), parse_constant=reject_constant)
        except (ValueError, UnicodeError, RecursionError):
            return None

    async def operation(request, who, raw, legacy):
        rid = request.headers.get("x-alcor-request-id") if legacy else raw.get("requestId")
        expected = request.headers.get("x-alcor-assets-revision") if legacy else raw.get("expectedRevision")
        try:
            uid = UUID(rid) if rid is not None else uuid4() if legacy else None
            if uid is None:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(400, "原请求编号无效") from None
        if legacy and expected is None:
            if rid is not None:
                raise HTTPException(400, "请同时提供原请求编号和集合版本")
            async with catalog.context(who) as conn:
                expected = (
                    await (await conn.execute("SELECT revision FROM asset_catalog_scope")).fetchone()
                )["revision"]
        elif (
            (legacy or request.method == "DELETE")
            and isinstance(expected, str)
            and expected.isascii()
            and expected.isdecimal()
            and len(expected) < 17
        ):
            expected = int(expected)
        if type(expected) is not int or not 0 <= expected < 9007199254740991:
            raise HTTPException(400, "集合版本无效")
        return uid, expected

    def first(request, key, default=None):
        return request.query_params.getlist(key)[0] if request.query_params.getlist(key) else default

    async def listing(request, version=None, web=False, deleted=False):
        if version == 2:
            denied = await v2_access(request)
            if denied is not None:
                return denied
        try:
            from .asset_library_access import assert_material_read
            await assert_material_read(request, db)
            kind = first(request, "type")
            if kind == "icon":
                raise HTTPException(400, "素材分类无效")
            if kind not in (*TYPES, "card") or (version is not None and kind not in V1_TYPES):
                kind = None
            if web and kind == "stock" and first(request, "marketAvailability") == "1":
                return result({"markets": await service.stock_markets()})
            if web:
                selected = select_web_keys(
                    kind, first(request, "keys"), first(request, "market"), first(request, "code")
                )
                if selected is not None:
                    return result(await service.web_icons(kind, selected))
            page = web_page_number(first(request, "page")) if web else page_number(first(request, "page"))
            size = (
                web_page_number(first(request, "pageSize"), 10, 100)
                if web
                else page_number(first(request, "pageSize"), 10, 100)
            )
            paged = not web or (bool(first(request, "type")) and first(request, "paged") == "1")
            if web and paged and kind is None:
                kind = first(request, "type")
            value = await service.listing(
                kind=kind,
                q=first(request, "q", "") if not web or paged else "",
                market=first(request, "market", "").upper()
                if web and paged and first(request, "market") not in (None, "", "ALL")
                else None,
                page=page if paged else 1,
                page_size=size if paged else 500,
                clamp=web,
                sort=first(request, "sort", "rank") if web and paged else None,
                direction="asc" if first(request, "dir") == "asc" else "desc",
                deleted=deleted,
            )
            if version == 2 and "authorization" in request.headers:
                denied = await v2_access(request)
                if denied is not None:
                    return denied
            if version:
                return result(
                    value["assets"], version, {key: value[key] for key in ("page", "pageSize", "total")}
                )
            return result({**value, "partial": not paged and value["total"] > 500})
        except HTTPException as exc:
            return error(exc, version)

    async def mutate(request, version=None, legacy=False, aid=None, delete=False):
        try:
            who = await member(request, legacy)
            raw = {} if delete else await read_body(request)
            if delete and not legacy:
                raw = dict(request.query_params)
            if not isinstance(raw, dict):
                raw = {}
            uid, expected = await operation(request, who, raw, legacy)
            if delete:
                target = aid or first(request, "id")
                if not target and not version and legacy:
                    body = await read_body(request)
                    target = js_text(body.get("id")) if isinstance(body, dict) else None
                if not target:
                    raise HTTPException(400, "缺少素材 id")
                receipt = await service.delete(who, uid, expected, target)
                data = {"deleted": True} if version else {"ok": True} if legacy else receipt
            else:
                if legacy:
                    if aid:
                        name = js_text(raw.get("name"))
                        asset = {"id": aid, "name": trim(name)}
                        if not trim(name):
                            raise HTTPException(400, "缺少素材名称")
                    else:
                        allowed = (
                            ("stock", "market", "flag", "crypto", "metal")
                            if version
                            else (
                                "stock",
                                "market",
                                "flag",
                                "crypto",
                                "metal",
                                "broker",
                                "group",
                                "card",
                            )
                        )
                        if raw.get("type") not in allowed:
                            raise HTTPException(
                                400,
                                "type 必须为 stock / market / flag / crypto / metal"
                                if version
                                else "type 必须为 stock / market / flag / broker / crypto / metal / group / card",
                            )
                        kind = raw["type"]
                        market = "GROUP" if kind == "broker" else trim(js_text(raw.get("market")))
                        if kind in ("stock", "market") and not market:
                            raise HTTPException(400, "缺少市场标识")
                        if kind == "stock" and not trim(js_text(raw.get("code"))):
                            raise HTTPException(400, "股票图标需要股票代码")
                        if kind in ("flag", "crypto", "metal", "broker") and not trim(
                            js_text(raw.get("code"))
                        ):
                            raise HTTPException(
                                400,
                                "资产图标需要代码，如 BTC / GOLD"
                                if version
                                else "资产图标需要代码，如 BTC / GOLD / 分组 ID",
                            )
                        if not version and kind == "market" and not trim(js_text(raw.get("url"))):
                            raise HTTPException(400, "缺少图片地址")
                        asset = {
                            "type": kind,
                            "market": market,
                            "code": js_text(raw.get("code")),
                            "name": js_text(raw.get("name")),
                            "url": trim(js_text(raw.get("url"))),
                        }
                        if raw.get("id"):
                            asset["id"] = js_text(raw["id"])
                        if "urlDark" in raw:
                            asset["urlDark"] = js_text(raw["urlDark"])
                else:
                    if (
                        set(raw)
                        != {"requestId", "expectedRevision", "publicMetadataConfirmed", "asset", "restore"}
                        or raw["publicMetadataConfirmed"] is not True
                    ):
                        raise HTTPException(400, "请确认公共素材字段及当前版本")
                    asset = raw["asset"]
                    if aid and (not isinstance(asset, dict) or asset.get("id") != aid):
                        raise HTTPException(400, "素材标识与编辑目标不一致")
                receipt = await service.write(
                    who,
                    uid,
                    expected,
                    asset,
                    rename=bool(aid),
                    restore=raw.get("restore", False) if not legacy else False,
                )
                data = (
                    {"id": aid, "name": receipt["asset"]["name"]}
                    if aid and legacy
                    else receipt["asset"]
                    if version
                    else {"asset": receipt["asset"]}
                    if legacy
                    else receipt
                )
            response = result(data, version)
            response.headers["X-Alcor-Request-Id"] = str(uid)
            response.headers["X-Alcor-Assets-Revision"] = str(receipt["revision"])
            return response
        except HTTPException as exc:
            return error(exc, version)

    @app.get("/api/assets")
    async def web_read(request: Request):
        return await listing(request, web=True)

    @app.post("/api/assets")
    async def web_save(request: Request):
        return await mutate(request, legacy=True)

    @app.delete("/api/assets")
    async def web_delete(request: Request):
        return await mutate(request, legacy=True, delete=True)

    @app.get("/api/v1/assets")
    async def native_v1_read(request: Request):
        return await listing(request, 1)

    @app.get("/api/v2/assets")
    async def native_v2_read(request: Request):
        return await listing(request, 2)

    @app.post("/api/v1/assets")
    async def native_v1_save(request: Request):
        return await mutate(request, 1, True)

    @app.delete("/api/v1/assets")
    async def native_v1_delete(request: Request):
        return await mutate(request, 1, True, delete=True)

    @app.put("/api/v1/assets/{aid}")
    async def native_v1_rename(aid: str, request: Request):
        return await mutate(request, 1, True, aid)

    @app.delete("/api/v1/assets/{aid}")
    async def native_v1_delete_id(aid: str, request: Request):
        return await mutate(request, 1, True, aid, True)

    @app.get("/api/admin/asset-catalog/entries")
    async def canonical_read(request: Request):
        try:
            await member(request, False)
        except HTTPException as exc:
            return error(exc)
        return await listing(request, deleted=first(request, "deleted") == "1")

    @app.post("/api/admin/asset-catalog/entries")
    async def canonical_save(request: Request):
        return await mutate(request)

    @app.put("/api/admin/asset-catalog/entries/{aid:path}")
    async def canonical_rename(aid: str, request: Request):
        return await mutate(request, aid=aid)

    @app.delete("/api/admin/asset-catalog/entries/{aid:path}")
    async def canonical_delete(aid: str, request: Request):
        return await mutate(request, aid=aid, delete=True)

    @app.post("/api/admin/asset-catalog/restore")
    async def canonical_restore(request: Request):
        try:
            who = await member(request, False)
            raw = await read_body(request)
            if not isinstance(raw, dict) or set(raw) != {"requestId", "expectedRevision", "assetId"}:
                raise HTTPException(400, "恢复素材字段无效")
            uid, expected = await operation(request, who, raw, False)
            return result(await service.delete(who, uid, expected, raw['assetId'], restore=True))
        except HTTPException as exc:
            return error(exc)
