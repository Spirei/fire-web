"""Web/native read transport for one owner-scoped cash overview authority."""

from fastapi import HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from decimal import Decimal

from .cash_overview import CashOverview
from .legacy_identity import assert_native_origin, native_identity
from .native_app_auth import CLIENT
from .security import identity


def mount_cash_overview(app):
    service = CashOverview(app.state.db)
    app.state.cash_overview = service

    @app.get('/api/account/cash-overview')
    @app.get('/api/client/cash-overview')
    async def state(request: Request):
        if request.query_params:
            raise HTTPException(400, '不支持查询参数')
        if request.url.path.startswith('/api/client/'):
            assert_native_origin(request, app.state.db.settings)
            who, grant = await native_identity(request, app.state.db, 'portfolio.read')
            if grant['client_id'] != CLIENT:
                raise HTTPException(401, '连接已失效')
        else:
            if 'authorization' in request.headers:
                raise HTTPException(403, '请使用当前网页登录会话')
            who = await identity(request)
        return JSONResponse(jsonable_encoder(await service.state(who), custom_encoder={Decimal: str}), headers={
            'Cache-Control': 'private, no-store', 'Vary': 'Cookie, Authorization',
        })
