"""Deterministic legacy administrator preview; never sends mail or creates credentials."""

import json

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse

from .legacy_identity import legacy_me_mutation_trusted, web_identity
from .mail_template_model import validate
from .mail_template_renderer import render_mail
from .profile_http import bounded_body
from .security import lock_mutation_identity


def mount_legacy_mail_preview(app, db):
    @app.post('/api/settings/mail-templates/preview', tags=['legacy-mail-templates'])
    async def preview(request: Request):
        headers = {'Cache-Control': 'private, no-store'}
        try:
            if not legacy_me_mutation_trusted(request):
                raise HTTPException(403, '需要管理员权限')
            try:
                who, _, _ = await web_identity(request, db, allow_legacy_bearer=True, origin_checked=True)
                if who.role != 'admin':
                    raise HTTPException(403, '需要管理员权限')
            except HTTPException:
                raise HTTPException(403, '需要管理员权限') from None
            try:
                try:
                    if float(request.headers.get('content-length', '0')) > 16 * 1024:
                        raise HTTPException(400, '模板格式无效')
                except ValueError:
                    pass
                raw = await bounded_body(request, 16 * 1024)
                template = validate(json.loads(raw))
            except (HTTPException, ValueError, UnicodeError, RecursionError):
                raise HTTPException(400, '模板格式无效') from None
            try:
                async with db.connection() as conn, conn.transaction():
                    await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('identity-management:' + who.id,))
                    await lock_mutation_identity(conn, who, require_admin=True)
            except HTTPException:
                raise HTTPException(403, '登录已失效') from None
            rendered = render_preview(template, request.base_url)
            return Response(json.dumps(rendered, ensure_ascii=True, separators=(',', ':')), media_type='application/json', headers=headers)
        except HTTPException as exc:
            return JSONResponse({'error': str(exc.detail)}, status_code=exc.status_code, headers=headers)


def render_preview(template, base_url):
    values = {'email': 'client@example.com', 'siteName': 'Alcor', 'name': '客户', 'minutes': 30, 'stockName': '苹果', 'stockCode': 'AAPL', 'market': 'US', 'currentPrice': '340.35', 'targetPrice': '340.00', 'currency': 'USD', 'direction': '涨至', 'session': '盘后', 'quoteTime': '2026-10-21 16:05:00 美东', 'triggerTime': '10/21 16:05 美东', 'code': '593255', 'url': str(base_url).rstrip('/') + '/verify-email?preview=1'}
    if template['kind'] == 'link':
        values['nativeToken'] = 'PREVIEW-ONLY-NOT-A-REAL-CREDENTIAL'
    rendered = render_mail(template, values, '/api/system-assets/mail-banner')
    return rendered


def mount_mail_preview(app, db):
    @app.post('/api/system/mail-templates/preview', tags=['admin'])
    async def preview(request: Request):
        from .security import administrator

        if 'authorization' in request.headers:
            raise HTTPException(403, '请使用当前网页管理员会话')
        who = await administrator(request)
        try:
            template = validate(json.loads(await bounded_body(request, 16 * 1024)))
        except (ValueError, UnicodeError, RecursionError):
            raise HTTPException(400, '模板格式无效') from None
        async with db.connection() as conn, conn.transaction():
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('identity-management:' + who.id,))
            await lock_mutation_identity(conn, who, require_admin=True)
        return Response(json.dumps(render_preview(template, request.base_url), ensure_ascii=True, separators=(',', ':')), media_type='application/json', headers={'Cache-Control': 'private, no-store'})
