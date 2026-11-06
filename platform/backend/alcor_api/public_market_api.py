"""Administrator-only installation and explicit public market collection commands."""

import json
from hashlib import sha256
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .fx_provider_parser import unique
from .notification_security import NotificationSecurity
from .profile_http import bounded_body
from .public_market_quotes import PublicQuotes
from .security import administrator, digest, lock_mutation_identity


def mount_public_market(app, db, authority):
    app.state.public_market_quotes = PublicQuotes(authority)
    app.state.public_market_authority = authority

    async def admin(request):
        who = await administrator(request)
        caller = request.client.host if request.client else 'unknown'
        if not await app.state.rate_limit(db, digest('public-market-admin:'+who.id+':'+caller), 20, window_seconds=60):
            raise HTTPException(429, '公共行情管理请求过于频繁')
        return who

    async def body(request):
        try:
            value = json.loads(await bounded_body(request, 16384), object_pairs_hook=unique,
                               parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if not isinstance(value, dict):
                raise TypeError()
            value['requestId'] = UUID(str(value['requestId']))
            if not isinstance(value.get('password'), str) or not 1 <= len(value['password']) <= 1024:
                raise ValueError()
            if not isinstance(value.get('code', ''), str) or len(value.get('code', '')) > 128:
                raise ValueError()
            return value
        except (KeyError, ValueError, TypeError, UnicodeError, RecursionError):
            raise HTTPException(400, '需要原请求编号、当前密码及有效公共来源命令') from None

    @app.get('/api/system/public-market/licenses')
    async def listing(request: Request):
        who = await admin(request)
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            rows = await (await conn.execute('''SELECT l.id,l.policy_id,l.license_revision,l.created_at,
                EXISTS(SELECT 1 FROM public_market_revocations r WHERE r.license_id=l.id) AS revoked
                FROM public_market_licenses l ORDER BY l.created_at DESC LIMIT 101''')).fetchall()
        return JSONResponse({'licenses': [{**row, 'id': str(row['id']), 'created_at': row['created_at'].isoformat()} for row in rows[:100]],
                             'partial': len(rows) > 100, 'automaticCollection': False}, headers={'Cache-Control': 'no-store'})

    @app.post('/api/system/public-market/licenses/install')
    async def install(request: Request):
        who = await admin(request)
        raw = await body(request)
        if set(raw) - {'requestId', 'policyId', 'password', 'code'} or not isinstance(raw.get('policyId'), str):
            raise HTTPException(400, '公共来源安装字段无效')
        return await authority.install(who, raw['requestId'], raw['policyId'], raw['password'], raw.get('code', ''))

    @app.post('/api/system/public-market/licenses/revoke')
    async def revoke(request: Request):
        who = await admin(request)
        raw = await body(request)
        try:
            license_id = UUID(str(raw['licenseId']))
            if set(raw) - {'requestId', 'licenseId', 'password', 'code'}:
                raise ValueError()
        except (KeyError, ValueError, TypeError):
            raise HTTPException(400, '公共许可编号无效') from None
        return await authority.revoke(who, raw['requestId'], license_id, raw['password'], raw.get('code', ''))

    @app.post('/api/system/public-market/collect')
    async def collect(request: Request):
        who = await admin(request)
        raw = await body(request)
        try:
            license_id = UUID(str(raw['licenseId']))
            if set(raw) - {'requestId', 'licenseId', 'query', 'password', 'code'} or not isinstance(raw.get('query'), dict):
                raise ValueError()
        except (KeyError, ValueError, TypeError):
            raise HTTPException(400, '公共采集命令无效') from None
        return await authority.enqueue(who, raw['requestId'], license_id, raw['query'], raw['password'], raw.get('code', ''))

    @app.get('/api/system/public-market/operations/{request_id}')
    async def receipt(request: Request, request_id: UUID):
        who = await admin(request)
        return await authority.receipt(who, request_id)

    @app.post('/api/system/public-market/originals/{page_id}')
    async def original(request: Request, page_id: UUID):
        who = await admin(request)
        proof = await body(request)
        if set(proof) - {'requestId', 'password', 'code'}:
            raise HTTPException(400, '原件核对字段无效')
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            await NotificationSecurity(db).passkeys.step_up(conn, who, proof['password'], proof.get('code', ''))
            row = await (await conn.execute('''SELECT p.raw_bytes,p.raw_sha256 FROM public_market_pages p
                JOIN public_market_tasks t ON t.id=p.task_id
                JOIN public_market_licenses l ON l.id=t.license_id
                WHERE p.id=%s AND l.origin_instance=%s''', (page_id, str(db.settings.instance_id)))).fetchone()
            if not row:
                raise HTTPException(404, '公共采集原件不存在')
            raw = bytes(row['raw_bytes'])
            if sha256(raw).hexdigest() != row['raw_sha256']:
                raise HTTPException(503, '公共采集原件校验失败')
        return Response(raw, media_type='application/octet-stream', headers={
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': f'attachment; filename="public-market-{page_id}.bin"'})
