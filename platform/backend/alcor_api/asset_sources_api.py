"""Explicit public asset source tasks over the existing catalogue authority."""

import json
import re
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .asset_sources import AssetSources, fingerprint
from .feed_api import operation_id
from .fx_provider_parser import unique
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, web_identity
from .profile_http import bounded_body
from .security import COOKIE, digest, identity


class AssetSourceTransport:
    def __init__(self, db):
        self.db, self.service = db, AssetSources(db)

    async def actor(self, request, *, legacy_bearer=False):
        assert_native_origin(request, self.db.settings)
        if 'authorization' in request.headers:
            if not legacy_bearer:raise HTTPException(401,'请使用网页会话')
            if not re.fullmatch(r'Bearer [A-Za-z0-9_-]{64}',request.headers['authorization']):raise HTTPException(401,'请使用有效旧网页会话')
            who=(await web_identity(request,self.db,allow_legacy_bearer=True,web_bearer_only=True))[0]
            return who,True
        legacy = not request.headers.get('x-csrf-token') and bool(
            request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE)
        )
        who = (await web_identity(request, self.db))[0] if legacy else await identity(request)
        return who, legacy

    async def body(self, request):
        try:
            raw = json.loads(
                await bounded_body(request, 65536), object_pairs_hook=unique,
                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
            )
            if not isinstance(raw, dict):
                raise TypeError()
            return raw
        except (ValueError,TypeError, UnicodeError, RecursionError):
            raise HTTPException(400, '素材来源请求无效') from None

    async def execute(self, request, action, identifier=None, old=False):
        headers = {'Cache-Control': 'private, no-store', 'Vary': 'Cookie, Authorization'}
        try:
            if old and action == 'search':
                ip = request.client.host if request.client else 'unknown'
                if not await request.app.state.read_rate_limit(self.db, digest('asset-source-search:' + ip), 60, window_seconds=60) or not await request.app.state.read_rate_limit(self.db, 'asset-source-search-global', 300, window_seconds=60):
                    raise HTTPException(429, '搜索请求过于频繁')
            if old and request.method=='GET' and action in ('search','status'):
                supplied='authorization' in request.headers or any(key in request.cookies for key in (COOKIE,WEB_COOKIE,OLD_COOKIE))
                if supplied:await self.actor(request,legacy_bearer=True)
                if any(len(request.query_params.getlist(key))!=1 for key in request.query_params):raise HTTPException(400,'查询参数重复')
                if action=='status':
                    value=await self.service.public_status()
                    return JSONResponse({'status':value['status']},headers=headers)
                kind=request.query_params.get('type','').strip();query=request.query_params.get('q','').strip()
                if not query or kind not in ('crypto','metal'):
                    return JSONResponse({'candidates':[]},headers=headers)
                value=await self.service.public_search({'type':kind,'q':query})
                headers.update({'X-Alcor-Asset-Collection-On-Read':'false','X-Alcor-Asset-Search-Method':'POST','Link':'</api/asset-sources/search>; rel="search"'})
                if value['state']!='observed':
                    return JSONResponse({'error':'获取行情源失败，请稍后重试'},status_code=502,headers={**headers,'X-Alcor-Asset-Search-State':'explicit_post_required'})
                return JSONResponse({'candidates':[{key:item[key] for key in ('code','name','market','iconUrl') if key in item} for item in value['candidates']]},headers=headers)
            who, legacy = await self.actor(request,legacy_bearer=old)
            if action not in {'add', 'targets', 'search', 'status', 'operation', 'original'} and who.role != 'admin':
                raise HTTPException(403, '需要管理员权限')
            params = request.query_params
            if any(len(params.getlist(k)) != 1 for k in params):
                raise HTTPException(400, '查询参数重复')
            if action == 'targets':
                result = await self.service.targets(who)
            elif action == 'status':
                result = await self.service.status(who)
            elif action == 'operation':
                result = await self.service.operation(who, str(UUID(identifier)))
            elif action == 'original':
                row, raw = await self.service.original(who, str(UUID(identifier)))
                return Response(raw, media_type='application/octet-stream', headers={
                    **headers, 'Content-Disposition': 'attachment; filename="asset-source-original.bin"',
                    'X-Content-Type-Options': 'nosniff', 'X-Content-SHA256': row['raw_sha256'],
                })
            else:
                raw = dict(params) if request.method == 'GET' else await self.body(request)
                rid, tracked = operation_id(request, raw, legacy=legacy and old)
                legacy_hash=fingerprint({'path':request.url.path,'method':request.method,'body':raw,'targetHeader':request.headers.get('x-alcor-asset-target'),'revisionHeader':request.headers.get('x-alcor-assets-revision')}) if old else None
                if old:
                    target = raw.pop('targetId', request.headers.get('x-alcor-asset-target'))
                    revision = raw.pop('expectedRevision', None)
                    if revision is None:
                        header = request.headers.get('x-alcor-assets-revision')
                        if header is not None:
                            if not header.isascii() or not header.isdecimal() or len(header) > 16:
                                raise HTTPException(400, '公共素材版本无效')
                            revision = int(header)
                    if revision is None and action != 'search':
                        revision = (await self.service.status(who))['revision']
                    if action == 'search':
                        raw = {'requestId': rid, 'targetId': target, 'type': raw.get('type'),
                               'query': raw.get('query', raw.get('q', ''))}
                        if revision is not None:
                            raw['expectedRevision'] = revision
                    else:
                        selection = raw.pop('selection', raw)
                        options = raw.pop('options', {}) if selection is not raw else selection.pop('options', {})
                        if 'onlyIfMissing' in selection:
                            options = {**options, 'onlyIfMissing': selection.pop('onlyIfMissing')}
                        if (action=='cleanup' or action=='sync' and selection.get('mode')=='icons') and target is None:
                            target='local-catalogue'
                        if action=='sync' and 'mode' in selection:
                            options={**options,'mode':selection.pop('mode')}
                        raw = {'requestId': rid, 'action': action, 'targetId': target,
                               'selection': selection, 'options': options, 'expectedRevision': revision}
                else:
                    raw['requestId'] = rid
                if action == 'search':
                    result = await self.service.search(who, raw)
                else:
                    if not old and action != 'submit':
                        raw['action'] = action
                    result = await self.service.submit_legacy(who,raw,legacy_hash) if old else await self.service.submit(who,raw)
                headers['X-Alcor-Request-Id'] = rid
                headers['X-Alcor-Legacy-Client-Idempotency'] = 'true' if tracked else 'false'
                if old and action=='sync':
                    mode=raw.get('options',{}).get('mode')
                    return JSONResponse({'ok':True,'message':'图标补全已开始' if mode=='icons' else '股票同步已开始'},headers={**headers,'X-Alcor-Operation-State':result.get('state','unknown')})
            pending = isinstance(result, dict) and result.get('state') in ('queued', 'running', 'pending')
            return JSONResponse(result, status_code=202 if pending else 200, headers=headers)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                headers['X-Alcor-Retire-Context'] = 'true'
            return JSONResponse({'error': str(exc.detail), 'message': str(exc.detail),
                                 'code': exc.status_code * 100 + 1}, status_code=exc.status_code, headers=headers)
        except (ValueError, TypeError, AttributeError):
            return JSONResponse({'error': '请求参数或原UUID无效'}, status_code=400, headers=headers)


def mount_asset_sources(app, db):
    transport = AssetSourceTransport(db)
    app.state.asset_sources = transport.service

    def static(path, method, action, old=False):
        async def endpoint(request: Request):
            return await transport.execute(request, action, old=old)
        app.add_api_route(path, endpoint, methods=[method], operation_id='asset_source_' + action + '_' + method.lower() + ('_legacy' if old else ''))

    for suffix, method, action in (
        ('targets', 'GET', 'targets'), ('status', 'GET', 'status'),
        ('search', 'POST', 'search'), ('operations', 'POST', 'submit'),
    ):
        static('/api/asset-sources/' + suffix, method, action)

    @app.get('/api/asset-sources/operations/{request_id}')
    async def operation(request_id: str, request: Request):
        return await transport.execute(request, 'operation', request_id)

    @app.get('/api/asset-sources/originals/{page_id}')
    async def original(page_id: str, request: Request):
        return await transport.execute(request, 'original', page_id)

    for suffix, method, action in (
        ('search', 'GET', 'search'), ('add-by-search', 'POST', 'add'),
        ('sync', 'GET', 'status'), ('sync', 'POST', 'sync'),
        ('backfill', 'POST', 'backfill'), ('check-delisted', 'POST', 'check-delisted'),
        ('cleanup', 'POST', 'cleanup'),
    ):
        static('/api/assets/' + suffix, method, action, old=True)
