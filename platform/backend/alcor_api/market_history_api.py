"""No-store canonical chart reads and explicitly requested licensed source originals."""
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .legacy_identity import assert_native_origin, native_identity
from .market_history_service import HistoryService
from .native_app_auth import CLIENT
from .security import identity


def mount_market_history(app, authority):
    service = HistoryService(authority)
    app.state.market_history = service

    async def member(request):
        if 'authorization' in request.headers:
            assert_native_origin(request, authority.db.settings)
            who, grant = await native_identity(request, authority.db, 'portfolio.read')
            if grant['client_id']!=CLIENT:
                raise HTTPException(401, '客户端连接已变化')
            return who
        return await identity(request)

    @app.get('/api/market/history')
    async def history(request: Request):
        headers = {'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'}
        try:
            who = await member(request)
            allowed = {'market','code','frame','adjust','session','instrument','kind','mode','source_revision','start','through','limit','before','expected_revision'}
            if set(request.query_params)-allowed or any(len(request.query_params.getlist(key))!=1 for key in request.query_params):
                raise HTTPException(400, '历史查询参数无效')
            raw = dict(request.query_params)
            market, symbol = raw.pop('market',''), raw.pop('code','')
            if 'limit' in raw:
                if not raw['limit'].isascii() or not raw['limit'].isdecimal() or len(raw['limit'])>5:
                    raise HTTPException(400, '历史读取数量无效')
                raw['limit'] = int(raw['limit'])
            return JSONResponse(await service.read_chart(who,market,symbol,**raw),headers=headers)
        except HTTPException as exc:
            for key,value in (exc.headers or {}).items():
                headers[key]=value
            if exc.status_code in (401,403):
                headers['X-Alcor-Retire-Context']='true'
            return JSONResponse({'error':{'code':exc.status_code*100+1,'message':str(exc.detail)}},status_code=exc.status_code,headers=headers)

    @app.get('/api/market/history/originals/{page_id}')
    async def original(request: Request,page_id:str):
        who = await member(request)
        if set(request.query_params)!={'source_revision'} or len(request.query_params.getlist('source_revision'))!=1:
            raise HTTPException(400, '原件读取须指定唯一来源版本')
        raw,sha,representation = await service.original(who,page_id,request.query_params['source_revision'])
        return Response(raw,media_type='application/octet-stream',headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization',
                        'Content-Disposition':'attachment; filename="market-source.bin"','X-Content-Type-Options':'nosniff',
                        'X-Alcor-Source-SHA256':sha,'X-Alcor-Source-Representation':representation})
