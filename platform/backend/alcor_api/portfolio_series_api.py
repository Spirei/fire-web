"""Pure canonical portfolio evidence and native-currency observed period subtotals."""

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .legacy_identity import assert_native_origin, native_identity
from .native_app_auth import CLIENT
from .portfolio_series import PortfolioSeries
from .security import identity


def mount_portfolio_series(app,db,authority):
    service=PortfolioSeries(db,authority)
    app.state.portfolio_series=service

    @app.get('/api/portfolio/series')
    async def series(request:Request):
        headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'}
        try:
            assert_native_origin(request,db.settings)
            if 'authorization' in request.headers:
                who,grant=await native_identity(request,db,'portfolio.read')
                if grant['client_id']!=CLIENT:raise HTTPException(401,'客户端连接已变化')
            else:who=await identity(request)
            allowed={'days','accountKind','brokerAccountId','recordId','sourceRevision','adjust','start','through','before','expectedRevision','orderOffset','orderLimit'}
            params=request.query_params
            if set(params)-allowed or any(len(params.getlist(key))!=1 for key in params):raise HTTPException(400,'期间素材查询参数无效')
            if not await app.state.rate_limit(db,'portfolio-series:'+who.id,40,window_seconds=60):raise HTTPException(429,'请求过于频繁')
            values={}
            for key,target,default in (('days','days',330),('orderOffset','order_offset',0),('orderLimit','order_limit',500)):
                raw=params.get(key,str(default))
                if not raw.isascii() or not raw.isdecimal() or len(raw)>6:raise HTTPException(400,'期间或分页参数无效')
                values[target]=int(raw)
            for key,target in (('accountKind','account_kind'),('brokerAccountId','broker_account_id'),('recordId','record_id'),('sourceRevision','source_revision'),
                               ('expectedRevision','expected_revision'),('adjust','adjust'),('start','start'),('through','through'),('before','before')):
                if key in params:values[target]=params[key]
            return JSONResponse(await service.read(who,**values),headers=headers)
        except HTTPException as exc:
            headers.update(exc.headers or {})
            if exc.status_code in (401,403):headers['X-Alcor-Retire-Context']='true'
            return JSONResponse({'error':{'code':exc.status_code*100+1,'message':str(exc.detail)}},status_code=exc.status_code,headers=headers)
