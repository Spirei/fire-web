"""Legacy profile reads never initiate SEC IO; new management collection is explicit."""

import json

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .fx_provider_parser import unique
from .legacy_history_bars import history_member
from .legacy_identity import assert_native_origin
from .legacy_optional_credentials import credentials_present
from .profile_http import bounded_body
from .sec_company_protocol import Target, ticker
from .sec_company_service import CompanyProfiles
from .security import administrator


def mount_sec_company_profiles(app, settings, authority):
    targets = []
    # Invalid explicit installation disables the source rather than substituting defaults.
    for raw in settings.sec_company_targets:
        try:
            targets.append(Target(**raw).validate())
        except (TypeError, ValueError):
            continue
    service = CompanyProfiles(authority, targets)
    app.state.sec_company_profiles = service

    @app.get('/api/market/company-profiles/originals/{page_id}')
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

    @app.post('/api/market/company-profiles/collect')
    async def collect(request: Request):
        assert_native_origin(request, settings)
        who = await administrator(request)
        raw = await bounded_body(request, 16384)
        try:
            body = json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non_finite")))
            if not isinstance(body, dict) or set(body) != {'requestId', 'sourceRevision', 'code'}:
                raise ValueError('invalid_body')
            result = await service.collect(who, body['requestId'], body['sourceRevision'], body['code'])
        except (ValueError, TypeError, KeyError) as exc:
            raise HTTPException(400, '公司资料采集参数无效') from exc
        return JSONResponse({'data': result}, headers={'Cache-Control': 'no-store, private'})

    @app.post('/api/market/company-profiles/operations/{request_id}/close')
    async def close(request_id: str, request: Request):
        assert_native_origin(request, settings)
        who = await administrator(request)
        try:
            result = await service.close(who, request_id)
        except (TypeError, ValueError) as exc:
            raise HTTPException(400, '原请求编号无效') from exc
        return JSONResponse({'data':result}, headers={'Cache-Control':'no-store, private', 'Vary':'Cookie, Authorization'})

    @app.get('/api/market/company-profiles/operations/{request_id}')
    async def receipt(request_id: str, request: Request):
        who = await administrator(request)
        try:
            result = await service.read(who, request_id=request_id)
        except (ValueError, TypeError) as exc:
            raise HTTPException(400, '原请求编号无效') from exc
        return JSONResponse({'data': result}, headers={'Cache-Control': 'no-store, private'})

    async def profile(request, version):
        headers = {'Cache-Control': 'no-store, private', 'Vary': 'Cookie, Authorization'}
        if version:
            headers['X-Alcor-API-Version'] = str(version)
        try:
            ip = request.client.host if request.client else 'unknown'
            if not await app.state.rate_limit(authority.db, 'company-profile:'+ip, 80, window_seconds=60) or not await app.state.rate_limit(authority.db, 'company-profile', 400, window_seconds=60):
                raise HTTPException(429, '请求过于频繁，请稍后再试')
            if version == 2:
                assert_native_origin(request, settings)
            market = request.query_params.get('market', '').strip().upper()
            code = ticker(request.query_params.get('code', ''))
            if not market:
                raise HTTPException(400, '参数不合法')
            credentials=credentials_present(request)
            who = await history_member(request, authority.db, version) if credentials else None
            if market != 'US':
                data = {'supported': False, 'market': market, 'code': code, 'error': '该市场公司资料正在接入'}
            elif 'sourceRevision' not in request.query_params:
                public=getattr(app.state,'public_reference',None)
                if public is None:raise HTTPException(503,'公开SEC资料独立许可尚未配置')
                data=await public.read('company-profile',{'market':market,'code':code})
            else:
                who=who or await history_member(request,authority.db,version)
                result = await service.read(who, code=code, source_revision=request.query_params.get('sourceRevision'))
                if result['state'] == 'not_found_in_directory':
                    raise HTTPException(404, '未找到公司档案')
                if result['state'] != 'observed':
                    raise HTTPException(503, '公司资料来源尚无完整可用记录')
                data = {**result['profile'], 'migration': {**result['profile']['migration'],
                        'sourceRevision': result['sourceRevision'], 'sourcePageId': result['sourcePageId'],
                        'licenseRevision': result['licenseRevision'], 'captureScope': result['captureScope']}}
            return JSONResponse({'code': 0, 'message': 'ok', 'data': data} if version else data, headers=headers)
        except (ValueError, TypeError):
            exc = HTTPException(400, '参数不合法')
        except HTTPException as error:
            exc = error
        return JSONResponse({'code': exc.status_code*100+1, 'message': exc.detail, 'data': None} if version else {'error': exc.detail},
                            status_code=exc.status_code, headers={**headers, **(exc.headers or {})})

    @app.get('/api/company-profile')
    async def web(request: Request):
        return await profile(request, None)

    @app.get('/api/v1/company-profile')
    async def v1(request: Request):
        return await profile(request, 1)

    @app.get('/api/v2/company-profile')
    async def v2(request: Request):
        return await profile(request, 2)
