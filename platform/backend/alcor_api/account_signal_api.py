"""Pure GETs for account change signals and the current owned device's actual credential state."""

import re

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .account_signals import AccountSignals
from .legacy_identity import assert_native_origin, native_identity
from .security import identity


def mount_account_signals(app, settings, db):
    service = AccountSignals(db)
    app.state.account_signals = service

    async def execute(request, *, native, devices):
        headers = {"Cache-Control": "no-store, private", "Vary": "Authorization, Cookie, X-Alcor-Context"}
        try:
            from .legacy_optional_credentials import credentials_present
            credentials_present(request, platform=not native)
            assert_native_origin(request, settings)
            if request.query_params:
                raise HTTPException(400, "不支持查询参数")
            expected = request.headers.get("x-alcor-context")
            if expected is not None and not re.fullmatch(r"[0-9a-f]{64}", expected):
                raise HTTPException(400, "读取上下文无效")
            if native:
                who, _ = await native_identity(request, db, "portfolio.read")
            else:
                if "authorization" in request.headers:
                    raise HTTPException(403, "请使用当前网页登录会话")
                who = await identity(request)
            result = await service.read(who, expected, devices=devices)
            return JSONResponse(result, headers=headers)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return JSONResponse({"error": {"code": exc.status_code, "message": str(exc.detail)}}, status_code=exc.status_code, headers=headers)

    @app.get("/api/account/changes", tags=["account"])
    async def web_changes(request: Request):
        return await execute(request, native=False, devices=False)

    @app.get("/api/client/account/changes", tags=["account"])
    async def native_changes(request: Request):
        return await execute(request, native=True, devices=False)

    @app.get("/api/account/device-state", tags=["account"])
    async def web_device_state(request: Request):
        return await execute(request, native=False, devices=True)

    @app.get("/api/client/device-state", tags=["account"])
    async def native_device_state(request: Request):
        return await execute(request, native=True, devices=True)
