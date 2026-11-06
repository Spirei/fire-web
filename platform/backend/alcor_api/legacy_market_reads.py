"""Old Web pool and native subscription DTOs. GET never schedules or fetches."""

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, native_identity, web_identity
from .market_contract import MARKETS
from .market_pool_reads import PoolReads
from .market_pool_sources import PoolSources
from .native_app_auth import CLIENT
from .security import digest, identity


def mount_legacy_market_reads(app,settings,authority):
    service=PoolReads(authority)
    app.state.market_pool_reads=service
    sources=PoolSources(authority)
    app.state.market_pool_sources=sources
    from .legacy_market_subscription_api import mount_market_subscription_writes
    mount_market_subscription_writes(app,settings,authority)

    async def execute(request,*,pool=False,legacy=False,native=False):
        headers={"Cache-Control":"private, no-store","Vary":"Authorization, Cookie"}
        if native and legacy:headers["X-Alcor-API-Version"]="2"
        try:
            assert_native_origin(request,settings)
            if native:
                who,grant=await native_identity(request,authority.db,"portfolio.read")
                if grant["client_id"]!=CLIENT:raise HTTPException(401,"连接已失效")
            elif legacy:
                if "authorization" in request.headers:raise HTTPException(401,"请使用网页登录会话")
                who=(await web_identity(request,authority.db))[0]
            else:
                if request.headers.get("authorization"):
                    who,_=await native_identity(request,authority.db,"portfolio.read")
                elif request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE):who=(await web_identity(request,authority.db))[0]
                else:who=await identity(request)
            params=request.query_params
            allowed="scope" if pool else "market"
            if set(params)-{allowed} or len(params.getlist(allowed))>1:
                raise HTTPException(400,"查询参数无效" if pool else "不支持的查询参数")
            scope=params.get("scope","mine") if pool else "mine"
            if scope not in ("mine","shared"):raise HTTPException(400,"查询参数无效")
            if scope=="shared" and (who.role!="admin" or getattr(who,"grant_id",None)):
                raise HTTPException(403,"没有访问权限")
            market=params.get("market") if not pool else None
            if market is not None and market not in MARKETS:raise HTTPException(400,"不支持的市场")
            if not await app.state.rate_limit(authority.db,digest(("quote-pool:" if pool else "quote-subscriptions:read:")+who.id),60 if pool else 120,window_seconds=60):raise HTTPException(429,"请求过于频繁")
            result=await sources.read(who,shared=scope=="shared") if pool and not legacy else await service.read(who,market=market,shared=scope=="shared",pool=pool,strict_sources=legacy)
            return JSONResponse({"code":0,"message":"ok","data":result} if legacy else result,headers=headers)
        except HTTPException as exc:
            if exc.status_code in (401,403):headers["X-Alcor-Retire-Context"]="true"
            value={"code":50001 if exc.status_code>=500 else exc.status_code*100+1,"message":str(exc.detail)}
            return JSONResponse(value if legacy else {"error":value},status_code=exc.status_code,headers=headers)

    @app.get("/api/quote-pool")
    async def old_web_pool(request:Request):
        return await execute(request,pool=True,legacy=True)

    @app.get("/api/v2/quote-subscriptions")
    async def old_native_subscriptions(request:Request):
        return await execute(request,legacy=True,native=True)

    @app.get("/api/market/pool")
    async def pool(request:Request):
        return await execute(request,pool=True)

    @app.get("/api/market/subscriptions")
    async def subscriptions(request:Request):
        return await execute(request)
