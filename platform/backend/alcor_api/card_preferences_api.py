"""Legacy Web card tags/holdings adapters; no asset lookup or financial inference."""

import json
from uuid import UUID, uuid4

from fastapi import HTTPException, Request

from .card_preferences import CardPreferences, card_key, card_tags
from .card_preferences_protocol import card_member, wire_response
from .profile_http import bounded_body
from .security import digest


def mount_card_preferences(app, settings, db, rate_limit):
    service = CardPreferences(db)
    app.state.card_preferences = service

    async def execute(request, kind=None, write=False, request_id=None):
        headers = {'Cache-Control': 'no-store, private', 'Vary': 'Cookie, Authorization', 'X-Alcor-Source-Coverage': 'platform-only'}
        try:
            who = await card_member(request, db)
            if request_id is not None:
                try:
                    identifier = UUID(request_id)
                except ValueError:
                    raise HTTPException(400, '原请求编号无效') from None
                return wire_response(await service.receipt(who, identifier), headers=headers)
            if write:
                address = request.client.host if request.client else 'unknown'
                for bucket in ('card-' + kind + ':' + who.id + ':' + address,):
                    if not await rate_limit(db, digest(bucket), 120, window_seconds=60):
                        raise HTTPException(429, '操作过于频繁，请稍后再试')
                try:
                    def invalid_constant(_):
                        raise ValueError()
                    data = json.loads((await bounded_body(request, 10 * 1024 * 1024)).decode('utf-8-sig'), parse_constant=invalid_constant)
                except HTTPException as exc:
                    if exc.status_code != 413:
                        raise
                    raise HTTPException(400, '无效请求') from None
                except (ValueError, UnicodeError, RecursionError):
                    raise HTTPException(400, '无效请求') from None
                if isinstance(data, list):
                    data = {}
                if not isinstance(data, dict):
                    raise HTTPException(400, '无效请求')
                key = card_key(data.get('cardKey'))
                value = card_tags(data.get('tags')) if kind == 'tags' else data.get('held') is True
                raw = request.headers.get('x-alcor-request-id')
                try:
                    identifier = UUID(raw) if raw is not None else uuid4()
                except ValueError:
                    raise HTTPException(400, '原请求编号无效') from None
                expected = request.headers.get('x-alcor-cards-revision')
                if expected is not None:
                    if not expected.isascii() or not expected.isdecimal() or len(expected) > 16 or int(expected) > 9007199254740991:
                        raise HTTPException(400, '集合版本无效')
                    expected = int(expected)
                result = await service.mutate(who, kind, key, value, identifier, expected)
                headers['X-Alcor-Request-Id'] = str(identifier)
                headers['X-Alcor-Cards-Revision'] = str(result['revision'])
                if raw is None:
                    headers['X-Alcor-Request-Id-Mode'] = 'generated_legacy'
                return wire_response(result['data'], headers=headers)
            result = await service.read(who)
            headers['X-Alcor-Cards-Revision'] = str(result['revision'])
            return wire_response({kind: result[kind]}, headers=headers)
        except HTTPException as exc:
            if exc.status_code == 401:
                exc = HTTPException(401, '未登录')
            if exc.status_code in (401, 403):
                headers['X-Alcor-Retire-Context'] = 'true'
            return wire_response({'error': str(exc.detail)}, status_code=exc.status_code, headers=headers)

    @app.get('/api/cards/tags', tags=['legacy-web-cards'])
    async def tags(request: Request):
        return await execute(request, 'tags')

    @app.put('/api/cards/tags', tags=['legacy-web-cards'])
    async def save_tags(request: Request):
        return await execute(request, 'tags', True)

    @app.get('/api/cards/holdings', tags=['legacy-web-cards'])
    async def holdings(request: Request):
        return await execute(request, 'holdings')

    @app.put('/api/cards/holdings', tags=['legacy-web-cards'])
    async def save_holdings(request: Request):
        return await execute(request, 'holdings', True)

    @app.get('/api/cards/operations/{request_id}', tags=['cards'])
    async def receipt(request_id: str, request: Request):
        return await execute(request, request_id=request_id)
