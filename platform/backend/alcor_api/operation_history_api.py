"""Current platform session only; no new App token permissions or business writes."""

from typing import Literal

from fastapi import HTTPException, Query, Request
from fastapi.responses import JSONResponse

from .legacy_identity import assert_native_origin
from .legacy_optional_credentials import credentials_present
from .operation_history import OperationHistory
from .security import identity


def mount_operation_history(app, db):
    service = OperationHistory(db)

    @app.get("/api/account/operation-history", tags=["account"])
    async def history(
        request: Request,
        kind: Literal["import", "api", "sync", "backup"],
        limit: int = Query(10, ge=1, le=50),
        offset: int = Query(0, ge=0, le=100000),
    ):
        headers = {"Cache-Control": "private, no-store", "Vary": "Cookie, Authorization, X-CSRF-Token"}
        try:
            credentials_present(request, platform=True)
            assert_native_origin(request, db.settings)
            if "authorization" in request.headers:
                raise HTTPException(403, "请使用当前网页登录会话")
            who = await identity(request)
            if set(request.query_params) - {"kind", "limit", "offset"} or any(
                len(request.query_params.getlist(key)) != 1 for key in request.query_params
            ):
                raise HTTPException(400, "任务记录查询无效")
            return JSONResponse(await service.read(who, kind, limit, offset), headers=headers)
        except HTTPException as exc:
            headers.update(exc.headers or {})
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return JSONResponse({"error": {"code": exc.status_code, "message": str(exc.detail)}},
                                status_code=exc.status_code, headers=headers)
