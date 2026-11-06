"""Card metadata UI endpoints and old Web custom-card adapters over one PG service."""

import json
from uuid import UUID, uuid4

from fastapi import HTTPException, Request, Response

from .card_catalog import CardCatalog
from .card_preferences_protocol import card_member, wire_response
from .profile_http import bounded_body
from .security import digest, identity


def mount_card_catalog(app, settings, db, rate_limit):
    service = CardCatalog(db)
    app.state.card_catalog = service

    async def member(request, admin=False):
        if 'authorization' in request.headers:
            raise HTTPException(403, '请使用当前网页登录会话')
        who = await identity(request)
        if admin and who.role != 'admin':
            raise HTTPException(403, '需要管理员权限')
        return who

    async def body(request, limit=10 * 1024 * 1024):
        try:
            def invalid(_):
                raise ValueError()
            value = json.loads((await bounded_body(request, limit)).decode('utf-8-sig'), parse_constant=invalid)
            if not isinstance(value, (dict, list)):
                raise TypeError()
            return value
        except (TypeError, ValueError, UnicodeError, RecursionError):
            raise HTTPException(400, '无效请求') from None
        except HTTPException as exc:
            if exc.status_code != 413:
                raise
            raise HTTPException(400, '无效请求') from None

    def identifier(raw):
        try:
            return UUID(raw) if raw is not None else uuid4()
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(400, '原请求编号无效') from None

    def revision(raw):
        if raw is None:
            return None
        if not isinstance(raw, str) or not raw.isascii() or not raw.isdecimal() or len(raw) > 16 or int(raw) > 9007199254740991:
            raise HTTPException(400, '集合版本无效')
        return int(raw)

    async def budget(request, who, kind, maximum=60, window=60):
        address = request.client.host if request.client else 'unknown'
        if not await rate_limit(db, digest(kind + ':' + who.id + ':' + address), maximum, window_seconds=window):
            raise HTTPException(429, '操作过于频繁，请稍后再试')

    async def execute(request, kind, legacy=False, operation=None):
        headers = {'Cache-Control': 'no-store, private', 'Vary': 'Cookie, Authorization', 'X-Alcor-Source-Coverage': 'platform-only'}
        try:
            who = await card_member(request, db) if legacy else await member(request, admin=kind in ('preview', 'import', 'admin'))
            if kind in ('read', 'admin'):
                result = await service.snapshot(who)
                return wire_response({'cards': [{key: value for key, value in card.items() if key != 'materialState'} for card in result['customCards']]} if legacy else result, headers)
            if kind == 'receipt':
                return wire_response(await service.receipt(who, identifier(operation)), headers)
            if kind == 'close':
                raw = await body(request, 4096)
                if not isinstance(raw, dict) or set(raw) != {'kind'}:
                    raise HTTPException(400, '原卡面操作类型无效')
                return wire_response(await service.close(who, identifier(operation), raw['kind']), headers)
            if kind in ('preview', 'import'):
                await budget(request, who, 'card-source', 30, 3600)
                raw = await body(request, 12 * 1024 * 1024 + 65536)
                allowed = {'manifestText', 'sourceLabel'} if kind == 'preview' else {'manifestText', 'sourceLabel', 'requestId', 'expectedRevision', 'expectedDigest'}
                if not isinstance(raw, dict) or set(raw) != allowed:
                    raise HTTPException(400, '来源核对字段无效')
                if kind == 'preview':
                    return wire_response(await service.preview(who, raw['manifestText'], raw['sourceLabel']), headers)
                result = await service.import_source(who, raw['manifestText'], raw['sourceLabel'], identifier(raw['requestId']), raw['expectedRevision'], raw['expectedDigest'])
                return wire_response(result, headers)
            await budget(request, who, 'card-custom' if kind == 'create' else 'card-custom-del')
            request_id = identifier(request.headers.get('x-alcor-request-id'))
            expected = revision(request.headers.get('x-alcor-cards-revision'))
            if kind == 'create':
                result = await service.create(who, await body(request), request_id, expected)
            else:
                result = await service.delete(who, request.query_params.get('id', ''), request_id, expected)
            headers['X-Alcor-Request-Id'] = str(request_id)
            headers['X-Alcor-Cards-Revision'] = str(result['preferenceRevision'])
            if 'x-alcor-request-id' not in request.headers:
                headers['X-Alcor-Request-Id-Mode'] = 'generated_legacy' if legacy else 'generated'
            payload = {'card': result['card']} if kind == 'create' else {'ok': True}
            return wire_response(payload if legacy else result, headers)
        except HTTPException as exc:
            if legacy and exc.status_code == 401:
                exc = HTTPException(401, '未登录')
            if exc.status_code in (401, 403):
                headers['X-Alcor-Retire-Context'] = 'true'
            return wire_response({'error': str(exc.detail)} if legacy else {'error': {'code': 'card_catalog_' + str(exc.status_code), 'message': str(exc.detail)}}, headers, status_code=exc.status_code)

    @app.get('/api/cards/custom', tags=['legacy-web-cards'])
    async def old_read(request: Request):
        return await execute(request, 'read', legacy=True)

    @app.post('/api/cards/custom', tags=['legacy-web-cards'])
    async def old_create(request: Request):
        return await execute(request, 'create', legacy=True)

    @app.delete('/api/cards/custom', tags=['legacy-web-cards'])
    async def old_delete(request: Request):
        return await execute(request, 'delete', legacy=True)

    @app.get('/api/cards/custom/operations/{operation}', tags=['cards'])
    async def old_receipt(operation: str, request: Request):
        return await execute(request, 'receipt', legacy=True, operation=operation)

    @app.get('/api/account/card-catalog', tags=['cards'])
    async def read(request: Request):
        return await execute(request, 'read')

    @app.post('/api/account/card-catalog/custom', tags=['cards'])
    async def create(request: Request):
        return await execute(request, 'create')

    @app.delete('/api/account/card-catalog/custom', tags=['cards'])
    async def delete(request: Request):
        return await execute(request, 'delete')

    @app.get('/api/account/card-catalog/operations/{operation}', tags=['cards'])
    async def receipt(operation: str, request: Request):
        return await execute(request, 'receipt', operation=operation)

    @app.get('/api/admin/card-catalog', tags=['cards'])
    async def admin_read(request: Request):
        return await execute(request, 'admin')

    @app.post('/api/admin/card-catalog/preview', tags=['cards'])
    async def preview(request: Request):
        return await execute(request, 'preview')

    @app.post('/api/admin/card-catalog/imports', tags=['cards'])
    async def import_source(request: Request):
        return await execute(request, 'import')

    @app.post('/api/account/card-catalog/operations/{operation}/close', tags=['cards'])
    async def close(operation: str, request: Request):
        return await execute(request, 'close', operation=operation)

    @app.post('/api/cards/custom/operations/{operation}/close', tags=['cards'])
    async def old_close(operation: str, request: Request):
        return await execute(request, 'close', legacy=True, operation=operation)

    @app.get('/api/admin/card-catalog/sources/{source_id}/original', tags=['cards'])
    async def original(source_id: UUID, request: Request):
        raw, sha = await service.original(await member(request, admin=True), source_id)
        return Response(raw, media_type='application/json', headers={'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="card-catalog.json"', 'X-Alcor-Source-SHA256': sha})
