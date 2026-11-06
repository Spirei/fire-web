"""Strict old subscription bodies; receipts/worker intent share the native PG domain."""

import json
from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .fx_provider_parser import unique
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, native_identity, web_identity
from .market_subscription_writes import Subscriptions, subscription_items
from .native_app_auth import CLIENT
from .profile_http import bounded_body
from .security import digest, identity


def mount_market_subscription_writes(app,settings,authority):
    service=Subscriptions(authority);app.state.market_subscriptions=service
    async def execute(request,*,remove=False,legacy=False):
        headers={"Cache-Control":"private, no-store","Vary":"Authorization, Cookie"}
        if legacy:headers["X-Alcor-API-Version"]="2"
        try:
            assert_native_origin(request,settings)
            if legacy or request.headers.get("authorization"):
                who,grant=await native_identity(request,authority.db,"portfolio.write")
                if grant["client_id"]!=CLIENT:raise HTTPException(401,"连接已失效")
            elif request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE):
                who=(await web_identity(request,authority.db))[0]
            else:who=await identity(request)
            try:
                def reject_constant(_):raise ValueError()
                raw=json.loads(await bounded_body(request,65536),object_pairs_hook=unique,parse_constant=reject_constant)
            except (ValueError,UnicodeError,RecursionError):raise HTTPException(400,"请求体不合法") from None
            items=subscription_items(raw,remove=remove)
            if request.url.query:raise HTTPException(400,"不支持的查询参数")
            selected=request.headers.get("x-alcor-market-source")
            request_id=request.headers.get("x-alcor-request-id")
            generated=request_id is None
            if request_id is None:
                if not legacy:raise HTTPException(400,"须提供原请求编号 X-Alcor-Request-Id")
                request_id=str(uuid4());headers["X-Alcor-Request-Id-Mode"]="generated_legacy"
            try:request_id=UUID(request_id);selected=UUID(selected) if selected else None
            except (ValueError,TypeError,AttributeError):raise HTTPException(400,"请求或来源编号无效") from None
            headers["X-Alcor-Request-Id"]=str(request_id)
            if not await app.state.rate_limit(authority.db,digest("market:write:"+who.id),60,window_seconds=60):raise HTTPException(429,"请求过于频繁")
            result,replay=await service.mutate(who,request_id,items,remove=remove,selected=selected,legacy_generated=generated)
            headers["X-Alcor-Operation-Replay"]="true" if replay else "false"
            if "projectionError" in result:
                return JSONResponse({"code":50301,"message":"取消已接受；其余订阅读取暂不可用，请查询原请求回执","data":result} if legacy else result,status_code=503,headers=headers)
            payload={"subscriptions":result["subscriptions"],"requestId":result["requestId"],"receiptId":result["receiptId"],"legacyClientIdempotency":result["legacyClientIdempotency"]}
            return JSONResponse({"code":0,"message":"ok","data":payload} if legacy else result,headers=headers)
        except HTTPException as exc:
            if exc.status_code in (401,403):headers["X-Alcor-Retire-Context"]="true"
            value={"code":50001 if exc.status_code>=500 else exc.status_code*100+1,"message":str(exc.detail)}
            return JSONResponse(value if legacy else {"error":value},status_code=exc.status_code,headers=headers)
    @app.post("/api/v2/quote-subscriptions")
    async def old_subscribe(request:Request):return await execute(request,legacy=True)
    @app.delete("/api/v2/quote-subscriptions")
    async def old_remove(request:Request):return await execute(request,remove=True,legacy=True)
    @app.post("/api/market/subscriptions")
    async def subscribe(request:Request):return await execute(request)
    @app.delete("/api/market/subscriptions")
    async def remove(request:Request):return await execute(request,remove=True)
