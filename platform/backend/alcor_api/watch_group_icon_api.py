"""Private owner icon upload/reads; legacy envelopes share the same domain service."""

import re
from uuid import UUID, uuid4

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

from .legacy_identity import (
    OLD_COOKIE,
    WEB_COOKIE,
    assert_native_origin,
    envelope,
    native_identity,
    web_identity,
)
from .legacy_portfolio import portfolio_member
from .legacy_watchlists import legacy_group
from .profile_http import bounded_body
from .security import COOKIE, digest, identity
from .system_asset_api import content
from .watch_group_icons import LIMIT, WatchGroupIcons


def mount_watch_group_icons(app, settings, db, rate_limit):
    service = WatchGroupIcons(db)
    app.state.watch_group_icons = service

    async def member(request, write=False, legacy=False):
        if legacy:
            return await portfolio_member(request, settings, db, write=write)
        assert_native_origin(request, settings)
        if "authorization" in request.headers:
            from .legacy_optional_credentials import credentials_present

            credentials_present(request)
        if "authorization" in request.headers:
            who, grant = await native_identity(request, db, "portfolio.write" if write else "portfolio.read")
            from .native_app_auth import CLIENT

            if grant["client_id"] != CLIENT:
                raise HTTPException(401, "连接已失效，请重新连接")
            return who
        if COOKIE in request.cookies:
            return await identity(request)
        if request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE):
            return (await web_identity(request, db))[0]
        return await identity(request)

    async def upload(request, group_id, response, legacy=False):
        who = await member(request, True, legacy)
        if legacy:
            group_id = await service.groups.resolve_legacy_id(who.id, group_id)
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        for key, maximum in ((digest("group-icon:" + who.id), 30), ("group-icon", 300)):
            if not await rate_limit(db, key, maximum, window_seconds=3600):
                raise HTTPException(429, "上传过于频繁")
        async with app.state.resource_library.upload_slot():
            await bounded_body(request, LIMIT + 65536)
            form = await request.form(max_files=1, max_fields=4)
            try:
                if any(len(form.getlist(k)) != 1 for k in form) or set(form) - {
                    "file",
                    "requestId",
                    "expectedRevision",
                }:
                    raise HTTPException(400, "上传表单无效")
                file = form.get("file")
                if not isinstance(file, UploadFile):
                    raise HTTPException(400, "请选择要上传的文件")
                supplied = form.get("requestId") or request.headers.get("x-alcor-request-id")
                if not legacy and (not form.get("requestId") or form.get("expectedRevision") is None):
                    raise HTTPException(400, "需要原UUID和当前分组修订")
                if (
                    form.get("requestId")
                    and request.headers.get("x-alcor-request-id")
                    and form["requestId"] != request.headers["x-alcor-request-id"]
                ):
                    raise HTTPException(400, "原UUID字段不一致")
                try:
                    rid = str(UUID(supplied)) if supplied else str(uuid4())
                except (ValueError, TypeError, AttributeError):
                    raise HTTPException(400, "原操作UUID无效") from None
                expected = form.get("expectedRevision")
                if expected is not None:
                    if (
                        not isinstance(expected, str)
                        or not expected.isascii()
                        or not expected.isdecimal()
                        or len(expected) > 16
                    ):
                        raise HTTPException(400, "分组修订无效")
                    expected = int(expected)
                value = await service.upload(
                    who,
                    group_id,
                    rid,
                    expected,
                    file.filename or "",
                    await file.read(LIMIT + 1),
                    canonical=not legacy or expected is not None,
                )
                headers = {
                    "Cache-Control": "private, no-store",
                    "X-Alcor-Request-Id": rid,
                    "X-Alcor-Revision": str(value["revision"]),
                }
                if legacy:
                    if supplied is None:
                        headers["X-Alcor-Request-Id-Mode"] = "generated_legacy"
                    if value["state"] == "failed":
                        headers["X-Alcor-API-Version"] = request.scope["path"].split("/")[2][1:]
                        return JSONResponse(
                            {"code": value["httpStatus"] * 100 + 1, "message": value["message"]},
                            status_code=value["httpStatus"],
                            headers=headers,
                        )
                    response.headers.update(headers)
                    return envelope({"group": legacy_group(value["group"])}, request, response)
                return JSONResponse(value, status_code=value["httpStatus"], headers=headers)
            finally:
                await form.close()

    @app.get("/api/watch-groups/{group_id}/icon", tags=["watchlists"])
    async def current(group_id: str, request: Request):
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        return await service.current(await member(request), group_id)

    @app.post("/api/watch-groups/{group_id}/icon", tags=["watchlists"])
    async def canonical_upload(group_id: str, request: Request, response: Response):
        return await upload(request, group_id, response)

    async def legacy_upload(group_id: str, request: Request, response: Response):
        try:
            return await upload(request, group_id, response, True)
        except StarletteHTTPException as error:
            return JSONResponse(
                {
                    "code": getattr(error, "business_code", error.status_code * 100 + 1),
                    "message": str(error.detail),
                },
                status_code=error.status_code,
                headers={
                    "Cache-Control": "no-store",
                    **({"X-Alcor-Retire-Context": "true"} if error.status_code in (401, 403) else {}),
                    "X-Alcor-API-Version": str(request.scope["path"].split("/")[2][1:]),
                },
            )

    for version in (1, 2):
        app.add_api_route(
            f"/api/v{version}/watch-groups/{{group_id}}/icon",
            legacy_upload,
            methods=["POST"],
            operation_id=f"legacy_watch_group_icon_v{version}",
            tags=["legacy-native-watchlists"],
        )

    @app.get("/api/watch-groups/{group_id}/icons", tags=["watchlists"])
    async def history(group_id: str, request: Request):
        if set(request.query_params) - {"after", "limit"} or any(
            len(request.query_params.getlist(k)) != 1 for k in request.query_params
        ):
            raise HTTPException(400, "图标版本查询字段无效")
        try:
            limit = int(request.query_params.get("limit", "50"))
        except ValueError as exc:
            raise HTTPException(400, "图标版本分页上限无效") from exc
        return JSONResponse(
            await service.history(
                await member(request), group_id, after=request.query_params.get("after"), limit=limit
            ),
            headers={"Cache-Control": "private, no-store"},
        )

    @app.get("/api/watch-groups/{group_id}/icons/{identifier}/content", tags=["watchlists"])
    async def served(group_id: str, identifier: UUID, request: Request):
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        row, stream = await service.version(await member(request), group_id, identifier)
        response = content(request, row, stream, private=False)
        response.headers["Cache-Control"] = "private, no-store"
        return response

    @app.get("/api/watch-groups/{group_id}/icons/{identifier}/original", tags=["watchlists"])
    async def original(group_id: str, identifier: UUID, request: Request):
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        row, stream = await service.version(await member(request), group_id, identifier, original=True)
        response = content(request, row, stream, private=True)
        response.headers["Content-Type"] = "application/octet-stream"
        return response

    @app.get("/uploads/asset/group/{owner}/{group_id}/{filename}", tags=["watchlists"])
    async def legacy_image(owner: str, group_id: str, filename: str, request: Request):
        query = request.query_params
        if query and (
            set(query) != {"sha256"}
            or len(query.getlist("sha256")) != 1
            or not re.fullmatch("[a-f0-9]{64}", query.get("sha256", ""))
        ):
            raise HTTPException(400, "图标摘要字段无效")
        if re.search(b"%2f|%5c|%00", request.scope.get("raw_path", b""), re.IGNORECASE):
            raise HTTPException(400, "图标路径无效")
        who = await member(request)
        if owner != who.id:
            raise HTTPException(404, "本人图标不存在")
        row, stream = await service.legacy(
            who, "/uploads/asset/group/" + owner + "/" + group_id + "/" + filename, query.get("sha256")
        )
        response = content(request, row, stream, private=False)
        response.headers["Cache-Control"] = "private, no-store"
        return response
