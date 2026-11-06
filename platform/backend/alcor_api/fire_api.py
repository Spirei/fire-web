"""One FIRE planning authority with explicit Web/native protocol envelopes."""

import json

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .fire_planning import FirePlanning
from .legacy_identity import assert_native_origin, native_identity
from .profile_http import bounded_body
from .security import identity


def mount_fire_planning(app, settings, db):
    service = FirePlanning(db)
    app.state.fire_planning = service

    def handler(version):
        async def execute(request: Request):
            headers = {"Cache-Control": "private, no-store", "Vary": "Authorization, Cookie"}
            try:
                assert_native_origin(request, settings)
                if request.query_params:
                    raise HTTPException(400, "不支持查询参数")
                if version:
                    who, _ = await native_identity(
                        request, db, "portfolio.write" if request.method == "PUT" else "portfolio.read"
                    )
                else:
                    if "authorization" in request.headers:
                        raise HTTPException(403, "请使用当前网页登录会话")
                    who = await identity(request)
                if request.method == "GET":
                    result = await service.read(who, metadata=version == 0)
                else:

                    def invalid_constant(_):
                        raise ValueError("non-finite JSON")

                    try:
                        body = json.loads(
                            await bounded_body(request, 256 * 1024 + 4096), parse_constant=invalid_constant
                        )
                    except (ValueError, UnicodeError, RecursionError):
                        raise HTTPException(400, "无效的请求体") from None
                    if version == 0 and (
                        not isinstance(body, dict)
                        or "requestId" not in body
                        or "expectedRevision" not in body
                    ):
                        raise HTTPException(400, "请提供操作编号与规划版本")
                    result = await service.save(who, body)
                return JSONResponse(
                    {"code": 0, "message": "ok", "data": result} if version == 2 else result, headers=headers
                )
            except HTTPException as exc:
                if exc.status_code in (401, 403):
                    headers["X-Alcor-Retire-Context"] = "true"
                result = (
                    {"code": exc.status_code * 100 + 1, "message": str(exc.detail)}
                    if version == 2
                    else {"error": str(exc.detail)}
                )
                return JSONResponse(result, status_code=exc.status_code, headers=headers)

        return execute

    for version, path in (
        (0, "/api/fire-settings"),
        (1, "/api/v1/fire-settings"),
        (2, "/api/v2/fire-settings"),
    ):
        endpoint = handler(version)
        for method in ("GET", "PUT"):
            app.add_api_route(
                path, endpoint, methods=[method], operation_id=f"fire_{version}_{method.lower()}"
            )

    @app.get("/api/fire-settings/operations/{request_id}")
    async def receipt(request_id: str, request: Request):
        from uuid import UUID

        assert_native_origin(request, settings)
        if "authorization" in request.headers:
            raise HTTPException(403, "请使用当前网页登录会话")
        try:
            identifier = UUID(request_id)
        except ValueError:
            raise HTTPException(400, "操作编号无效") from None
        return JSONResponse(
            await service.receipt(await identity(request), identifier),
            headers={"Cache-Control": "private, no-store"},
        )
