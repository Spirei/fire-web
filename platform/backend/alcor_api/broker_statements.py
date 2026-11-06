"""Preserve offline source originals and immutable preview receipts; no financial apply."""
from uuid import UUID, uuid4

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from psycopg.types.json import Jsonb

from .broker_accounts import broker_account
from .broker_flex import parse_flex
from .broker_metadata import BrokerMetadata, fingerprint
from .broker_statement_plan import prepare_comparison


def identifier(value):
    try:
        return UUID(str(value))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, '原操作编号无效') from None


class BrokerStatements(BrokerMetadata):
    async def serialize(self, conn, owner, request):
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',
                           ('broker-statement-preview:' + owner + ':' + str(request),))

    async def preview(self, who, raw):
        if not isinstance(raw, dict) or set(raw) != {'requestId', 'accountId', 'accountKind', 'revision', 'externalAccount', 'xml'}:
            raise HTTPException(422, '账单预览字段无效')
        request = identifier(raw['requestId'])
        if (raw['accountKind'] not in ('real', 'simulated') or type(raw['revision']) is not int
                or raw['revision'] < 1 or not isinstance(raw['accountId'], str) or not isinstance(raw['xml'], str)):
            raise HTTPException(422, '账单账户或版本无效')
        try:
            original = raw['xml'].encode('utf-8', errors='strict')
        except UnicodeError:
            raise HTTPException(422, '账单须为有效 UTF-8 XML') from None
        parsed = parse_flex(original, raw['externalAccount'])
        request_hash = fingerprint({k: v for k, v in raw.items() if k != 'xml'} | {'sourceSha256': parsed['sourceSha256']})
        async with self.context(who) as conn:
            await self.serialize(conn, who.id, request)
            prior = await (await conn.execute('SELECT request_hash,result FROM broker_statement_preview_operations WHERE owner_id=%s AND request_id=%s', (who.id, request))).fetchone()
            if prior:
                if prior['request_hash'] is not None and prior['request_hash'] != request_hash:
                    raise HTTPException(409, '原操作编号已用于其他账单')
                return prior['result']
            account = await broker_account(conn, who.id, raw['accountId'])
            if account['revision'] != raw['revision'] or account['account_kind'] != raw['accountKind']:
                raise HTTPException(409, '账户类型或版本已变化，请重新预览')
            plan = await prepare_comparison(conn, who.id, account, parsed)
            retained = await (await conn.execute('SELECT id,source_bytes FROM broker_statement_originals WHERE owner_id=%s AND account_id=%s AND source_sha256=%s AND external_account=%s AND account_kind=%s ORDER BY created_at,id LIMIT 1', (who.id, raw['accountId'], parsed['sourceSha256'], raw['externalAccount'], raw['accountKind']))).fetchone()
            if retained and bytes(retained['source_bytes']) != original:
                raise HTTPException(409, '账单原件哈希与内容不一致，须核对原件')
            source_id, preview_id = (retained['id'] if retained else uuid4()), uuid4()
            if retained is None:
                await conn.execute('INSERT INTO broker_statement_originals(owner_id,id,account_id,account_kind,provider,external_account,source_sha256,source_bytes) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',
                                   (who.id, source_id, raw['accountId'], raw['accountKind'], 'ibkr', raw['externalAccount'], parsed['sourceSha256'], original))
            expiry = await (await conn.execute('INSERT INTO broker_statement_previews(owner_id,id,original_id,account_id,account_kind,account_revision,authorization_binding,parsed,comparison,comparison_hash,record_collection_revision) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING expires_at',
                                               (who.id, preview_id, source_id, raw['accountId'], raw['accountKind'], raw['revision'], await self.binding(conn, who), Jsonb(parsed), Jsonb(plan), fingerprint(plan), plan['recordCollectionRevision']))).fetchone()
            result = jsonable_encoder({'requestId': str(request), 'state': 'previewed', 'previewId': str(preview_id),
                                      'originalId': str(source_id), 'accountId': raw['accountId'], 'accountKind': raw['accountKind'],
                                      'accountRevision': raw['revision'], 'expiresAt': expiry['expires_at'], 'statement': parsed, 'comparison': plan,
                                      'externalAccountAssociation': 'user_declared_unverified', 'applySupported': True, 'financialEffect': 'none'})
            await conn.execute('INSERT INTO broker_statement_preview_operations(owner_id,request_id,request_hash,result) VALUES(%s,%s,%s,%s)', (who.id, request, request_hash, Jsonb(result)))
            await conn.execute('INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,%s,%s)', (who.id, 'broker.statement.preview', request))
            return result

    async def receipt(self, who, request):
        async with self.context(who) as conn:
            row = await (await conn.execute('SELECT result FROM broker_statement_preview_operations WHERE owner_id=%s AND request_id=%s', (who.id, identifier(request)))).fetchone()
            if not row:
                raise HTTPException(404, '本人原操作回执不存在')
            return row['result']

    async def close(self, who, request):
        request = identifier(request)
        async with self.context(who) as conn:
            await self.serialize(conn, who.id, request)
            prior = await (await conn.execute('SELECT result FROM broker_statement_preview_operations WHERE owner_id=%s AND request_id=%s', (who.id, request))).fetchone()
            if prior:
                return prior['result']
            result = {'requestId': str(request), 'state': 'closed', 'financialEffect': 'none'}
            await conn.execute('INSERT INTO broker_statement_preview_operations(owner_id,request_id,request_hash,result) VALUES(%s,%s,NULL,%s)', (who.id, request, Jsonb(result)))
            return result

    async def original_on_connection(self,conn,owner,source,*,received_proof=False):
        source=identifier(source)
        row=await(await conn.execute('SELECT source_bytes,source_sha256 FROM broker_statement_originals WHERE owner_id=%s AND id=%s',(owner,source))).fetchone()
        if not row:raise HTTPException(404,'本人账单原件不存在')
        received=await(await conn.execute("SELECT 1 FROM broker_statement_source_attempts WHERE owner_id=%s AND kind='fetch' AND public_result->>'responseOriginalId'=%s LIMIT 1",(owner,str(source)))).fetchone()
        if received and not received_proof:
            verified=await(await conn.execute("SELECT 1 FROM broker_statement_preview_operations WHERE owner_id=%s AND result->>'state'='previewed' AND result->>'originalId'=%s LIMIT 1",(owner,str(source)))).fetchone()
            if not verified:raise HTTPException(428,'未验证来源响应可能含私有配置，请验证当前密码后下载')
        import hashlib
        raw=bytes(row['source_bytes'])
        if hashlib.sha256(raw).hexdigest()!=row['source_sha256']:raise HTTPException(503,'账单原件校验失败')
        return raw,row['source_sha256']

    async def original(self, who, source):
        async with self.context(who) as conn:
            return await self.original_on_connection(conn,who.id,source)

    async def received_original(self,who,source,password,code=''):
        from .notification_security import NotificationSecurity
        async with self.context(who) as conn:
            await NotificationSecurity(self.db).passkeys.step_up(conn,who,password,code)
            return await self.original_on_connection(conn,who.id,source,received_proof=True)


async def purge_broker_statement_previews(conn, owner):
    marker = await (await conn.execute("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name='0093_broker_statement_previews.sql') AS installed")).fetchone()
    if not marker['installed']:
        relation = await (await conn.execute("SELECT to_regclass('public.broker_statement_previews') AS relation")).fetchone()
        if relation['relation'] is not None:
            raise HTTPException(503, '账单预览结构尚未完整核对')
        return
    await conn.execute('DELETE FROM broker_statement_previews WHERE owner_id=%s', (owner,))
