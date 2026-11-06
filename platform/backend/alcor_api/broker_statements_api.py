"""Owner-scoped offline statement previews; external fetch and financial apply are separate."""
import json
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .broker_statement_sources import BrokerStatementSources
from .legacy_identity import assert_native_origin, native_identity
from .native_app_auth import CLIENT
from .profile_http import bounded_body
from .security import digest, identity


def mount_broker_statements(app, rate_limit):
    service = BrokerStatementSources(app.state.db)
    app.state.broker_statements = service

    async def member(request):
        if request.query_params:
            raise HTTPException(400, '不支持查询参数')
        if request.url.path.startswith('/api/client/'):
            assert_native_origin(request, app.state.db.settings)
            who, grant = await native_identity(request, app.state.db, 'portfolio.read' if request.method == 'GET' else 'portfolio.write')
            if grant['client_id'] != CLIENT:
                raise HTTPException(401, '连接已失效')
        else:
            if 'authorization' in request.headers:
                raise HTTPException(403, '请使用当前网页登录会话')
            who = await identity(request)
        if request.method != 'GET' and not await rate_limit(app.state.db, digest('statement-preview:' + who.id), 10, window_seconds=60):
            raise HTTPException(429, '账单操作过于频繁')
        return who

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError()
            result[key] = value
        return result

    async def execute(request, action, identifier=None):
        headers = {'Cache-Control': 'no-store, private', 'Vary': 'Cookie, Authorization', 'X-Content-Type-Options': 'nosniff'}
        try:
            who = await member(request)
            if action in ('preview', 'import', 'configure-source', 'fetch-source', 'disable-source'):
                if request.headers.get('content-type', '').split(';')[0] != 'application/json':
                    raise HTTPException(415, '请提交 JSON 格式的 UTF-8 XML 原件' if action == 'preview' else '请提交 JSON 格式')
                try:
                    raw = json.loads(await bounded_body(request, 6 * 8 * 1024 * 1024 + 4096 if action == 'preview' else 16384), object_pairs_hook=pairs,
                                     parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                except (ValueError, UnicodeError, RecursionError):
                    raise HTTPException(400, '账单请求格式无效') from None
                if action == 'preview':
                    result = await service.preview(who, raw)
                elif action == 'import':
                    result = await service.confirm(who, raw)
                elif action == 'configure-source':
                    result = await service.configure_source(who, identifier, raw)
                elif action == 'disable-source':
                    result = await service.disable_source(who, identifier, raw)
                else:
                    result = await service.fetch_source(who, identifier, raw)
            elif action == 'source-state':
                result = await service.source_state(who, identifier)
            elif action == 'source-receipt':
                result = await service.source_receipt(who, identifier)
            elif action in ('receipt', 'import-receipt'):
                result = await service.receipt(who, identifier) if action == 'receipt' else await service.import_receipt(who, identifier)
            elif action in ('close', 'import-close', 'source-close'):
                if (await bounded_body(request, 128)).strip() not in (b'', b'{}'):
                    raise HTTPException(422, '关闭请求字段无效')
                if action == 'source-close':
                    result = await service.close_source(who, identifier)
                else:
                    result = await service.close(who, identifier) if action == 'close' else await service.close_import(who, identifier)
            elif action=='received-original':
                try:
                    proof=json.loads(await bounded_body(request,4096),object_pairs_hook=pairs)
                except (ValueError,UnicodeError,RecursionError):raise HTTPException(400,'原响应核对字段无效') from None
                if not isinstance(proof,dict) or set(proof)-{'password','code'} or not isinstance(proof.get('password'),str) or not 1<=len(proof['password'])<=512 or not isinstance(proof.get('code',''),str) or len(proof.get('code',''))>64:raise HTTPException(422,'请输入当前密码与已启用的二次验证码')
                raw,sha=await service.received_original(who,identifier,proof['password'],proof.get('code',''))
                return Response(raw,media_type='application/octet-stream',headers={**headers,'Content-Disposition':'attachment; filename="statement-response.bin"','X-Alcor-Source-SHA256':sha})
            else:
                raw, sha = await service.original(who, identifier)
                return Response(raw, media_type='application/octet-stream', headers={**headers, 'Content-Disposition': 'attachment; filename="statement.xml"', 'X-Alcor-Source-SHA256': sha})
            return JSONResponse(result, headers=headers)
        except HTTPException as exc:
            for key, value in (exc.headers or {}).items():
                if key.lower() in {"x-alcor-session-changed", "x-alcor-reauthentication", "retry-after"}:
                    headers[key] = value
            if exc.status_code in (401, 403):
                headers['X-Alcor-Retire-Context'] = 'true'
            return JSONResponse({'error': {'code': exc.status_code * 100 + 1, 'message': str(exc.detail)}}, status_code=exc.status_code, headers=headers)

    @app.post('/api/account/broker-statements/preview')
    @app.post('/api/client/broker-statements/preview')
    async def preview(request: Request):
        return await execute(request, 'preview')

    @app.get('/api/account/broker-statements/operations/{request_id}')
    @app.get('/api/client/broker-statements/operations/{request_id}')
    async def receipt(request: Request, request_id: UUID):
        return await execute(request, 'receipt', request_id)

    @app.post('/api/account/broker-statements/operations/{request_id}/close')
    @app.post('/api/client/broker-statements/operations/{request_id}/close')
    async def close(request: Request, request_id: UUID):
        return await execute(request, 'close', request_id)

    @app.get('/api/account/broker-statements/originals/{original_id}')
    @app.get('/api/client/broker-statements/originals/{original_id}')
    async def original(request: Request, original_id: UUID):
        return await execute(request, 'original', original_id)

    @app.post('/api/account/broker-statements/responses/{original_id}/download')
    async def received_original(request:Request,original_id:UUID):
        return await execute(request,'received-original',original_id)

    @app.post('/api/account/broker-statements/imports')
    @app.post('/api/client/broker-statements/imports')
    async def import_statement(request: Request):
        return await execute(request, 'import')

    @app.get('/api/account/broker-statements/imports/{request_id}')
    @app.get('/api/client/broker-statements/imports/{request_id}')
    async def import_receipt(request: Request, request_id: UUID):
        return await execute(request, 'import-receipt', request_id)

    @app.post('/api/account/broker-statements/imports/{request_id}/close')
    @app.post('/api/client/broker-statements/imports/{request_id}/close')
    async def close_import(request: Request, request_id: UUID):
        return await execute(request, 'import-close', request_id)

    @app.get('/api/account/broker-statements/accounts/{account_id}/source')
    @app.get('/api/client/broker-statements/accounts/{account_id}/source')
    async def source_state(request: Request, account_id: str):
        return await execute(request, 'source-state', account_id)

    @app.post('/api/account/broker-statements/accounts/{account_id}/source')
    @app.post('/api/client/broker-statements/accounts/{account_id}/source')
    async def configure_source(request: Request, account_id: str):
        return await execute(request, 'configure-source', account_id)

    @app.post('/api/account/broker-statements/accounts/{account_id}/fetch')
    @app.post('/api/client/broker-statements/accounts/{account_id}/fetch')
    async def fetch_source(request: Request, account_id: str):
        return await execute(request, 'fetch-source', account_id)

    @app.get('/api/account/broker-statements/source-operations/{request_id}')
    @app.get('/api/client/broker-statements/source-operations/{request_id}')
    async def source_receipt(request: Request, request_id: UUID):
        return await execute(request, 'source-receipt', request_id)

    @app.post('/api/account/broker-statements/source-operations/{request_id}/close')
    @app.post('/api/client/broker-statements/source-operations/{request_id}/close')
    async def close_source(request: Request, request_id: UUID):
        return await execute(request, 'source-close', request_id)

    @app.delete('/api/account/broker-statements/accounts/{account_id}/source')
    @app.delete('/api/client/broker-statements/accounts/{account_id}/source')
    async def disable_source(request: Request, account_id: str):
        return await execute(request, 'disable-source', account_id)
