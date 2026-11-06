"""Explicit credential enrollment and one-shot Flex fetch, isolated from financial confirmation."""
import json
import re
from datetime import UTC, datetime
from uuid import uuid4, uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .broker_accounts import broker_account
from .broker_metadata import fingerprint
from .broker_statement_confirm import StatementConfirmation
from .broker_statements import identifier
from .connections import Vault
from .fx_reference import external_delivery_blocked


class BrokerStatementSources(StatementConfirmation):
    def targets(self, owner):
        from .broker_flex_transport import Target
        result = {}
        for raw in self.db.settings.broker_statement_targets:
            try:
                if raw['owner_id'] != owner or 'statement.fetch' not in raw['purposes'] or not raw['license_revision']:
                    continue
                until = datetime.fromisoformat(raw['valid_until'])
                if until.tzinfo is None or until <= datetime.now(UTC):
                    continue
                target = Target(addresses=tuple(raw['addresses']), id=raw['id'])
                target.validate()
                if target.id in result:
                    raise HTTPException(503, '固定账单来源标识重复，请核对安装配置')
                result[target.id] = (target, raw['license_revision'])
            except (KeyError, ValueError, TypeError):
                continue
        return result

    async def preview(self, who, raw):
        if isinstance(raw, dict) and isinstance(raw.get('accountId'), str):
            async with self.context(who) as conn:
                source = await self.source(conn, who.id, raw['accountId'])
                if source and source['external_account'] != raw.get('externalAccount'):
                    raise HTTPException(409, '账单与当前已登记的外部账户不一致')
        return await super().preview(who, raw)

    async def source_state(self, who, account_id):
        async with self.context(who) as conn:
            account = await broker_account(conn, who.id, account_id)
            source = await self.source(conn, who.id, account_id)
            return {'accountId': account_id, 'accountKind': account['account_kind'], 'accountRevision': account['revision'], 'connectionRevision': source['revision'] if source else 0, 'configured': bool(source and source['enabled']), 'externalAccount': source['external_account'] if source else None, 'targets': [{'id': key, 'label': '已许可 IBKR Flex 来源 · ' + key} for key in self.targets(who.id)], 'automaticFetch': False}

    async def source(self, conn, owner, account_id):
        return await (await conn.execute('SELECT * FROM broker_statement_sources WHERE owner_id=%s AND account_id=%s ORDER BY revision DESC LIMIT 1', (owner, account_id))).fetchone()

    async def advance_source_generation(self, conn, who, account_id):
        """Invalidate pending references inside the owner transaction, retaining history."""
        source = await self.source(conn, who.id, account_id)
        if source is None:
            return
        revision = source['revision'] + 1
        ciphertext = None
        if source['enabled']:
            vault = Vault(self.db.settings.connection_secret_dir)
            credentials = vault.decrypt(source['credentials_ciphertext'],
                                        f"broker-statement:{who.id}:{account_id}:{source['revision']}",
                                        source['origin_instance'])
            ciphertext = vault.encrypt(credentials, f"broker-statement:{who.id}:{account_id}:{revision}",
                                       source['origin_instance'])
        await conn.execute(
            'INSERT INTO broker_statement_sources(owner_id,account_id,revision,account_kind,origin_instance,'
            'target_id,target_fingerprint,license_revision,external_account,enabled,credentials_ciphertext) '
            'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
            (who.id, account_id, revision, source['account_kind'], source['origin_instance'],
             source['target_id'], source['target_fingerprint'], source['license_revision'],
             source['external_account'], source['enabled'], ciphertext),
        )

    async def prior(self, conn, owner, request, request_hash=None):
        attempt = await (await conn.execute('SELECT * FROM broker_statement_source_attempts WHERE owner_id=%s AND request_id=%s', (owner, request))).fetchone()
        if not attempt:
            return None
        if request_hash is not None and attempt['request_hash'] is not None and attempt['request_hash'] != request_hash:
            raise HTTPException(409, '原操作编号已用于其他来源操作')
        result = await (await conn.execute('SELECT public_result FROM broker_statement_source_results WHERE owner_id=%s AND request_id=%s', (owner, request))).fetchone()
        projected = dict(result['public_result'] if result else attempt['public_result'])
        if attempt['kind']=='fetch':
            retained=await(await conn.execute('SELECT id FROM broker_statement_originals WHERE owner_id=%s AND id=%s',(owner,uuid5(identifier(request),'received-flex-response')))).fetchone()
            if retained and projected.get('state')!='previewed':projected['responseOriginalId']=str(retained['id'])
        return projected

    async def configure_source(self, who, account_id, raw):
        fields = {'requestId', 'accountKind', 'accountRevision', 'connectionRevision', 'targetId', 'externalAccount', 'queryId', 'token'}
        if not isinstance(raw, dict) or set(raw) != fields:
            raise HTTPException(422, '来源配置字段无效')
        request = identifier(raw['requestId'])
        if (raw['accountKind'] not in ('real', 'simulated') or type(raw['accountRevision']) is not int or raw['accountRevision'] < 1
                or type(raw['connectionRevision']) is not int or raw['connectionRevision'] < 0
                or not isinstance(raw['externalAccount'], str) or not re.fullmatch(r'[A-Za-z0-9-]{2,40}', raw['externalAccount'])
                or not isinstance(raw['queryId'], str) or not re.fullmatch(r'[0-9]{1,20}', raw['queryId'])
                or not isinstance(raw['token'], str) or not re.fullmatch(r'[A-Za-z0-9]{10,256}', raw['token']) or not isinstance(raw['targetId'], str)):
            raise HTTPException(422, '来源账户、版本或凭据格式无效')
        request_hash = fingerprint({'accountId': account_id, **raw})
        async with self.context(who) as conn:
            await self.serialize(conn, who.id, request)
            if prior := await self.prior(conn, who.id, request, request_hash):
                return prior
            account = await broker_account(conn, who.id, account_id)
            previous = await self.source(conn, who.id, account_id)
            if account['account_kind'] != raw['accountKind'] or account['revision'] != raw['accountRevision'] or (previous['revision'] if previous else 0) != raw['connectionRevision']:
                raise HTTPException(409, '账户或来源版本已变化')
            imported = await (await conn.execute('SELECT external_account FROM broker_statement_imports WHERE owner_id=%s AND account_id=%s ORDER BY to_date DESC,created_at DESC LIMIT 1', (who.id, account_id))).fetchone()
            if imported and imported['external_account'] != raw['externalAccount']:
                raise HTTPException(409, '账户已有官方账单历史，不能改换外部账户关联')
            selected = self.targets(who.id).get(raw['targetId'])
            if not selected:
                raise HTTPException(403, '尚未安装本人已许可的固定 IBKR 来源')
            target, license_revision = selected
            revision = raw['connectionRevision'] + 1
            instance = (await (await conn.execute('SELECT instance_id FROM alcor_instance WHERE singleton')).fetchone())['instance_id']
            vault = Vault(self.db.settings.connection_secret_dir)
            cipher = vault.encrypt(json.dumps({'token': raw['token'], 'queryId': raw['queryId']}), f'broker-statement:{who.id}:{account_id}:{revision}', instance)
            await conn.execute('INSERT INTO broker_statement_sources(owner_id,account_id,revision,account_kind,origin_instance,target_id,target_fingerprint,license_revision,external_account,credentials_ciphertext) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', (who.id, account_id, revision, account['account_kind'], instance, target.id, target.fingerprint, license_revision, raw['externalAccount'], cipher))
            await conn.execute('UPDATE broker_accounts SET revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s', (who.id, account_id))
            await conn.execute('INSERT INTO broker_account_collections(owner_id,revision) VALUES(%s,1) ON CONFLICT(owner_id) DO UPDATE SET revision=broker_account_collections.revision+1', (who.id,))
            result = {'requestId': str(request), 'state': 'configured', 'accountId': account_id, 'connectionRevision': revision, 'accountRevision': account['revision'] + 1, 'externalAccount': raw['externalAccount']}
            await conn.execute("INSERT INTO broker_statement_source_attempts(owner_id,request_id,request_hash,account_id,source_revision,kind,public_result) VALUES(%s,%s,%s,%s,%s,'configure',%s)", (who.id, request, request_hash, account_id, revision, Jsonb(result)))
            await conn.execute('INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)', (who.id, 'broker.statement.source.configure', account_id, request))
            return result

    async def fetch_source(self, who, account_id, raw):
        return await self._fetch_source(who, account_id, raw)

    async def legacy_fetch_source(self, who, account_id):
        return await self._fetch_source(who, account_id, None, legacy=True)

    async def _fetch_source(self, who, account_id, raw, *, legacy=False):
        if legacy:
            raw = {'requestId': str(uuid4()), 'connectionRevision': 1}
        if not isinstance(raw, dict) or set(raw) - {'requestId', 'connectionRevision', 'previousRequestId'} or not {'requestId', 'connectionRevision'} <= set(raw) or type(raw['connectionRevision']) is not int or raw['connectionRevision'] < 1:
            raise HTTPException(422, '账单获取字段无效')
        request = identifier(raw['requestId']); request_hash = fingerprint({'accountId': account_id, **raw})
        reference = None
        async with self.context(who) as conn:
            await self.serialize(conn, who.id, request)
            if prior := await self.prior(conn, who.id, request, request_hash):
                return prior
            account = await broker_account(conn, who.id, account_id)
            source = await self.source(conn, who.id, account_id)
            authorization_binding = await self.binding(conn, who)
            if legacy and source:
                raw['connectionRevision'] = source['revision']
                latest_attempt = await (await conn.execute("SELECT a.request_id,a.authorization_binding,a.public_result AS admitted,r.public_result AS finished,r.provider_reference FROM broker_statement_source_attempts a LEFT JOIN broker_statement_source_results r USING(owner_id,request_id) WHERE a.owner_id=%s AND a.account_id=%s AND a.source_revision=%s AND a.kind='fetch' ORDER BY a.created_at DESC,a.request_id DESC LIMIT 1", (who.id, account_id, source['revision']))).fetchone()
                if latest_attempt:
                    previous_result = latest_attempt['finished'] or latest_attempt['admitted']
                    if previous_result.get('state') in ('unknown', 'pending'):
                        if latest_attempt['authorization_binding'] != authorization_binding:
                            raise HTTPException(409, '该来源存在其他会话的待核对获取任务，未执行新请求')
                        if previous_result.get('state') == 'unknown' or not latest_attempt['provider_reference']:
                            return previous_result
                        raw['previousRequestId'] = str(latest_attempt['request_id'])
                request_hash = fingerprint({'accountId': account_id, 'legacy': True, **raw})
            if await external_delivery_blocked(conn):
                raise HTTPException(503, '恢复隔离期间不执行外部账单获取')
            if not source or not source['enabled'] or source['revision'] != raw['connectionRevision'] or source['account_kind'] != account['account_kind']:
                raise HTTPException(409, '来源或账户版本已变化')
            instance = (await (await conn.execute('SELECT instance_id FROM alcor_instance WHERE singleton')).fetchone())['instance_id']
            selected = self.targets(who.id).get(source['target_id'])
            if source['origin_instance'] != instance or not selected or selected[0].fingerprint != source['target_fingerprint'] or selected[1] != source['license_revision']:
                raise HTTPException(403, '来源许可或实例已变化，请重新配置')
            if 'previousRequestId' in raw:
                previous = await (await conn.execute('SELECT a.account_id,a.source_revision,r.provider_reference,r.public_result FROM broker_statement_source_attempts a JOIN broker_statement_source_results r USING(owner_id,request_id) WHERE a.owner_id=%s AND a.request_id=%s', (who.id, identifier(raw['previousRequestId'])))).fetchone()
                if not previous or previous['account_id'] != account_id or previous['source_revision'] != source['revision'] or previous['public_result'].get('state') != 'pending' or not previous['provider_reference']:
                    raise HTTPException(409, '原请求没有可继续的同来源生成任务')
                reference = previous['provider_reference']
            credentials = json.loads(Vault(self.db.settings.connection_secret_dir).decrypt(source['credentials_ciphertext'], f"broker-statement:{who.id}:{account_id}:{source['revision']}", instance))
            admitted = {'requestId': str(request), 'state': 'unknown', 'accountId': account_id, 'connectionRevision': source['revision'], 'responseOriginalId': str(uuid5(request,'received-flex-response')), 'message': '外部请求已登记，等待原操作回执'}
            await conn.execute("INSERT INTO broker_statement_source_attempts(owner_id,request_id,request_hash,account_id,source_revision,authorization_binding,kind,public_result) VALUES(%s,%s,%s,%s,%s,%s,'fetch',%s)", (who.id, request, request_hash, account_id, source['revision'], authorization_binding, Jsonb(admitted)))
            await conn.execute('INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)', (who.id, 'broker.statement.fetch.admitted', account_id, request))
        # Admission is durable before provider IO: reconnecting the same UUID never repeats it.
        from .broker_flex_transport import Transport
        reply = None
        result = dict(admitted)
        try:
            reply = await Transport().request(credentials['token'], credentials['queryId'], reference=reference, target=selected[0])
            await self._retain_received_response(who.id,request,request_hash,account,source,reply,authorization_binding)
            if reply.state == 'statement' and reply.complete:
                async with self.context(who) as conn:
                    latest = await self.source(conn, who.id, account_id)
                    allowed = self.targets(who.id).get(source['target_id'])
                    if (not latest or not latest['enabled'] or latest['revision'] != source['revision'] or not allowed
                            or allowed[0].fingerprint != source['target_fingerprint'] or allowed[1] != source['license_revision']
                            or await external_delivery_blocked(conn)):
                        raise HTTPException(403, '来源许可已变化，原响应仅保留为不可用历史')
                result = await self.preview(who, {'requestId': str(request), 'accountId': account_id, 'accountKind': account['account_kind'], 'revision': account['revision'], 'externalAccount': source['external_account'], 'xml': reply.raw.decode('utf-8', errors='strict')})
            elif reply.state == 'pending':
                result = {'requestId': str(request), 'state': 'pending', 'accountId': account_id, 'connectionRevision': source['revision'], 'retryAfterSeconds': 15, 'message': '账单尚在生成，可稍后主动继续获取'}
            elif reply.state == 'rejected':
                result = {'requestId': str(request), 'state': 'rejected', 'message': 'IBKR 凭据或查询配置无效，请重新配置'}
        except Exception:  # noqa: BLE001 - provider errors can contain credentials
            # No URL, token, provider text or connection details leave the boundary.
            result = dict(admitted)
        # Authorization revocation stops projection, never archival of the already
        # admitted private response. This connection cannot initiate another request.
        try:
            async with self.context(who) as conn:
                current = await self.source(conn, who.id, account_id)
                allowed = self.targets(who.id).get(source['target_id'])
                if (not current or not current['enabled'] or current['revision'] != source['revision'] or not allowed
                        or allowed[0].fingerprint != source['target_fingerprint'] or allowed[1] != source['license_revision']
                        or await external_delivery_blocked(conn)):
                    result = dict(admitted)
        except HTTPException:
            result = dict(admitted)
        async with self.db.connection() as conn,conn.transaction():
            await self.serialize(conn, who.id, request)
            instance=(await(await conn.execute('SELECT instance_id FROM alcor_instance WHERE singleton')).fetchone())['instance_id']
            if source['origin_instance']!=self.db.settings.instance_id or source['origin_instance']!=instance:raise HTTPException(409,'原响应所属实例已变化，未归入新实例')
            attempt=await(await conn.execute("SELECT * FROM broker_statement_source_attempts WHERE owner_id=%s AND request_id=%s AND kind='fetch'",(who.id,request))).fetchone()
            if not attempt or attempt['request_hash']!=request_hash or attempt['account_id']!=account_id or attempt['source_revision']!=source['revision'] or attempt['authorization_binding']!=authorization_binding:
                raise HTTPException(409,'原响应入场归属不一致')
            if legacy:result = {**result, 'legacyRequestIdGenerated': True}
            retained=await(await conn.execute('SELECT id FROM broker_statement_originals WHERE owner_id=%s AND id=%s',(who.id,uuid5(request,'received-flex-response')))).fetchone()
            if retained and result.get('state')!='previewed':result={**result,'responseOriginalId':str(retained['id'])}
            await conn.execute('INSERT INTO broker_statement_source_results(owner_id,request_id,public_result,provider_reference,raw_response,http_status,response_complete) VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(owner_id,request_id) DO NOTHING', (who.id, request, Jsonb(result), reply.reference if reply else None, reply.raw if reply else None, reply.http_status if reply else None, reply.complete if reply else False))
            return await self.prior(conn,who.id,request,request_hash)

    async def _retain_received_response(self,owner,request,request_hash,account,source,reply,authorization_binding):
        if not reply.raw:return
        import hashlib
        # Untrusted source bytes are not parsed facts. Ownership is fixed by the
        # immutable pre-IO admission and original source revision, not current who.
        async with self.db.connection() as conn,conn.transaction():
            bound=await(await conn.execute("""SELECT s.account_kind,s.origin_instance,s.external_account,s.target_fingerprint,s.license_revision,s.revision,a.authorization_binding
                FROM broker_statement_source_attempts a JOIN broker_statement_sources s
                ON s.owner_id=a.owner_id AND s.account_id=a.account_id AND s.revision=a.source_revision
                WHERE a.owner_id=%s AND a.request_id=%s AND a.request_hash=%s AND a.kind='fetch' AND a.account_id=%s""",
                (owner,request,request_hash,account['id']))).fetchone()
            instance=(await(await conn.execute('SELECT instance_id FROM alcor_instance WHERE singleton')).fetchone())['instance_id']
            if not bound or bound['origin_instance']!=self.db.settings.instance_id or bound['origin_instance']!=instance or bound['revision']!=source['revision'] or bound['authorization_binding']!=authorization_binding or any(bound[key]!=source[key] for key in ('account_kind','origin_instance','external_account','target_fingerprint','license_revision')) or bound['account_kind']!=account['account_kind']:
                raise HTTPException(409,'原响应与已入场来源、实例及账本归属不一致')
            await conn.execute("INSERT INTO broker_statement_originals(owner_id,id,account_id,account_kind,provider,external_account,source_sha256,source_bytes) VALUES(%s,%s,%s,%s,'ibkr',%s,%s,%s) ON CONFLICT(owner_id,id) DO NOTHING",
                (owner,uuid5(request,'received-flex-response'),account['id'],bound['account_kind'],bound['external_account'],hashlib.sha256(reply.raw).hexdigest(),reply.raw))

    async def source_receipt(self, who, request):
        async with self.context(who) as conn:
            result = await self.prior(conn, who.id, identifier(request))
            if result is None:
                raise HTTPException(404, '本人来源操作不存在')
            return result

    async def close_source(self, who, request):
        request = identifier(request)
        async with self.context(who) as conn:
            await self.serialize(conn, who.id, request)
            if result := await self.prior(conn, who.id, request):
                return result
            result = {'requestId': str(request), 'state': 'closed', 'executed': False}
            await conn.execute("INSERT INTO broker_statement_source_attempts(owner_id,request_id,kind,public_result) VALUES(%s,%s,'closed',%s)", (who.id, request, Jsonb(result)))
            return result


    async def disable_source(self, who, account_id, raw):
        if not isinstance(raw, dict) or set(raw) != {'requestId', 'connectionRevision', 'accountRevision'} or any(type(raw[k]) is not int or raw[k] < 1 for k in ('connectionRevision', 'accountRevision')):
            raise HTTPException(422, '来源停用字段无效')
        request = identifier(raw['requestId']); request_hash = fingerprint({'action': 'disable', 'accountId': account_id, **raw})
        async with self.context(who) as conn:
            await self.serialize(conn, who.id, request)
            if prior := await self.prior(conn, who.id, request, request_hash):
                return prior
            account = await broker_account(conn, who.id, account_id)
            source = await self.source(conn, who.id, account_id)
            if not source or source['revision'] != raw['connectionRevision'] or account['revision'] != raw['accountRevision']:
                raise HTTPException(409, '账户或来源已变化，请重新核对')
            revision = source['revision'] + 1
            await conn.execute('INSERT INTO broker_statement_sources(owner_id,account_id,revision,account_kind,origin_instance,target_id,target_fingerprint,license_revision,external_account,enabled,credentials_ciphertext) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,false,NULL)', (who.id, account_id, revision, source['account_kind'], source['origin_instance'], source['target_id'], source['target_fingerprint'], source['license_revision'], source['external_account']))
            await conn.execute('UPDATE broker_accounts SET revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s', (who.id, account_id))
            await conn.execute('INSERT INTO broker_account_collections(owner_id,revision) VALUES(%s,1) ON CONFLICT(owner_id) DO UPDATE SET revision=broker_account_collections.revision+1', (who.id,))
            result = {'requestId': str(request), 'state': 'disabled', 'accountId': account_id, 'connectionRevision': revision, 'accountRevision': account['revision'] + 1, 'historyRetained': True}
            await conn.execute("INSERT INTO broker_statement_source_attempts(owner_id,request_id,request_hash,account_id,source_revision,kind,public_result) VALUES(%s,%s,%s,%s,%s,'configure',%s)", (who.id, request, request_hash, account_id, revision, Jsonb(result)))
            await conn.execute('INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)', (who.id, 'broker.statement.source.disabled', account_id, request))
            return result
