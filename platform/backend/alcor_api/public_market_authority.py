"""Public publication licenses, isolated from every personal market grant."""
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .fx_reference import external_delivery_blocked
from .market_authority import query_from
from .market_contract import Query, digest, installed_latest_semantics
from .notification_security import NotificationSecurity
from .security import lock_mutation_identity


@dataclass(frozen=True)
class PublicPolicy:
    id: str
    source: str
    source_version: str
    target_id: str
    target_fingerprint: str
    license_revision: str
    license_evidence_sha256: str
    instance_id: str
    valid_from: str
    valid_until: str
    symbols: tuple[tuple[str, str, str, str], ...]
    purposes: tuple[str, ...]
    fixture: bool = False

    @property
    def markets(self):
        return tuple(sorted({symbol[0] for symbol in self.symbols}))

    @property
    def source_symbols(self):
        return ()

    @property
    def fingerprint(self):
        return digest(asdict(self))


def instant(value):
    result = datetime.fromisoformat(value) if isinstance(value, str) else value
    if not isinstance(result, datetime) or result.tzinfo is None:
        raise ValueError('public_license_timezone_required')
    return result.astimezone(UTC)


class PublicAuthority:
    def __init__(self, db, policies=(), policy_provider=None):
        self.db, self.policies, self.policy_provider = db, tuple(policies), policy_provider

    def policy(self, policy_id):
        values = self.policy_provider() if self.policy_provider else self.policies
        matches = [p if isinstance(p, PublicPolicy) else PublicPolicy(**p) for p in values if (p.id if isinstance(p, PublicPolicy) else p.get('id')) == policy_id]
        if len(matches) != 1:
            raise HTTPException(503, '公共行情许可未安装或不唯一')
        p = matches[0]
        try:
            if (not all(isinstance(x, str) and x for x in (p.id,p.source,p.source_version,p.target_id,p.target_fingerprint,p.license_revision,p.license_evidence_sha256,p.instance_id))
                    or len(p.license_evidence_sha256) != 64 or any(c not in '0123456789abcdef' for c in p.license_evidence_sha256)
                    or not p.symbols or len(p.symbols) > 10000 or len(set(map(tuple,p.symbols))) != len(p.symbols)
                    or not p.purposes or not set(p.purposes) <= {'collect','display'}
                    or instant(p.valid_from) >= instant(p.valid_until)
                    or str(p.instance_id) != str(self.db.settings.instance_id)
                    or (p.fixture and self.db.settings.environment != 'test')):
                raise ValueError('invalid_public_policy')
            for symbol in p.symbols:
                if len(symbol) != 4:
                    raise ValueError('invalid_public_symbol')
                market, code, instrument, session = symbol
                Query(kind='latest',market=market,code=code,instrument=instrument,session=session).validate()
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(503, '公共行情许可无效') from None
        return p

    async def lock(self, conn, license_id):
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('public-market-license:'+str(license_id),))

    async def current(self, conn, license_id, purpose, query=None):
        try: license_id = UUID(str(license_id))
        except (ValueError, TypeError): raise HTTPException(400, '公共许可编号无效') from None
        if purpose not in ('collect','display'):
            raise HTTPException(400, '公共许可用途无效')
        await self.lock(conn, license_id)
        row = await (await conn.execute('SELECT * FROM public_market_licenses WHERE id=%s', (license_id,))).fetchone()
        if not row: raise HTTPException(404, '公共许可不存在')
        p = self.policy(row['policy_id'])
        database = await (await conn.execute('SELECT instance_id FROM alcor_instance WHERE singleton')).fetchone()
        now = (await (await conn.execute('SELECT clock_timestamp() AS now')).fetchone())['now']
        if (not database or str(database['instance_id']) != str(p.instance_id)
                or str(row['origin_instance']) != str(p.instance_id)
                or row['policy_fingerprint'] != p.fingerprint or row['license_revision'] != p.license_revision
                or purpose not in p.purposes or not instant(p.valid_from) <= now < instant(p.valid_until)
                or await (await conn.execute('SELECT 1 FROM public_market_revocations WHERE license_id=%s',(license_id,))).fetchone()):
            raise HTTPException(403, '公共行情许可已失效或撤销')
        if purpose == 'collect' and await external_delivery_blocked(conn):
            raise HTTPException(403, '恢复隔离禁止公共行情采集')
        if query is not None:
            q = query if isinstance(query, Query) else query_from(query)
            try:
                q.validate()
            except (ValueError, TypeError):
                raise HTTPException(403, '公共许可不支持此查询口径') from None
            from .market_crypto_latest import VERSION as CRYPTO_VERSION
            from .market_crypto_latest import installed as crypto_installed
            from .market_yahoo_history import VERSION as YAHOO_VERSION
            from .market_yahoo_history import installed as yahoo_installed
            supported = (
                p.source == 'yahoo' and p.source_version == YAHOO_VERSION and yahoo_installed(q,p)
                or p.source == 'coingecko' and p.source_version == CRYPTO_VERSION and crypto_installed(q)
                or p.source == 'futu' and p.source_version == 'futu-sdk-records-v1' and installed_latest_semantics(q)
                or p.fixture and self.db.settings.environment == 'test'
            )
            if (q.kind != 'latest' or q.frame != 'latest' or q.adjust != 'none'
                    or q.start is not None or q.through is not None or not supported):
                raise HTTPException(403, '公共许可仅支持已安装的最新报价口径')
            if (q.market,q.code,q.instrument,q.session) not in tuple(map(tuple,p.symbols)):
                raise HTTPException(403, '证券或时段不在公共许可范围')
        return row, p

    async def _admin(self, conn, who):
        await lock_mutation_identity(conn, who)
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('public-market-admin:'+who.id,))

    async def _mutation(self, who, rid, action, value, password, code):
        try: rid = UUID(str(rid))
        except (ValueError,TypeError): raise HTTPException(422, '需要原请求UUID') from None
        hashed = digest({'action':action,'value':value})
        async with self.db.connection() as conn, conn.transaction():
            await self._admin(conn,who)
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('public-market-request:'+str(rid),))
            prior = await (await conn.execute('SELECT * FROM public_market_receipts WHERE request_id=%s',(rid,))).fetchone()
            if prior:
                if prior['created_by'] != who.id or prior['request_hash'] != hashed: raise HTTPException(409, '原UUID已用于其他请求')
                return prior['result']
            await NotificationSecurity(self.db).passkeys.step_up(conn,who,password,code)
            if action == 'install':
                p = self.policy(value['policyId'])
                now = (await (await conn.execute('SELECT clock_timestamp() AS now')).fetchone())['now']
                if not instant(p.valid_from) <= now < instant(p.valid_until): raise HTTPException(403,'公共许可尚未生效或已过期')
                identifier = uuid4()
                await self.lock(conn,identifier)
                await conn.execute('INSERT INTO public_market_licenses(id,policy_id,policy_fingerprint,license_revision,origin_instance,created_by) VALUES(%s,%s,%s,%s,%s,%s)',(identifier,p.id,p.fingerprint,p.license_revision,p.instance_id,who.id))
                result = {'state':'installed','requestId':str(rid),'licenseId':str(identifier),'policyFingerprint':p.fingerprint}
            else:
                identifier = UUID(value['licenseId'])
                if action == 'revoke':
                    await self.lock(conn,identifier)
                    if not await (await conn.execute('SELECT 1 FROM public_market_licenses WHERE id=%s',(identifier,))).fetchone(): raise HTTPException(404,'公共许可不存在')
                    await conn.execute('INSERT INTO public_market_revocations(license_id,request_id,created_by) VALUES(%s,%s,%s) ON CONFLICT(license_id) DO NOTHING',(identifier,rid,who.id))
                    result = {'state':'revoked','requestId':str(rid),'licenseId':str(identifier)}
                else:
                    q = query_from(value['query'])
                    await self.current(conn,identifier,'collect',q)
                    task = uuid4()
                    await conn.execute('INSERT INTO public_market_tasks(id,request_id,license_id,query) VALUES(%s,%s,%s,%s)',(task,rid,identifier,Jsonb(asdict(q))))
                    result = {'state':'queued','requestId':str(rid),'taskId':str(task),'licenseId':str(identifier)}
            await conn.execute('INSERT INTO public_market_receipts(request_id,request_hash,result,created_by) VALUES(%s,%s,%s,%s)',(rid,hashed,Jsonb(result),who.id))
            return result

    async def install(self, who, rid, policy_id, password, code=''):
        return await self._mutation(who,rid,'install',{'policyId':policy_id},password,code)

    async def revoke(self, who, rid, license_id, password, code=''):
        return await self._mutation(who,rid,'revoke',{'licenseId':str(license_id)},password,code)

    async def enqueue(self, who, rid, license_id, query, password, code=''):
        q = query if isinstance(query,Query) else query_from(query)
        return await self._mutation(who,rid,'enqueue',{'licenseId':str(license_id),'query':asdict(q)},password,code)

    async def receipt(self, who, rid):
        async with self.db.connection() as conn, conn.transaction():
            await self._admin(conn,who)
            row = await (await conn.execute('SELECT result FROM public_market_receipts WHERE request_id=%s AND created_by=%s',(UUID(str(rid)),who.id))).fetchone()
            if not row: raise HTTPException(404,'公共行情回执不存在')
            result = dict(row['result'])
            if result.get('taskId'):
                task = await (await conn.execute('''SELECT t.status,t.error_code,p.id AS page_id,p.raw_sha256
                    FROM public_market_tasks t LEFT JOIN public_market_pages p ON p.task_id=t.id
                    WHERE t.id=%s AND t.request_id=%s AND t.license_id=%s''',
                    (UUID(result['taskId']),UUID(str(rid)),UUID(result['licenseId'])))).fetchone()
                if not task:
                    raise HTTPException(503, '公共行情任务回执链不完整')
                page_id = str(task['page_id']) if task['page_id'] else None
                result['execution'] = {
                    'state': task['status'], 'errorCode': task['error_code'],
                    'sourcePageId': page_id, 'sourceSha256': task['raw_sha256'],
                    'originalDownloadPath': '/api/system/public-market/originals/'+page_id if page_id else None,
                    'willRetryAutomatically': False,
                }
            return result
