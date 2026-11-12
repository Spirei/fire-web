"""Shared discovery source controls plus nine old search/index/ranking methods."""

import json

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .legacy_history_bars import history_member
from .legacy_identity import assert_native_origin
from .legacy_optional_credentials import credentials_present
from .market_discovery_protocol import VERSION, Target, query
from .market_discovery_protocol import digest as fingerprint
from .market_discovery_search import crypto, local, special
from .market_discovery_service import Discovery
from .profile_http import bounded_body
from .security import digest


def mount_market_discovery(app,settings,authority,targets=None,transport=None):
    if targets is None:
        configured=getattr(settings,'market_discovery_targets',[])
        if not isinstance(configured,(list,tuple)) or len(configured)>128:raise ValueError('discovery_targets_invalid')
        targets=tuple(Target(**value).validate() for value in configured)
    service=Discovery(authority,targets,transport)
    app.state.market_discovery=service

    async def member(request,version=None,write=False):
        assert_native_origin(request,settings)
        credentials_present(request)
        who=await history_member(request,authority.db,version)
        if write and getattr(who,'native_client',False):
            from .legacy_identity import native_identity
            who,_=await native_identity(request,authority.db,'portfolio.write')
        return who

    def response(data,request,status=200):
        return JSONResponse(data,status_code=status,headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization',
            **({'X-Alcor-Retire-Context':'true'} if status in (401,403) else {}),
            **({'X-Alcor-API-Version':'2'} if request.url.path.startswith('/api/v2/') else {})})

    async def rate(request,kind,who=None):
        caller=who.id if who else request.client.host if request.client else 'unknown'
        if not await app.state.rate_limit(authority.db,digest('discovery:'+kind+':'+caller),60,window_seconds=60) or not await app.state.rate_limit(authority.db,'discovery-global:'+kind,300,window_seconds=60):raise HTTPException(429,'请求过于频繁，请稍后再试')

    async def read(request,who):
        allowed={'kind','market','q','metric','source_revision','revision','offset','limit'}
        if set(request.query_params)-allowed or any(len(request.query_params.getlist(key))!=1 for key in request.query_params):raise HTTPException(400,'发现查询参数无效')
        raw=dict(request.query_params)
        extras={key:raw.pop(key) for key in ('source_revision','revision','limit','offset') if key in raw}
        for key in ('limit','offset'):
            if key in extras:
                value=extras[key]
                if not value.isascii() or not value.isdecimal() or len(value)>7:raise HTTPException(400,'分页无效')
                extras[key]=int(value)
        normalized=query(raw)
        if normalized['kind']=='search' and not extras.get('source_revision'):
            values=special(normalized['q']) or crypto(normalized['q']) if normalized['q'] else []
            coverage={'scope':'explicit_public_aliases','complete':False,'observedCount':len(values),'providerTotal':None}
            if not values and normalized['q']:
                async with service.context(who) as conn:
                    values,coverage=await local(conn,normalized['q'],authority.db)
            if values or not normalized['q']:
                current=fingerprint({'query':normalized,'items':values,'coverage':coverage})
                if extras.get('revision') and extras['revision']!=current:raise HTTPException(409,'公共目录已变化，请重新读取')
                limit,offset=extras.get('limit',100),extras.get('offset',0)
                if not 1<=limit<=100 or not 0<=offset<=1000000 or offset and not extras.get('revision'):raise HTTPException(400,'发现分页或版本无效')
                return {'query':normalized,'state':'observed','revision':current,'source':'confirmed_public_metadata','sourceRevision':None,
                    'licenseRevision':None,'observedAt':None,'coverage':{**coverage,'observedCount':len(values)},'items':values[offset:offset+limit],
                    'groups':None,'pagination':{'offset':offset,'limit':limit,'total':len(values),'hasMore':offset+limit<len(values)},
                    'originals':[],'automaticCollection':False,'pricesKnown':False}
        return await service.read(who,normalized,**extras)

    @app.get('/api/market/discovery')
    async def state(request:Request):
        try:
            who=await member(request);await rate(request,'read',who)
            return response(await read(request,who),request)
        except HTTPException as exc:return response({'error':{'code':exc.status_code*100+1,'message':str(exc.detail)}},request,exc.status_code)

    @app.post('/api/market/discovery/collect')
    async def collect(request:Request):
        try:
            if request.query_params:raise HTTPException(400,'不支持查询参数')
            who=await member(request,write=True);await rate(request,'collect',who)
            from .fx_provider_parser import unique
            try:body=json.loads(await bounded_body(request,8192),object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(ValueError()))
            except (ValueError,UnicodeError,RecursionError):raise HTTPException(400,'采集请求无效') from None
            return response(await service.collect(who,body),request)
        except HTTPException as exc:return response({'error':{'code':exc.status_code*100+1,'message':str(exc.detail)}},request,exc.status_code)

    @app.get('/api/market/discovery/operations/{request_id}')
    async def receipt(request:Request,request_id:str):
        if request.query_params:raise HTTPException(400,'不支持查询参数')
        return response(await service.receipt(await member(request),request_id),request)

    @app.get('/api/market/discovery/originals/{page_id}')
    async def original(request:Request,page_id:str):
        if set(request.query_params)!={'source_revision'} or len(request.query_params.getlist('source_revision'))!=1:raise HTTPException(400,'原件需要唯一来源版本')
        raw,sha=await service.original(await member(request),page_id,request.query_params['source_revision'])
        return Response(raw,media_type='application/octet-stream',headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization',
            'Content-Disposition':'attachment; filename="market-discovery.bin"','X-Content-Type-Options':'nosniff','X-Alcor-Source-SHA256':sha})

    @app.get('/api/market/discovery/capabilities')
    async def capabilities(request:Request):
        await member(request)
        return response({'sourceVersion':VERSION,'purposes':['discovery.search','discovery.indices','discovery.top','discovery.ranking.volume','discovery.ranking.amount'],
            'automaticCollection':False,'readPath':'/api/market/discovery','collectPath':'/api/market/discovery/collect','receiptPath':'/api/market/discovery/operations/{requestId}'},request)

    @app.post('/api/v1/indices/prepare')
    @app.post('/api/v2/indices/prepare')
    async def prepare_indices(request:Request):
        from uuid import UUID
        from .legacy_identity import body
        from .market_index_reads import items
        from .market_subscription_writes import Subscriptions
        version=2 if request.url.path.startswith('/api/v2/') else 1
        who=await member(request,version,write=True)
        await rate(request,'indices.prepare',who)
        raw=await body(request,('requestId',))
        if set(raw)!={'requestId'}:raise HTTPException(400,'指数需求字段无效')
        try:rid=UUID(str(raw['requestId']))
        except (ValueError,TypeError):raise HTTPException(400,'请求编号无效') from None
        values=[{'market':item['market'],'code':item['code']} for item in items()]
        result,_=await Subscriptions(authority).mutate(who,rid,values,observe=True,source_preference='auto',instrument='index')
        return response({'code':0,'message':'ok','data':result},request)

    async def legacy(request,kind,version=None):
        try:
            assert_native_origin(request,settings)
            credentials = credentials_present(request)
            who = await member(request,version) if credentials else None
            if kind=='indices' and version is None and who is None:
                raise HTTPException(401,'未登录')
            await rate(request,kind)
            raw={'kind':kind}
            if kind=='search':raw['q']=request.query_params.get('q','')
            elif kind=='top':raw['market']=request.query_params.get('market','US').upper()
            elif kind=='ranking':raw.update(market=request.query_params.get('market'),metric=request.query_params.get('metric','volume'))
            value=query(raw)
            if kind=='search' and not value['q']:return response({'code':0,'message':'ok','data':{'results':[]}} if version else {'results':[]},request)
            if kind=='search':
                static=special(value['q']) or crypto(value['q']) if version is None else []
                if static:return response({'results':static,'coverage':{'scope':'explicit_public_aliases','complete':False}},request)
                async with authority.db.connection() as conn,conn.transaction():
                    local_rows,coverage=await local(conn,value['q'],authority.db)
                if local_rows:
                    data={'results':local_rows,'coverage':coverage}
                    return response({'code':0,'message':'ok','data':data} if version else data,request)
            if kind=='indices' and who is not None and 'x-alcor-market-source' not in request.headers:
                from .market_index_reads import installed,read as index_quotes
                if await installed(authority,who):
                    data=await index_quotes(authority,who)
                    return response({'code':0,'message':'ok','data':data} if version else data,request)
            if 'x-alcor-market-source' not in request.headers:
                public = getattr(app.state,'public_discovery',None)
                if public is None:
                    raise HTTPException(503,'公共发现再分发许可尚未配置')
                selectors = {'source_revision':request.headers['x-alcor-market-source']} if 'x-alcor-market-source' in request.headers else {}
                observed = await public.read(value,**selectors)
            else:
                if who is None:raise HTTPException(400,'本人发现来源需要有效登录')
                observed=await service.read(who,value,source_revision=request.headers.get('x-alcor-market-source'))
            if observed['state']!='observed':
                raise HTTPException(503,'尚无本人已许可的该范围真实来源快照，请显式采集')
            if kind=='ranking' and not observed['coverage']['complete']:raise HTTPException(503,'尚未核实完整市场的真实前十，不以局部观察替代排行')
            if kind=='search':data={'results':observed['items'],'coverage':observed['coverage']}
            elif kind=='indices':data={'groups':observed['groups'],'coverage':observed['coverage']}
            else:data={'market':value['market'],'items':observed['items'],'updatedAt':observed['updatedAt'],'coverage':observed['coverage'],
                **({'metric':value['metric'],'tradeDate':observed.get('tradeDate'),**({'currency':observed.get('currency')} if value['metric']=='amount' else {})} if kind=='ranking' else {})}
            return response({'code':0,'message':'ok','data':data} if version else data,request)
        except HTTPException as exc:
            status=exc.status_code
            data={'code':50002 if status>=500 else status*100+1,'message':str(exc.detail)} if version else {'error':str(exc.detail),**({'items':[]} if kind=='top' else {})}
            return response(data,request,status)

    for version in (None,1,2):
        for kind,path in (('search','search'),('indices','indices')):
            def endpoint(selected_kind,selected_version):
                async def handler(request:Request):return await legacy(request,selected_kind,selected_version)
                return handler
            app.add_api_route('/api/'+(f'v{version}/' if version else '')+path,endpoint(kind,version),methods=['GET'],operation_id=f'legacy_discovery_{version or "web"}_{kind}')
    @app.get('/api/top-stocks')
    async def top(request:Request):return await legacy(request,'top')
    @app.get('/api/v1/market-ranking')
    async def ranking_v1(request:Request):return await legacy(request,'ranking',1)
    @app.get('/api/v2/market-ranking')
    async def ranking_v2(request:Request):return await legacy(request,'ranking',2)
    return service
