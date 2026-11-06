"""Financial statements: explicit management acquisition, licensed PG-only reads."""

import json

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .fx_provider_parser import unique
from .legacy_history_bars import history_member
from .legacy_identity import assert_native_origin
from .legacy_optional_credentials import credentials_present
from .profile_http import bounded_body
from .sec_financial_protocol import FinancialTarget, code
from .sec_financial_service import FinancialStatements
from .security import administrator

HEADERS = {'Cache-Control': 'no-store, private', 'Vary': 'Cookie, Authorization'}


def mount_sec_financial_statements(app, settings, authority):
    targets = []
    for raw in settings.sec_financial_targets:
        try:
            targets.append(FinancialTarget(**raw).validate())
        except (TypeError, ValueError):
            continue
    service = FinancialStatements(authority, targets)
    app.state.sec_financial_statements = service

    @app.get('/api/market/financial-statements/originals/{page_id}')
    async def original(page_id: str, request: Request):
        who = await history_member(request, authority.db)
        try:
            raw, checksum, representation = await service.original(who, page_id)
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, '来源原件编号无效') from exc
        return Response(raw, media_type='application/octet-stream', headers={
            'Cache-Control': 'no-store, private', 'Vary': 'Cookie, Authorization',
            'X-Content-Type-Options': 'nosniff', 'X-Alcor-Source-SHA256': checksum,
            'X-Alcor-Source-Representation': representation,
            'Content-Disposition': 'attachment; filename="sec-source.json"'})

    @app.post('/api/market/financial-statements/collect')
    async def collect(request: Request):
        assert_native_origin(request, settings)
        who = await administrator(request)
        raw = await bounded_body(request, 16384)
        try:
            body = json.loads(raw, object_pairs_hook=unique,
                              parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
            if not isinstance(body, dict) or set(body) != {'requestId', 'sourceRevision', 'code'}:
                raise ValueError('body')
            result = await service.collect(who, body['requestId'], body['sourceRevision'], body['code'])
        except (TypeError, ValueError, KeyError) as exc:
            raise HTTPException(400, '财务报表采集参数无效') from exc
        return JSONResponse({'data': result}, headers=HEADERS)

    @app.post('/api/market/financial-statements/operations/{request_id}/close')
    async def close(request_id: str, request: Request):
        assert_native_origin(request, settings)
        who = await administrator(request)
        try:
            result = await service.close(who, request_id)
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, '原请求编号无效') from exc
        return JSONResponse({'data':result}, headers={'Cache-Control':'no-store, private', 'Vary':'Cookie, Authorization'})

    @app.get('/api/market/financial-statements/operations/{request_id}')
    async def receipt(request_id: str, request: Request):
        who = await administrator(request)
        try:
            result = await service.read(who, request_id=request_id)
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, '原请求编号无效') from exc
        return JSONResponse({'data': result}, headers=HEADERS)

    @app.get('/api/financials')
    async def financials(request: Request):
        try:
            ip = request.client.host if request.client else 'unknown'
            if not await app.state.rate_limit(authority.db, 'financials:'+ip, 60, window_seconds=60) or not await app.state.rate_limit(authority.db, 'financials', 300, window_seconds=60):
                raise HTTPException(429, '请求过于频繁，请稍后再试')
            market = request.query_params.get('market', '').upper()
            raw_code = request.query_params.get('code', '').upper()
            credentials=credentials_present(request)
            who = await history_member(request, authority.db) if credentials else None
            if market != 'US':
                return JSONResponse({'market': market, 'code': raw_code, 'supported': False,
                                     'error': '当前首版仅支持美股 SEC 财报数据'}, headers=HEADERS)
            symbol = code(raw_code)
            if 'sourceRevision' not in request.query_params:
                public=getattr(app.state,'public_reference',None)
                if public is None:raise HTTPException(503,'公开SEC财务资料独立许可尚未配置')
                return JSONResponse(await public.read('financials',{'market':market,'code':symbol}),headers=HEADERS)
            who=who or await history_member(request,authority.db)
            result = await service.read(who, code=symbol, source_revision=request.query_params.get('sourceRevision'))
            if result['state'] == 'not_found_in_directory':
                raise HTTPException(404, '未找到 SEC 公司档案')
            if result['state'] != 'observed':
                raise HTTPException(503, '财务报表来源尚无完整可用记录')
            data = result['profile']
            return JSONResponse({**data, 'migration': {**data['migration'],
                'sourceRevision': result['sourceRevision'], 'sourcePageId': result['sourcePageId'],
                'licenseRevision': result['licenseRevision'], 'captureScope': result['captureScope']}}, headers=HEADERS)
        except (TypeError, ValueError):
            return JSONResponse({'error': '股票代码不合法'}, status_code=400, headers=HEADERS)
        except HTTPException as exc:
            return JSONResponse({'error': exc.detail}, status_code=exc.status_code, headers={**HEADERS, **(exc.headers or {})})
