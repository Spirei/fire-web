"""Legacy App account commands over shared transactional broker services.

No account kind is inferred from a name, provider or current holdings. Only the
old create contract uses the service's internal unknown-kind model. Historical
binding and projection guards remain owned by the domain services.
"""

import json
import re
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response
from psycopg.errors import UniqueViolation
from pydantic import ValidationError
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

from .broker_accounts import BrokerDelete, BrokerUpdate, LegacyBrokerCreate
from .broker_metadata import fingerprint
from .card_preferences import JS_WHITESPACE
from .fx_provider_parser import unique
from .legacy_broker_read import ACCOUNT_METADATA_CURRENCIES, account_view, iso, presets
from .legacy_broker_statements import ACCOUNT, request_id
from .legacy_identity import assert_native_origin, native_identity
from .native_app_auth import CLIENT
from .profile_http import bounded_body
from .security import digest

KINDS = {'bind': 'bind_records', 'unbind': 'unbind_records', 'holding-source': 'set_holding_source'}


class LegacyUpdate(BrokerUpdate):
    """Bind the exact old request, including its separate collection CAS.

    Effective currencies are resolved from current authority only for a first
    write. They are not a new input when the old request omitted that field.
    """
    legacy_request_hash: str

    def model_dump(self,*args,**kwargs):
        value=super().model_dump(*args,**kwargs)
        value.pop('currencies',None)
        return value



def integer(value, name, *, minimum=0):
    if type(value) is not int or not minimum <= value <= 9007199254740991:
        raise HTTPException(400, name+'无效')
    return value


def fields(raw, required, optional=()):
    if not isinstance(raw, dict) or set(raw)-set(required)-set(optional) or not set(required) <= set(raw):
        raise HTTPException(400, '请求字段无效')
    request_id(raw.get('requestId'))
    return raw


def currencies(value, default):
    if (not isinstance(value, list) or not 1 <= len(value) <= len(ACCOUNT_METADATA_CURRENCIES)
            or any(not isinstance(item, str) or item not in ACCOUNT_METADATA_CURRENCIES for item in value)
            or len(set(value)) != len(value) or default not in value):
        raise HTTPException(400, '请至少选择一种支持币种，默认币种必须在已选集合内')
    return [item for item in ACCOUNT_METADATA_CURRENCIES if item in value]


def metadata_model(kind, raw, *, current=None):
    if kind == 'delete':
        fields(raw, ('requestId', 'revision'))
        integer(raw['revision'], '账户版本', minimum=1)
        return BrokerDelete(request_id=UUID(raw['requestId']), revision=raw['revision'])
    required = ('requestId', 'name', 'currency', 'providerId') if kind == 'create' else ('requestId', 'revision', 'name', 'currency', 'recordCollectionRevision')
    fields(raw, required, ('currencies',))
    name, currency = raw['name'], raw['currency']
    if (not isinstance(name, str) or not name.strip(JS_WHITESPACE)
            or any(ord(char)<32 or ord(char)==127 for char in name)
            or len(name.strip(JS_WHITESPACE).encode('utf-16-le', errors='surrogatepass'))//2 > 60
            or not isinstance(currency, str) or currency not in ACCOUNT_METADATA_CURRENCIES):
        raise HTTPException(400, '名称或币种无效')
    chosen = raw.get('currencies')
    if chosen is None and 'currencies' in raw:
        raise HTTPException(400, '账户币种无效')
    if chosen is None:
        chosen = [currency] if kind == 'create' else list(dict.fromkeys([*current['currencies'], currency]))
    data = {'request_id': UUID(raw['requestId']), 'name': name.strip(JS_WHITESPACE),
            'currency': currency, 'currencies': currencies(chosen, currency)}
    if kind == 'create':
        data['provider_id'] = raw['providerId']
        return LegacyBrokerCreate(**data)
    data['revision'] = integer(raw['revision'], '账户版本', minimum=1)
    integer(raw['recordCollectionRevision'], '记录集合版本')
    return LegacyUpdate(**data,legacy_request_hash=fingerprint(raw))


def binding_data(raw, *, unbind=False):
    fields(raw, ('requestId', 'revision', 'recordCollectionRevision', 'recordIds'), () if unbind else ('allowReassign',))
    integer(raw['revision'], '账户版本', minimum=1)
    integer(raw['recordCollectionRevision'], '记录集合版本')
    ids = raw['recordIds']
    if (not isinstance(ids, list) or not 1 <= len(ids) <= 2000
            or any(not isinstance(value, str) or not value.strip(JS_WHITESPACE)
                   or len(value.encode('utf-16-le', errors='surrogatepass'))//2 > 128
                   or any(ord(char)<32 or ord(char)==127 for char in value) for value in ids)
            or len(set(ids)) != len(ids)):
        raise HTTPException(400, '持仓选择无效')
    if 'allowReassign' in raw and type(raw['allowReassign']) is not bool:
        raise HTTPException(400, '归属调整确认无效')
    return raw


async def account_projector(app, version):
    values = await presets(app.state.asset_lookup_catalog)

    async def project(conn, owner, account_id):
        return await account_view(conn, owner, account_id, values, version=version)

    return project


async def operation_receipt(app, who, original_id, *, version=2, expected=None):
    """Project only the immutable operation snapshot, never a later account state."""
    identifier = UUID(request_id(original_id))
    async with app.state.broker_metadata.context(who) as conn:
        row = await (await conn.execute('SELECT result,created_at FROM broker_account_operations WHERE owner_id=%s AND request_id=%s', (who.id, identifier))).fetchone()
        if not row:
            raise HTTPException(404, '回执不存在')
        competing = await (await conn.execute('SELECT EXISTS(SELECT 1 FROM broker_statement_import_operations WHERE owner_id=%s AND request_id=%s UNION ALL SELECT 1 FROM broker_statement_source_attempts WHERE owner_id=%s AND request_id=%s) AS found', (who.id, identifier, who.id, identifier))).fetchone()
        if competing['found']:
            raise HTTPException(409, '原编号对应多个领域，请使用原领域回执路径核对')
        result = row['result']
        if expected is not None and result != expected:
            raise HTTPException(503, '账户原操作回执暂时无法一致核对')
        if result.get('state') == 'closed':
            return {'requestId': str(identifier), 'state': 'closed', 'executed': False, 'canonicalReceipt': result}
        error = result.get('error')
        status = error['status'] if error else 200
        code = error.get('code', 40902 if status == 409 else status*100+1) if error else 0
        kind = KINDS.get(result['kind'], result['kind'])
        data = None
        if not error and result['kind'] != 'delete':
            data = result.get('legacy_snapshot')
            if data is None:
                raise HTTPException(409, '原请求未保存旧协议账户快照，请读取真实账户状态和原生回执')
            if result['kind'] == 'holding-source':
                data = {'holdingSource': data['holdingSource'], 'accountRevision': data['revision'],
                        'collectionRevision': data['currencyUsage']['recordCollectionRevision']}
        return {'requestId': str(identifier), 'kind': kind, 'accountId': result.get('account_id') or '',
                'state': result['state'], 'code': code, 'message': str(error['message']) if error else 'ok',
                'completedAt': iso(row['created_at']), 'data': data,
                'migration': {'canonicalReceipt': result, 'accountKindInferred': False,
                              'receiptSnapshot': 'transactional_immutable', 'apiVersion': version}}


def mount_legacy_broker_accounts(app, rate_limit):
    async def member(request):
        assert_native_origin(request, app.state.db.settings)
        if request.query_params:
            raise HTTPException(400, '不支持查询参数')
        if not re.fullmatch(r'Bearer fat_[A-Za-z0-9_-]{43}', request.headers.get('authorization', ''), re.ASCII):
            raise HTTPException(401, '需要有效的 App 连接')
        who, grant = await native_identity(request, app.state.db, 'portfolio.read' if request.method == 'GET' else 'portfolio.write')
        if grant['client_id'] != CLIENT:
            raise HTTPException(401, '需要有效的 App 连接')
        if request.method != 'GET' and not await rate_limit(app.state.db, digest('broker-write:'+who.id), 60, window_seconds=60):
            raise HTTPException(429, '提交过于频繁')
        return who

    async def json_body(request, limit=8192):
        if request.headers.get('content-type', '').split(';')[0].strip() != 'application/json':
            raise HTTPException(400, '需要JSON请求')
        try:
            raw = json.loads(await bounded_body(request, limit), object_pairs_hook=unique,
                             parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError, RecursionError):
            raise HTTPException(400, '无效请求') from None
        if not isinstance(raw, dict):
            raise HTTPException(400, '无效请求')
        return raw

    async def execute(request, action, account_id=''):
        version = 2 if request.url.path.startswith('/api/v2/') else 1
        headers = {'Cache-Control': 'no-store, private', 'Vary': 'Authorization',
                   'X-Alcor-API-Version': str(version), 'X-Content-Type-Options': 'nosniff'}
        try:
            who = await member(request)
            if action != 'create' and not ACCOUNT.fullmatch(account_id):
                raise HTTPException(404, '账户不存在')
            if action == 'icon-content':
                content = await app.state.broker_icons.content(who, account_id)
                return Response(content, media_type='image/png', headers={**headers, 'Content-Disposition': 'inline'})
            project = await account_projector(app, version)
            service = app.state.broker_metadata
            if action == 'upload_icon':
                if not request.headers.get('content-type', '').startswith('multipart/form-data;'):
                    raise HTTPException(400, '需要图片表单')
                await bounded_body(request, 2097152+16384)
                async with request.form(max_files=1, max_fields=2, max_part_size=4096) as form:
                    if set(form) != {'requestId', 'revision', 'file'} or any(len(form.getlist(key)) != 1 for key in form):
                        raise HTTPException(400, '表单字段无效')
                    file, revision = form.get('file'), form.get('revision')
                    original_id = request_id(form.get('requestId'))
                    if not isinstance(file, UploadFile) or not isinstance(revision, str) or not re.fullmatch(r'0|[1-9][0-9]*', revision, re.ASCII):
                        raise HTTPException(400, '图标或版本无效')
                    revision = integer(int(revision), '账户版本', minimum=1)
                    content = await file.read(2097153)
                    if not content or len(content)>2097152:
                        raise HTTPException(413 if content else 400, '图片类型或大小无效')
                    media_type = file.content_type
                result = await app.state.broker_icons.upload(who, account_id, original_id, revision, content, media_type, project=project)
            else:
                raw = await json_body(request, 512*1024 if action in ('bind', 'unbind') else 8192)
                original_id = request_id(raw.get('requestId'))
                if action in ('create', 'update', 'delete'):
                    current = None
                    if action == 'update':
                        async with service.context(who) as conn:
                            previous=await(await conn.execute('SELECT result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s',(who.id,UUID(original_id)))).fetchone()
                            # A replay never resolves omitted fields from a later
                            # account version, and still works after soft retirement.
                            if previous:current=previous['result'].get('data') or {'currencies':[raw.get('currency')]}
                            else:current = await project(conn, who.id, account_id)
                    data = metadata_model(action, raw, current=current)
                    result = await service.legacy_apply(who, action, account_id, data,
                        record_collection_revision=raw.get('recordCollectionRevision'), project=None if action == 'delete' else project)
                elif action in ('bind', 'unbind'):
                    binding_data(raw, unbind=action == 'unbind')
                    result = await app.state.broker_bindings.legacy_apply(who, action, account_id, {key:value for key,value in raw.items() if key!='recordCollectionRevision'},
                        record_collection_revision=raw['recordCollectionRevision'], project=project)
                elif action == 'holding-source':
                    fields(raw, ('requestId', 'revision', 'recordCollectionRevision', 'source'))
                    integer(raw['revision'], '账户版本', minimum=1)
                    integer(raw['recordCollectionRevision'], '记录集合版本')
                    if raw['source'] != 'manual':
                        raise HTTPException(400, '手动来源无效')
                    result = await app.state.broker_holding_source.legacy_apply(who, account_id, raw, project=project)
                else:
                    fields(raw, ('requestId', 'revision'))
                    revision = integer(raw['revision'], '账户版本', minimum=1)
                    result = await app.state.broker_icons.reset(who, account_id, original_id, revision, project=project)
            data = await operation_receipt(app, who, original_id, version=version, expected=result)
            if data.get('state') == 'closed':
                return JSONResponse({'code': 40901, 'message': '原操作已关闭，未执行', 'data': data}, status_code=409, headers=headers)
            error = result.get('error')
            if error:
                return JSONResponse({'code': data['code'], 'message': data['message'], 'data': data}, status_code=error['status'], headers=headers)
            return JSONResponse({'code': 0, 'message': 'ok', 'data': data}, status_code=201 if action == 'create' else 200, headers=headers)
        except ValidationError:
            return JSONResponse({'code': 40001, 'message': '账户请求字段无效'}, status_code=400, headers=headers)
        except UniqueViolation as exc:
            if exc.diag.constraint_name != 'broker_request_domain':
                raise
            return JSONResponse({'code': 40901, 'message': '原请求编号已用于其他账户操作，请查询原回执'}, status_code=409, headers=headers)
        except StarletteHTTPException as exc:
            if exc.status_code in (401, 403):
                headers['X-Alcor-Retire-Context'] = 'true'
            headers.update({key: value for key, value in (exc.headers or {}).items() if key.lower() in {'x-alcor-session-changed', 'x-alcor-reauthentication', 'retry-after'}})
            return JSONResponse({'code': exc.status_code*100+1, 'message': str(exc.detail)}, status_code=exc.status_code, headers=headers)

    async def create(request: Request):
        return await execute(request, 'create')

    async def account(request: Request, account_id: str):
        return await execute(request, 'update' if request.method == 'PUT' else 'delete', account_id)

    async def binding(request: Request, account_id: str):
        return await execute(request, 'bind', account_id)

    async def unbinding(request: Request, account_id: str):
        return await execute(request, 'unbind', account_id)

    async def source(request: Request, account_id: str):
        return await execute(request, 'holding-source', account_id)

    async def icon(request: Request, account_id: str):
        return await execute(request, {'GET': 'icon-content', 'POST': 'upload_icon', 'DELETE': 'reset_icon'}[request.method], account_id)

    for version in (1, 2):
        prefix = f'/api/v{version}/broker-accounts'
        app.add_api_route(prefix, create, methods=['POST'])
        for method in ('PUT', 'DELETE'):
            app.add_api_route(prefix+'/{account_id}', account, methods=[method], operation_id=f'legacy_broker_account_v{version}_{method.lower()}')
        app.add_api_route(prefix+'/{account_id}/bindings', binding, methods=['POST'])
        app.add_api_route(prefix+'/{account_id}/unbindings', unbinding, methods=['POST'])
        app.add_api_route(prefix+'/{account_id}/holding-source', source, methods=['PUT'])
        for method in ('GET', 'POST', 'DELETE'):
            app.add_api_route(prefix+'/{account_id}/icon', icon, methods=[method], operation_id=f'legacy_broker_icon_v{version}_{method.lower()}')
