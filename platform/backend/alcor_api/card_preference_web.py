"""New Web controls reuse the owned non-financial card preference authority."""

import json
from uuid import UUID

from fastapi import HTTPException, Request

from .card_preferences import card_key, card_tags
from .card_preferences_protocol import wire_response
from .profile_http import bounded_body
from .security import digest, identity


def mount_card_preference_web(app, db):
    service = app.state.card_preferences

    async def member(request):
        if 'authorization' in request.headers:
            raise HTTPException(403, '请使用当前网页登录会话')
        return await identity(request)

    async def budget(request, who):
        address = request.client.host if request.client else 'unknown'
        if not await app.state.rate_limit(db, digest('card-preference-web:' + who.id + ':' + address), 120, window_seconds=60):
            raise HTTPException(429, '操作过于频繁，请稍后再试')

    @app.get('/api/account/card-preferences', tags=['cards'])
    async def read(request: Request):
        return await service.read(await member(request))

    @app.put('/api/account/card-preferences', tags=['cards'])
    async def save(request: Request):
        who = await member(request)

        def reject_constant(_):
            raise ValueError()

        try:
            raw = json.loads(await bounded_body(request, 16384), parse_constant=reject_constant)
        except (ValueError, UnicodeError, RecursionError):
            raise HTTPException(400, '卡包偏好格式无效') from None
        if not isinstance(raw, dict) or set(raw) != {'requestId', 'expectedRevision', 'kind', 'cardKey', 'value'}:
            raise HTTPException(400, '卡包偏好字段无效')
        try:
            identifier = UUID(raw['requestId'])
            if str(identifier) != raw['requestId']:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(400, '原请求编号无效') from None
        expected, kind = raw['expectedRevision'], raw['kind']
        if type(expected) is not int or not 0 <= expected < 9007199254740991:
            raise HTTPException(400, '集合版本无效')
        if not isinstance(raw['cardKey'], str) or kind not in ('tags', 'holdings'):
            raise HTTPException(400, '卡包偏好字段无效')
        key = card_key(raw['cardKey'])
        if kind == 'tags':
            value = card_tags(raw['value'])
        elif type(raw['value']) is bool:
            value = raw['value']
        else:
            raise HTTPException(400, '持有标记无效')
        await budget(request, who)
        return wire_response(await service.mutate(who, kind, key, value, identifier, expected), {'Cache-Control': 'no-store, private'})

    @app.get('/api/account/card-preferences/operations/{request_id}', tags=['cards'])
    async def receipt(request_id: UUID, request: Request):
        return wire_response(await service.receipt(await member(request), request_id), {'Cache-Control': 'no-store, private'})

    @app.post('/api/account/card-preferences/operations/{request_id}/close', tags=['cards'])
    async def close(request_id: UUID, request: Request):
        who = await member(request)
        if (await bounded_body(request, 128)).strip() not in (b'', b'{}'):
            raise HTTPException(400, '关闭请求不能携带偏好内容')
        await budget(request, who)
        return wire_response(await service.close(who, request_id), {'Cache-Control': 'no-store, private'})
