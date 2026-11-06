from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict

from .cash_ledger import CashLedger
from .profile_http import bounded_body
from .security import Identity, digest, identity


class CashSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid")
    data: dict
    preview: str


def mount_cash_ledger(app, db, rate_limit=None):
    service = CashLedger(db)
    app.state.cash_ledger = service
    member = Annotated[Identity, Depends(identity)]

    @app.get("/api/cash/accounts/{account_id}", tags=["cash"])
    async def snapshot(account_id: str, who: member):
        return await service.snapshot(who, account_id)

    @app.get("/api/cash/accounts/{account_id}/entries",tags=["cash"])
    async def history(account_id:str,response:Response,who:member,currency:str|None=Query(default=None,min_length=3,max_length=3),limit:int=Query(default=25,ge=1,le=100),offset:int=Query(default=0,ge=0,le=1000000),revision:int|None=Query(default=None,ge=0)):
        from .cash_history import entries
        response.headers['Cache-Control']='no-store'
        return await entries(db,who,account_id,currency=currency,limit=limit,offset=offset,revision=revision)

    @app.post("/api/cash/preview", tags=["cash"])
    async def preview(data: dict, who: member):
        return await service.preview(who, data)

    @app.post("/api/cash/operations", tags=["cash"])
    async def submit(data: CashSubmission, who: member):
        return await service.submit(who, data.data, data.preview)

    @app.get("/api/cash/operations/{request_id}", tags=["cash"])
    async def receipt(request_id: UUID, who: member):
        return await service.receipt(who, request_id)

    @app.post('/api/cash/operations/{request_id}/close',tags=['cash'])
    async def close(request_id:UUID,request:Request,who:member):
        if 'authorization' in request.headers:raise HTTPException(403,'请使用当前网页登录会话')
        if rate_limit is None:raise HTTPException(503,'现金请求关闭尚未配置')
        if not await rate_limit(db,digest('cash-request-close:'+who.id),60,window_seconds=60):raise HTTPException(429,'操作过于频繁')
        if (await bounded_body(request,128)).strip() not in (b'',b'{}'):raise HTTPException(422,'关闭请求字段无效')
        return await service.close(who,request_id)
