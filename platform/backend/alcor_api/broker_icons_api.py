"""Private Web/native icon transport sharing the broker mutation receipt namespace."""

import json
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import UploadFile

from .broker_icons import BrokerIcons, LIMIT
from .legacy_identity import assert_native_origin, native_identity
from .native_app_auth import CLIENT
from .profile_http import bounded_body
from .security import digest, identity


def discovery(*, native=False):
    root = "/api/client/broker-icons" if native else "/api/account/broker-icons"
    return {"version": 1, "supported": True, "upload_path": root + "/{accountId}",
            "reset_path": root + "/{accountId}", "content_path": root + "/{accountId}/content",
            "operation_path": root + "/operations/{requestId}",
            "close_path": root + "/operations/{requestId}/close",
            "max_bytes": LIMIT, "formats": ["image/png", "image/jpeg", "image/webp"],
            "display_format": "image/png", "max_display_dimension": 512,
            "account_revision_required": True, "original_retained": True,
            "automatic_mutation_replay": False}


def mount_broker_icons(app, rate_limit):
    service = BrokerIcons(app.state.db)
    app.state.broker_icons = service

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError()
            result[key] = value
        return result

    async def member(request):
        if request.query_params:
            raise HTTPException(400, "不支持查询参数")
        if request.url.path.startswith("/api/client/"):
            assert_native_origin(request, app.state.db.settings)
            who, grant = await native_identity(
                request, app.state.db, "portfolio.read" if request.method == "GET" else "portfolio.write"
            )
            if grant["client_id"] != CLIENT:
                raise HTTPException(401, "连接已失效")
        else:
            if "authorization" in request.headers:
                raise HTTPException(403, "请使用当前网页登录会话")
            who = await identity(request)
        if request.method != "GET" and not await rate_limit(
            app.state.db, digest("broker-icon:" + who.id), 30, window_seconds=60
        ):
            raise HTTPException(429, "图标操作过于频繁")
        return who

    async def execute(request, action, account_id=None, request_id=None):
        headers = {"Cache-Control": "private, no-store", "Vary": "Cookie, Authorization",
                   "X-Content-Type-Options": "nosniff"}
        try:
            who = await member(request)
            if action == "content":
                return Response(await service.content(who, account_id), media_type="image/png", headers=headers)
            if action == "receipt":
                result = await service.receipt(who, request_id)
            elif action == "close":
                if (await bounded_body(request, 128)).strip() not in (b"", b"{}"):
                    raise HTTPException(422, "关闭请求字段无效")
                result = await service.close(who, request_id)
            elif action == "upload":
                if request.headers.get("content-type", "").split(";")[0] != "multipart/form-data":
                    raise HTTPException(415, "需要图片表单")
                await bounded_body(request, LIMIT + 16384)
                try:
                    async with request.form(max_files=1, max_fields=2, max_part_size=LIMIT) as form:
                        if set(form) != {"file", "requestId", "revision"} or any(
                            len(form.getlist(k)) != 1 for k in form
                        ):
                            raise HTTPException(422, "图标表单字段无效")
                        file, revision = form["file"], form["revision"]
                        if (not isinstance(file, UploadFile) or not isinstance(revision, str)
                                or not revision.isascii() or not revision.isdecimal() or len(revision) > 16):
                            raise HTTPException(422, "图标或账户版本无效")
                        result = await service.upload(who, account_id, form["requestId"], int(revision),
                                                      await file.read(LIMIT + 1), file.content_type)
                except (ValueError, UnicodeError):
                    raise HTTPException(400, "图片表单无效") from None
            else:
                if request.headers.get("content-type", "").split(";")[0] != "application/json":
                    raise HTTPException(415, "需要JSON请求")
                try:
                    raw = json.loads(await bounded_body(request, 1024), object_pairs_hook=pairs,
                                     parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                except (ValueError, UnicodeError, RecursionError):
                    raise HTTPException(400, "图标请求格式无效") from None
                if not isinstance(raw, dict) or set(raw) != {"requestId", "revision"}:
                    raise HTTPException(422, "图标请求字段无效")
                result = await service.reset(who, account_id, raw["requestId"], raw["revision"])
            return JSONResponse(result, headers=headers)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return JSONResponse({"error": {"code": exc.status_code * 100 + 1, "message": str(exc.detail)}},
                                status_code=exc.status_code, headers=headers)

    @app.get("/api/account/broker-icons/{account_id}/content")
    @app.get("/api/client/broker-icons/{account_id}/content")
    async def content(account_id: str, request: Request):
        return await execute(request, "content", account_id)

    @app.post("/api/account/broker-icons/{account_id}")
    @app.post("/api/client/broker-icons/{account_id}")
    async def upload(account_id: str, request: Request):
        return await execute(request, "upload", account_id)

    @app.delete("/api/account/broker-icons/{account_id}")
    @app.delete("/api/client/broker-icons/{account_id}")
    async def reset(account_id: str, request: Request):
        return await execute(request, "reset", account_id)

    @app.get("/api/account/broker-icons/operations/{request_id}")
    @app.get("/api/client/broker-icons/operations/{request_id}")
    async def receipt(request_id: UUID, request: Request):
        return await execute(request, "receipt", request_id=request_id)

    @app.post("/api/account/broker-icons/operations/{request_id}/close")
    @app.post("/api/client/broker-icons/operations/{request_id}/close")
    async def close(request_id: UUID, request: Request):
        return await execute(request, "close", request_id=request_id)
