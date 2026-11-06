"""Old and new earnings protocols share licensed calendar snapshots; GET never collects."""

import json

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .earnings_calendar import EarningsCalendar
from .earnings_calendar_protocol import Target
from .fx_provider_parser import unique
from .legacy_history_bars import history_member
from .legacy_identity import assert_native_origin
from .legacy_optional_credentials import credentials_present
from .profile_http import bounded_body
from .security import administrator

HEADERS = {'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'}


def mount_earnings_calendar(app, settings, authority, rate_limit):
    targets = []
    for raw in settings.earnings_targets:
        try:
            targets.append(Target(**raw).validate())
        except (ValueError,TypeError):
            continue
    service = EarningsCalendar(authority,targets)
    app.state.earnings_calendar = service

    async def read(request:Request):
        headers = dict(HEADERS)
        versioned = request.url.path.startswith(('/api/v1/','/api/v2/'))
        try:
            assert_native_origin(request,settings)
            ip = request.client.host if request.client else 'unknown'
            if not await rate_limit(authority.db,'earnings:'+ip,60,window_seconds=60) or not await rate_limit(authority.db,'earnings',300,window_seconds=60):
                raise HTTPException(429,'请求过于频繁，请稍后再试')
            allowed = {'market','month','sourceRevision'}
            if set(request.query_params)-allowed or any(len(request.query_params.getlist(key))!=1 for key in request.query_params):
                raise HTTPException(400,'财报日历参数无效')
            market = request.query_params.get('market','US').upper()
            if market not in (('US','CN') if versioned else ('US','CN','HK')):
                raise HTTPException(400,'该市场财报数据源暂未接入')
            version = 2 if request.url.path.startswith('/api/v2/') else 1 if versioned else None
            credentials = credentials_present(request)
            who = await history_member(request,authority.db,version) if credentials or request.url.path == '/api/market/earnings' else None
            if request.url.path != '/api/market/earnings' and 'sourceRevision' not in request.query_params:
                public = getattr(app.state,'public_reference',None)
                if public is None:
                    raise HTTPException(503,'公开日历来源尚未安装')
                value = await public.read('earnings.calendar',{'market':market,**({'month':request.query_params['month']} if 'month' in request.query_params else {})})
            else:
                if who is None:
                    raise HTTPException(401,'本人来源需要当前身份')
                value = await service.read(who,market,request.query_params.get('month'),request.query_params.get('sourceRevision'))
            return JSONResponse({'code':0,'message':'ok','data':value} if versioned else value,headers=headers)
        except (ValueError,TypeError):
            status,message = 400,'month 格式应为 YYYY-MM，来源版本须为有效编号'
        except HTTPException as exc:
            status,message = exc.status_code,str(exc.detail)
            headers.update(exc.headers or {})
        if status in (401,403):
            headers['X-Alcor-Retire-Context']='true'
        error = {'error':{'code':status*100+1,'message':message}} if versioned else {'items':[],'error':message}
        return JSONResponse(error,status_code=status,headers=headers)

    for path in ('/api/market/earnings','/api/earnings','/api/v1/earnings','/api/v2/earnings'):
        app.add_api_route(path,read,methods=['GET'])

    @app.post('/api/market/earnings/collect')
    async def collect(request:Request):
        assert_native_origin(request,settings)
        who = await administrator(request)
        if not await rate_limit(authority.db,'earnings-collect:'+who.id,20,window_seconds=60):
            raise HTTPException(429,'采集请求过于频繁')
        try:
            body = json.loads(await bounded_body(request,8192),object_pairs_hook=unique,
                              parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
            value = await service.collect(who,body)
        except (ValueError,TypeError):
            raise HTTPException(400,'日历采集参数无效') from None
        return JSONResponse({'data':value},headers=HEADERS)

    @app.get('/api/market/earnings/operations/{request_id}')
    async def receipt(request_id:str,request:Request):
        who = await administrator(request)
        try:
            value = await service.receipt(who,request_id)
        except (ValueError,TypeError):
            raise HTTPException(400,'原日历请求编号无效') from None
        return JSONResponse({'data':value},headers=HEADERS)

    @app.get('/api/market/earnings/originals/{page_id}')
    async def original(page_id:str,request:Request):
        who = await history_member(request,authority.db)
        try:
            raw,sha = await service.original(who,page_id)
        except (ValueError,TypeError):
            raise HTTPException(400,'日历原件编号无效') from None
        return Response(raw,media_type='application/octet-stream',headers={**HEADERS,
                        'Content-Disposition':'attachment; filename="earnings-source.bin"',
                        'X-Content-Type-Options':'nosniff','X-Alcor-Source-SHA256':sha})
