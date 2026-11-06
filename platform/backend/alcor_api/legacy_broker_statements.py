"""App-only statement adapters; canonical PG owns previews, sources and imports.

The legacy parsed-JS digest is deliberately not reproduced with rounded money.
The versioned exact-decimal digest is an opaque presentation identifier, never a
replacement for the canonical authorization binding or external-account proof.
"""

import json
import math
import re
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg.errors import UniqueViolation
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

from .broker_accounts import broker_account
from .broker_flex import MAX_BYTES
from .broker_metadata import fingerprint
from .fx_provider_parser import unique
from .legacy_identity import assert_native_origin, native_identity
from .native_app_auth import CLIENT
from .profile_http import bounded_body
from .security import digest

DIGEST_PROTOCOL = 'alcor.exact-decimal.statement.v1'
ACCOUNT = re.compile(r'ba-[a-f0-9]{24}\Z', re.ASCII)
PREVIEW = re.compile(r'bsp-([a-f0-9]{32})\Z', re.ASCII)
CAPABILITIES = {
    'protocol': 'alcor.broker-statements.v1', 'preview': True,
    'automaticApply': False, 'automaticFetch': False,
    'applyRequires': ['requestId', 'revision', 'previewId'],
    'applyConditionalConfirmation': ['takeOverOfficial_when_manual', 'acknowledgeUnassigned_when_required'],
    'externalAccountProof': 'explicit_uploaded_account_in_same_grant_bound_preview',
    'fetchRequires': [],
    'legacyFetchProtocol': 'explicit_post_single_step_with_durable_original_uuid',
    'configureRequires': ['requestId', 'revision', 'externalAccount', 'queryId', 'token'],
    'targetSelection': 'explicit_owner_installed_single_approved_target_or_explicit_id',
    'disconnectRequires': ['requestId', 'revision'],
    'digestProtocol': DIGEST_PROTOCOL, 'legacyParsedDigestKnown': False,
    'receiptScope': 'owner_with_current_native_method_scope_grant', 'unknownResult': 'query_original_uuid',
}


class AdaptationRequired(HTTPException):
    def __init__(self, message, data=None):
        super().__init__(409, message)
        self.data = {'migrationRequired': True, 'capabilities': CAPABILITIES, **(data or {})}


class SourceOutcome(HTTPException):
    def __init__(self, result):
        status = 422 if result.get('state') == 'rejected' else 503
        super().__init__(status, '账单来源请求被拒绝，请核对凭据或配置' if status == 422 else '账单获取结果未知，请只查询原请求编号')
        self.data = {'canonicalReceipt': result, 'capabilities': CAPABILITIES,
                     'receiptPath': '/api/client/broker-statements/source-operations/'+result['requestId']}


def exact_digest(statement):
    fields = ('provider', 'externalAccount', 'fromDate', 'toDate', 'positions', 'cash', 'events', 'warnings', 'numericRepresentation')
    return fingerprint({'protocol': DIGEST_PROTOCOL, 'statement': {key: statement[key] for key in fields}})


def preview_id(value):
    match = PREVIEW.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise HTTPException(400, '预览ID无效')
    return UUID(hex=match[1])


def request_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', value, re.ASCII):
        raise HTTPException(400, 'requestId 须为小写 UUID')
    return str(UUID(value))


def display_cash(items):
    result = []
    for item in items:
        value = float(item['endingCash'])
        if not math.isfinite(value) or (value == 0 and Decimal(item['endingCash']) != 0):
            raise AdaptationRequired('现金数值无法按旧客户端格式展示，请使用精确小数协议')
        result.append({'currency': item['currency'], 'endingCash': value, 'exactEndingCash': item['endingCash']})
    return result


def project_preview(result, holding_source, *, already_imported=None):
    statement, comparison = result['statement'], result['comparison']
    migration = {**CAPABILITIES, 'canonicalPreviewId': result['previewId'],
                 'requestId': result['requestId'], 'canonicalReceiptPath': '/api/client/broker-statements/operations/'+result['requestId'],
                 'sourceSha256': statement['sourceSha256'], 'financialEffect': 'none',
                 'externalAccount': statement['externalAccount'], 'recordProof': comparison['recordProof'],
                 'cashNumberProjection': 'legacy_display_binary64_with_exact_text',
                 'externalAccountConfirmationRequired': False,
                 'alreadyImportedCheck': 'same_owner_account_and_raw_source_sha256_only',
                 'numericRepresentation': 'exact_decimal_text_except_legacy_cash_display',
                 'legacyRequestIdGenerated': result.get('legacyRequestIdGenerated')}
    if already_imported is True:
        return {'alreadyImported': True, 'digest': exact_digest(statement), 'migration': migration}
    if comparison['blockers']:
        raise AdaptationRequired('该账单含旧客户端无法核对的差异，请使用新版确认流程', {'canonicalPreview': result})
    rows = []
    for item in comparison['rows']:
        before = item['before']
        rows.append({**{key: item[key] for key in ('key', 'conid', 'code', 'name', 'market', 'currency', 'qty', 'price', 'cost', 'recordId', 'action', 'unassignedMatches')},
                     'before': {key: before[key] if before[key] is not None else '' for key in ('qty', 'cost', 'price')} if before else None})
    missing = []
    for item in comparison['missing']:
        if item['action'] != 'close_snapshot_position' or item['before'] is None:
            raise AdaptationRequired('未知持仓不能转换为旧客户端的归零差异', {'canonicalPreview': result})
        market, code = item['security'].split(':', 1)
        missing.append({'recordId': item['recordId'], 'market': market, 'code': code, 'before': item['before'], 'after': 0})
    return {'pending': False, 'alreadyImported': already_imported,
            'previewId': 'bsp-'+UUID(result['previewId']).hex, 'digest': exact_digest(statement),
            'accountRevision': result['accountRevision'], 'collectionRevision': comparison['recordCollectionRevision'],
            'holdingSource': holding_source, 'requiresOfficialTakeover': holding_source == 'manual',
            'fromDate': statement['fromDate'], 'toDate': statement['toDate'], 'cash': display_cash(statement['cash']),
            'eventCount': len(statement['events']), 'warnings': statement['warnings'],
            'rows': rows, 'missing': missing,
            'requiresUnassignedAcknowledgement': comparison['requiresUnassignedAcknowledgement'], 'migration': migration}


async def projected_preview(service, who, account_id, result):
    if result.get('state') != 'previewed':
        raise AdaptationRequired('原操作未产生可用预览', {'canonicalReceipt': result})
    async with service.context(who) as conn:
        account = await broker_account(conn, who.id, account_id)
        if result['accountId'] != account_id or account['revision'] != result['accountRevision']:
            raise HTTPException(409, '账户已变化，请重新预览')
        imported = await (await conn.execute('SELECT 1 FROM broker_statement_imports WHERE owner_id=%s AND account_id=%s AND source_sha256=%s',
                                            (who.id, account_id, result['statement']['sourceSha256']))).fetchone()
        return project_preview(result, account['holding_source'], already_imported=True if imported else None)


def mount_legacy_broker_statements(app, rate_limit):
    async def member(request):
        assert_native_origin(request, app.state.db.settings)
        if request.query_params:
            raise HTTPException(400, '不支持查询参数')
        if not re.fullmatch(r'Bearer fat_[A-Za-z0-9_-]{43}', request.headers.get('authorization', ''), re.ASCII):
            raise HTTPException(401, '需要有效的 App 连接')
        who, grant = await native_identity(request, app.state.db, 'portfolio.read' if request.method == 'GET' else 'portfolio.write')
        if grant['client_id'] != CLIENT:
            raise HTTPException(401, '连接已失效')
        if request.method != 'GET' and not await rate_limit(app.state.db, digest('broker-statement:'+who.id), 30, window_seconds=60):
            raise HTTPException(429, '操作过于频繁')
        return who

    async def json_body(request):
        if request.headers.get('content-type', '').split(';')[0] != 'application/json':
            raise HTTPException(400, '需要JSON请求')
        try:
            result = json.loads(await bounded_body(request, 4096), object_pairs_hook=unique,
                                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError, RecursionError):
            raise HTTPException(400, '请求无效') from None
        if not isinstance(result, dict):
            raise HTTPException(400, '请求无效')
        return result

    async def execute(request, action, account_id=None, operation_id=None):
        version = 2 if request.url.path.startswith('/api/v2/') else 1
        headers = {'Cache-Control': 'no-store, private', 'Vary': 'Cookie, Authorization',
                   'X-Alcor-API-Version': str(version), 'X-Content-Type-Options': 'nosniff'}
        try:
            who = await member(request)
            service = app.state.broker_statements
            if account_id is not None and not ACCOUNT.fullmatch(account_id):
                raise HTTPException(404, '账户不存在')
            if action == 'connection-state':
                data = await connection_status(service, who, account_id)
            elif action == 'connection':
                raw = await json_body(request)
                allowed = {'requestId', 'revision', 'connectionRevision'} if request.method == 'DELETE' else {'requestId', 'revision', 'connectorId', 'externalAccount', 'queryId', 'token', 'targetId', 'connectionRevision'}
                if set(raw)-allowed:
                    raise HTTPException(400, '含未知字段')
                operation_id = request_id(raw.get('requestId'))
                if type(raw.get('revision')) is not int or raw['revision'] < 1:
                    raise HTTPException(400, '账户版本无效')
                async with service.context(who) as conn:
                    account = await broker_account(conn, who.id, account_id)
                    if account['revision'] != raw['revision']:
                        raise HTTPException(409, '账户已变化，请重新读取')
                    source = await service.source(conn, who.id, account_id)
                    source_revision = source['revision'] if source else 0
                    if 'connectionRevision' in raw and raw['connectionRevision'] != source_revision:
                        raise HTTPException(409, '来源版本已变化，请重新读取')
                    approved = service.targets(who.id) if request.method != 'DELETE' else {}
                if request.method == 'DELETE':
                    if not source:
                        raise HTTPException(409, '账户尚无已登记来源，未伪造停用回执')
                    result = await service.disable_source(who, account_id, {'requestId': operation_id, 'accountRevision': raw['revision'], 'connectionRevision': source_revision})
                else:
                    if raw.get('connectorId', 'ibkr-flex') != 'ibkr-flex':
                        raise HTTPException(422, '此官方账单渠道尚未开放')
                    if not {'externalAccount', 'queryId', 'token'} <= set(raw):
                        raise HTTPException(400, 'Flex凭据字段无效')
                    target_id = raw.get('targetId')
                    if target_id is None:
                        if len(approved) != 1:
                            raise HTTPException(409 if approved else 503, '需明确唯一已许可的本人固定 IBKR 来源')
                        target_id = next(iter(approved))
                    if not isinstance(target_id, str) or target_id not in approved:
                        raise HTTPException(403, '尚未安装本人已许可的固定 IBKR 来源')
                    result = await service.configure_source(who, account_id, {'requestId': operation_id, 'accountKind': account['account_kind'],
                        'accountRevision': raw['revision'], 'connectionRevision': source_revision, 'targetId': target_id,
                        **{key: raw[key] for key in ('externalAccount', 'queryId', 'token')}})
                data = await source_operation(service, who, operation_id, result)
            elif action == 'preview':
                if not request.headers.get('content-type', '').startswith('multipart/form-data;'):
                    raise HTTPException(400, '需要XML文件表单')
                await bounded_body(request, MAX_BYTES+16384)
                try:
                    async with request.form(max_files=1, max_fields=3, max_part_size=4096) as form:
                        pairs = list(form.multi_items())
                        if set(form) - {'file', 'externalAccount', 'connectorId'} or len(form.getlist('file')) != 1 or len(form.getlist('externalAccount')) != 1 or len(form.getlist('connectorId')) > 1 or len(pairs) != len(form):
                            raise HTTPException(400, '表单字段无效')
                        file, external = form.get('file'), form.get('externalAccount')
                        connector = form.get('connectorId', 'ibkr-flex')
                        if connector != 'ibkr-flex':
                            raise HTTPException(422, '此官方账单渠道尚未开放')
                        if not isinstance(file, UploadFile) or not isinstance(external, str) or not re.fullmatch(r'[A-Za-z0-9-]{2,40}', external, re.ASCII):
                            raise HTTPException(400, '请选择有效XML账单及账户编号')
                        original = await file.read(MAX_BYTES+1)
                        if not original or len(original) > MAX_BYTES:
                            raise HTTPException(413 if original else 400, '请选择有效XML账单')
                        xml = original.decode('utf-8', errors='strict')
                except UnicodeError:
                    raise HTTPException(422, '账单须为 UTF-8 XML') from None
                async with service.context(who) as conn:
                    account = await broker_account(conn, who.id, account_id)
                original_id = request.headers.get('x-alcor-request-id')
                generated = original_id is None
                original_id = request_id(original_id) if original_id is not None else str(uuid4())
                result = await service.preview(who, {'requestId': original_id, 'accountId': account_id,
                    'accountKind': account['account_kind'], 'revision': account['revision'], 'externalAccount': external, 'xml': xml})
                data = await projected_preview(service, who, account_id, result)
                data['migration']['previewRequestIdGenerated'] = generated
            elif action == 'apply':
                raw = await json_body(request)
                allowed = {'requestId', 'revision', 'previewId', 'acknowledgeUnassigned', 'takeOverOfficial', 'confirmExternalAccount'}
                if set(raw)-allowed:
                    raise HTTPException(400, '含未知字段')
                operation_id = request_id(raw.get('requestId'))
                canonical_id = preview_id(raw.get('previewId'))
                if type(raw.get('revision')) is not int or raw['revision'] < 1:
                    raise HTTPException(400, '账户版本无效')
                async with service.context(who) as conn:
                    account = await broker_account(conn, who.id, account_id)
                    preview = await (await conn.execute('SELECT account_id,account_revision,authorization_binding,parsed,expires_at>clock_timestamp() AS valid FROM broker_statement_previews WHERE owner_id=%s AND id=%s', (who.id, canonical_id))).fetchone()
                    if (not preview or preview['account_id'] != account_id or preview['account_revision'] != raw['revision']
                            or account['revision'] != raw['revision'] or not preview['valid']
                            or preview['authorization_binding'] != await service.binding(conn, who)):
                        raise HTTPException(409, '预览不属于当前账户、连接、会话或版本，请重新预览')
                    external_account = preview['parsed']['externalAccount']
                if 'confirmExternalAccount' in raw and raw['confirmExternalAccount'] != external_account:
                    raise HTTPException(409, '确认的外部账户与原预览不一致')
                if any(key in raw and type(raw[key]) is not bool for key in ('takeOverOfficial', 'acknowledgeUnassigned')):
                    raise HTTPException(400, '账单确认字段无效')
                if account['holding_source'] == 'manual' and raw.get('takeOverOfficial') is not True:
                    raise HTTPException(409, '请预览并明确确认由官方接管持仓')
                # The original user selected this bound preview with its explicit uploaded
                # external account. Existing official scope needs no second takeover.
                result = await service.confirm(who, {'requestId': operation_id, 'previewId': str(canonical_id),
                    'confirmExternalAccount': external_account, 'takeOverOfficial': True,
                    'acknowledgeUnassigned': raw.get('acknowledgeUnassigned', False)})
                data = await import_operation(service, who, operation_id, expected_account=account_id, result=result)
            elif action == 'fetch':
                body = await bounded_body(request, 4096)
                if body.strip() in (b'', b'{}'):
                    # Canonical service chooses/continues the same owner/source/grant
                    # admission atomically. Unknown original results never re-enter IO.
                    result = await service.legacy_fetch_source(who, account_id)
                else:
                    raw = await json_body(request)
                    if set(raw)-{'requestId', 'connectionRevision', 'previousRequestId'} or not {'requestId', 'connectionRevision'} <= set(raw):
                        raise HTTPException(400, '获取账单字段无效')
                    request_id(raw['requestId'])
                    result = await service.fetch_source(who, account_id, raw)
                if result.get('state') == 'previewed':
                    data = await projected_preview(service, who, account_id, result)
                elif result.get('state') == 'pending':
                    data = {'pending': True, 'retryAfterSeconds': result['retryAfterSeconds'], 'migration': {'canonicalReceipt': result, 'capabilities': CAPABILITIES}}
                else:
                    raise SourceOutcome(result)
            else:
                operation_id = request_id(operation_id)
                try:
                    if hasattr(app.state, 'broker_metadata'):
                        from .legacy_broker_accounts import operation_receipt
                        try:
                            data = await operation_receipt(app, who, operation_id, version=version)
                        except HTTPException as common_error:
                            if common_error.status_code != 404:
                                raise
                            data = await import_operation(service, who, operation_id)
                    else:
                        data = await import_operation(service, who, operation_id)
                except HTTPException as exc:
                    if exc.status_code != 404:
                        raise
                    try:
                        result = await service.source_receipt(who, operation_id)
                    except HTTPException as source_error:
                        commands = getattr(app.state, 'legacy_cash_commands', None)
                        if source_error.status_code != 404 or commands is None:
                            raise
                        data = await commands.receipt(who, operation_id)
                        result = None
                    if result is None:
                        pass
                    elif result.get('state') in ('configured', 'disabled'):
                        data = await source_operation(service, who, operation_id, result)
                    elif result.get('state') == 'previewed':
                        data = await projected_preview(service, who, result['accountId'], result)
                    elif result.get('state') == 'pending':
                        data = {'pending': True, 'retryAfterSeconds': result['retryAfterSeconds'], 'migration': {'canonicalReceipt': result, 'capabilities': CAPABILITIES}}
                    else:
                        raise SourceOutcome(result)
            return JSONResponse({'code': 0, 'message': 'ok', 'data': data}, headers=headers, status_code=202 if action == 'fetch' and data.get('pending') else 200)
        except UniqueViolation as exc:
            if exc.diag.constraint_name != 'broker_request_domain':
                raise
            return JSONResponse({'code': 40901, 'message': '原请求编号已用于其他账户操作，请查询原回执'}, status_code=409, headers=headers)
        except StarletteHTTPException as exc:
            headers.update({key: value for key, value in (exc.headers or {}).items() if key.lower() in {'x-alcor-session-changed', 'x-alcor-reauthentication', 'retry-after'}})
            if exc.status_code in (401, 403):
                headers['X-Alcor-Retire-Context'] = 'true'
            return JSONResponse({'code': exc.status_code*100+1, 'message': str(exc.detail), 'data': getattr(exc, 'data', None)}, status_code=exc.status_code, headers=headers)

    async def connection(request: Request, account_id: str):
        return await execute(request, 'connection-state' if request.method == 'GET' else 'connection', account_id)

    async def preview(request: Request, account_id: str):
        return await execute(request, 'preview', account_id)

    async def apply(request: Request, account_id: str):
        return await execute(request, 'apply', account_id)

    async def fetch(request: Request, account_id: str):
        return await execute(request, 'fetch', account_id)

    async def operation(request: Request, operation_id: str):
        return await execute(request, 'operation', operation_id=operation_id)

    for version in (1, 2):
        prefix = f'/api/v{version}/broker-accounts'
        for method in ('GET', 'PUT', 'DELETE'):
            app.add_api_route(prefix+'/{account_id}/connection', connection, methods=[method], operation_id=f'legacy_statement_connection_v{version}_{method.lower()}')
        app.add_api_route(prefix+'/{account_id}/statements/preview', preview, methods=['POST'])
        app.add_api_route(prefix+'/{account_id}/statements/apply', apply, methods=['POST'])
        app.add_api_route(prefix+'/{account_id}/statements/fetch', fetch, methods=['POST'])
        app.add_api_route(prefix+'/operations/{operation_id}', operation, methods=['GET'])


async def import_operation(service, who, request, *, expected_account=None, result=None):
    async with service.context(who) as conn:
        row = await (await conn.execute('SELECT result,created_at FROM broker_statement_import_operations WHERE owner_id=%s AND request_id=%s', (who.id, UUID(request)))).fetchone()
        if not row or expected_account is not None and row['result'].get('accountId') != expected_account:
            raise HTTPException(404, '本人原导入回执不存在')
        receipt = row['result']
        if result is not None and result != receipt:
            raise HTTPException(503, '导入回执暂时无法一致核对')
        if receipt.get('state') != 'completed':
            raise AdaptationRequired('原请求未产生已完成导入', {'canonicalReceipt': receipt})
        source = await (await conn.execute('SELECT statement FROM broker_statement_imports WHERE owner_id=%s AND request_id=%s AND account_id=%s', (who.id, UUID(request), receipt['accountId']))).fetchone()
        if not source:
            raise HTTPException(503, '导入原件暂时无法核对')
        statement = source['statement']
        return {'requestId': receipt['requestId'], 'kind': 'import_statement', 'accountId': receipt['accountId'],
                'state': 'completed', 'code': 0, 'message': 'ok', 'completedAt': row['created_at'].isoformat(),
                'data': {'holdingSource': 'official', 'accountRevision': receipt['accountRevision'],
                         'digest': exact_digest(statement), 'updated': receipt['updated'], 'created': receipt['created'],
                         'closed': receipt['closed'], 'eventCount': len(statement['events']), 'collectionRevision': receipt['recordCollectionRevision']},
                'migration': {'capabilities': CAPABILITIES, 'sourceSha256': receipt['sourceSha256'],
                              'canonicalReceipt': receipt, 'digestProtocol': DIGEST_PROTOCOL, 'legacyParsedDigestKnown': False}}


async def connection_status(service, who, account_id):
    async with service.context(who) as conn:
        account = await broker_account(conn, who.id, account_id)
        source = await service.source(conn, who.id, account_id)
        latest = await (await conn.execute('SELECT statement,to_date,created_at FROM broker_statement_imports WHERE owner_id=%s AND account_id=%s AND account_kind=%s ORDER BY to_date DESC,created_at DESC,id DESC LIMIT 1', (who.id, account_id, account['account_kind']))).fetchone()
        configured = bool(source and source['enabled'])
        return {'holdingSource': account['holding_source'], 'configured': configured,
                'connectorId': 'ibkr-flex' if configured else None,
                'latest': {'toDate': latest['to_date'].strftime('%Y%m%d'), 'importedAt': latest['created_at'].isoformat(), 'cash': display_cash(latest['statement']['cash'])} if latest else None,
                'migration': {'capabilities': CAPABILITIES, 'accountKind': account['account_kind'],
                              'accountRevision': account['revision'], 'connectionRevision': source['revision'] if source else 0,
                              'externalAccount': source['external_account'] if source else None,
                              'targets': [{'id': identifier} for identifier in service.targets(who.id)],
                              'configuredMeaning': 'stored_enabled_source_not_verified_live_access'}}


async def source_operation(service, who, request, result):
    if result.get('state') not in ('configured', 'disabled'):
        raise SourceOutcome(result)
    async with service.context(who) as conn:
        row = await (await conn.execute('SELECT public_result,created_at FROM broker_statement_source_attempts WHERE owner_id=%s AND request_id=%s', (who.id, UUID(request)))).fetchone()
        if not row or row['public_result'] != result:
            raise HTTPException(503, '来源原操作回执暂时无法核对')
        return {'requestId': result['requestId'], 'kind': 'configure_statement' if result['state'] == 'configured' else 'disconnect_statement',
                'accountId': result['accountId'], 'state': 'completed', 'code': 0, 'message': 'ok',
                'completedAt': row['created_at'].isoformat(), 'data': {'configured': result['state'] == 'configured'},
                'migration': {'capabilities': CAPABILITIES, 'canonicalReceipt': result,
                              'sourceReceiptPath': '/api/client/broker-statements/source-operations/'+result['requestId']}}
