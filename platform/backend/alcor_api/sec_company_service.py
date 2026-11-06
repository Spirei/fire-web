"""Explicit licensed SEC acquisition; immutable original pages and UUID receipts."""

import asyncio
from hashlib import sha256
from uuid import UUID, uuid4

import httpcore
from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .fx_reference import external_delivery_blocked
from .sec_company_curated import CURATED, INDUSTRY_ZH, KNOWN_CIK
from .sec_company_protocol import PURPOSE, SOURCE, Target, canonical, company_directory, submissions, ticker
from .sec_company_transport import PageFailure, Transport
from .security import lock_mutation_identity


class CompanyProfiles:
    source_version = SOURCE
    purpose = PURPOSE
    target_type = Target
    receipt_table = 'sec_company_receipts'
    page_table = 'sec_company_pages'
    document_kind = 'submissions'
    capture_scope = 'company_metadata_only'

    def normalize_code(self, value):
        return ticker(value)

    def known_entry(self, code):
        known = KNOWN_CIK.get(code)
        return {'cik': known['cik'], 'title': known['title'], 'ticker': code} if known else None

    def directory_entry(self, raw, code):
        return company_directory(raw).get(code)

    def project_document(self, raw, entry, symbol):
        return project(submissions(raw, entry), entry)

    def __init__(self, authority, targets=(), transport=None):
        self.authority = authority
        self.db = authority.db
        self.targets = tuple(targets)
        self.transport = transport or Transport()

    def target(self, policy):
        matches = [target for target in self.targets if isinstance(target, self.target_type) and target.id == policy.target_id]
        if (policy.source != 'sec' or policy.source_version != self.source_version or policy.fixture
                or self.purpose not in policy.purposes or 'US' not in policy.markets
                or len(matches) != 1 or matches[0].fingerprint != policy.target_fingerprint):
            raise HTTPException(503, 'SEC公司资料来源尚未安装或许可不匹配')
        return matches[0]

    async def collect(self, who, request_id, source_revision, code):
        symbol = self.normalize_code(code)
        rid, revision = UUID(str(request_id)), UUID(str(source_revision))
        operation = {'sourceRevision': str(revision), 'ticker': symbol}
        fingerprint = sha256(canonical(operation).encode()).hexdigest()
        async with self.db.connection() as conn, conn.transaction():
            if getattr(who, 'native_client', False) or getattr(who, 'grant_id', None) or getattr(who, 'legacy_client', False):
                raise HTTPException(403, 'SEC来源采集仅限Web管理会话')
            await lock_mutation_identity(conn, who, require_admin=True)
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('sec-operation:'+who.id+str(rid),))
            prior = await (await conn.execute(f'SELECT * FROM {self.receipt_table} WHERE owner_id=%s AND request_id=%s', (who.id,rid))).fetchone()
            if prior:
                if prior['fingerprint'] != fingerprint:
                    raise HTTPException(409, '原请求编号已用于不同操作')
                return prior['result']
            admission = await (await conn.execute('SELECT * FROM sec_acquisition_admissions WHERE owner_id=%s AND request_id=%s', (who.id,rid))).fetchone()
            if admission:
                if admission['source_version'] != self.source_version or admission['fingerprint'] != fingerprint:
                    raise HTTPException(409, '原请求编号已用于不同操作')
                return admission['result']
            _, policy = await self.authority.config(conn, who.id, revision)
            self.target(policy)
            if await external_delivery_blocked(conn):
                raise HTTPException(503, '恢复环境尚未允许外部采集')
            unknown = {'state':'unknown','requestId':str(rid),'sourceRevision':str(revision),
                       'market':'US','code':symbol,'retryAllowed':False,'captureScope':self.capture_scope}
            await conn.execute("""INSERT INTO sec_acquisition_admissions(owner_id,request_id,source_version,fingerprint,result)
                VALUES(%s,%s,%s,%s,%s)""", (who.id,rid,self.source_version,fingerprint,Jsonb(unknown)))
        # Durable admission commits before external IO: crashes never permit a same-UUID refetch.
        return await self._collect_admitted(who, rid, revision, symbol)

    async def _collect_admitted(self, who, request_id, source_revision, code):
        code = self.normalize_code(code)
        request_id, source_revision = UUID(str(request_id)), UUID(str(source_revision))
        operation = {'sourceRevision': str(source_revision), 'ticker': code}
        fingerprint = sha256(canonical(operation).encode()).hexdigest()
        async with self.db.connection() as conn, conn.transaction():
            # Role alone never grants native/legacy App management authority.
            if getattr(who, 'native_client', False) or getattr(who, 'grant_id', None) or getattr(who, 'legacy_client', False):
                raise HTTPException(403, 'SEC来源采集仅限Web管理会话')
            await lock_mutation_identity(conn, who, require_admin=True)
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('sec-operation:'+who.id+str(request_id),))
            prior = await (await conn.execute(f'SELECT DISTINCT ON(source_revision) * FROM {self.receipt_table} WHERE owner_id=%s AND request_id=%s', (who.id, request_id))).fetchone()
            if prior:
                if prior['fingerprint'] != fingerprint:
                    raise HTTPException(409, '原请求编号已用于不同操作')
                return prior['result']
            config, policy = await self.authority.config(conn, who.id, source_revision)
            target = self.target(policy)
            if await external_delivery_blocked(conn):
                raise HTTPException(503, '恢复环境尚未允许外部采集')
            # Instance-wide serial budget, including both SEC hosts, no retries.
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('sec-acquisition-budget',0))")
            pages, result = [], {'state': 'unknown', 'code': code, 'market': 'US', 'source': 'SEC EDGAR'}
            entry = self.known_entry(code)
            cik = entry['cik'] if entry else None
            try:
                for kind in ((self.document_kind,) if entry else ('directory', self.document_kind)):
                    await asyncio.sleep(0.2)
                    raw = await self.transport.read(target, cik)
                    page_id = uuid4()
                    pages.append((page_id, kind, cik, 200, raw, True))
                    if kind == 'directory':
                        entry = self.directory_entry(raw, code)
                        if entry is None:
                            result['state'] = 'not_found_in_directory'
                            break
                        cik = entry['cik']
                    else:
                        result.update(state='observed', cik=cik, profile=self.project_document(raw, entry, code), sourcePageId=str(page_id))
            except PageFailure as exc:
                pages.append((uuid4(), kind, cik, exc.status, exc.raw, exc.complete))
                result.update(state='partial', error='sec_http_or_page_budget', pageComplete=exc.complete)
            except (ValueError, TypeError, RecursionError, OverflowError, TimeoutError, OSError, httpcore.NetworkError, httpcore.ProtocolError, httpcore.TimeoutException):
                result.update(state='partial' if pages else 'unknown', error='sec_source_unavailable_or_invalid')
            # Never expose source output following concurrent identity/license withdrawal.
            await lock_mutation_identity(conn, who, require_admin=True)
            _, current = await self.authority.config(conn, who.id, source_revision)
            if current.fingerprint != policy.fingerprint or self.target(current).fingerprint != target.fingerprint:
                raise HTTPException(409, 'SEC来源许可已变化')
            result.update(requestId=str(request_id), sourceRevision=str(source_revision), licenseRevision=policy.license_revision,
                          pageIds=[str(page[0]) for page in pages], captureScope=self.capture_scope, fullFilingHistoryVerified=False)
            await conn.execute(f'''INSERT INTO {self.receipt_table}(owner_id,request_id,source_revision,origin_instance,session_version,
                policy_fingerprint,license_revision,ticker,fingerprint,result) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (who.id, request_id, source_revision, config['origin_instance'], config['session_version'], policy.fingerprint,
                 policy.license_revision, code, fingerprint, Jsonb(result)))
            for page_id, kind, cik, status, raw, complete in pages:
                await conn.execute(f'''INSERT INTO {self.page_table}(owner_id,request_id,id,kind,cik,http_status,raw_bytes,raw_sha256,complete,representation)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,'http_response_body')''',
                    (who.id, request_id, page_id, kind, cik, status, raw, sha256(raw).hexdigest(), complete))
            return result

    async def verify_observation(self, conn, who, row, policy):
        result = row['result']
        if result.get('state') != 'observed':
            return
        try:
            if (row['policy_fingerprint'] != policy.fingerprint or row['license_revision'] != policy.license_revision
                    or str(row['origin_instance']) != str(self.db.settings.instance_id)
                    or result['sourceRevision'] != str(row['source_revision'])
                    or result['licenseRevision'] != row['license_revision']
                    or result['requestId'] != str(row['request_id'])):
                raise ValueError()
            pages = await (await conn.execute(f'SELECT * FROM {self.page_table} WHERE owner_id=%s AND request_id=%s ORDER BY id LIMIT 4',
                                               (who.id,row['request_id']))).fetchall()
            if not 1 <= len(pages) <= 2 or {str(page['id']) for page in pages} != set(result['pageIds']):
                raise ValueError()
            for page in pages:
                if (page['http_status'] != 200 or not page['complete']
                        or sha256(bytes(page['raw_bytes'])).hexdigest() != page['raw_sha256']):
                    raise ValueError()
            directory = [page for page in pages if page['kind'] == 'directory']
            entry = self.directory_entry(bytes(directory[0]['raw_bytes']),row['ticker']) if len(directory) == 1 else self.known_entry(row['ticker'])
            documents = [page for page in pages if page['kind'] == self.document_kind and str(page['id']) == result['sourcePageId']]
            if not entry or len(documents) != 1 or documents[0]['cik'] != entry['cik']:
                raise ValueError()
            projected = self.project_document(bytes(documents[0]['raw_bytes']),entry,row['ticker'])
            if canonical(projected) != canonical(result['profile']):
                raise ValueError()
        except (ValueError,TypeError,KeyError,OverflowError,RecursionError,UnicodeError):
            raise HTTPException(503,'SEC资料与保留原件无法核对') from None

    async def read(self, who, code=None, request_id=None, source_revision=None):
        code = self.normalize_code(code) if code is not None else None
        request_id = UUID(str(request_id)) if request_id is not None else None
        revision = UUID(str(source_revision)) if source_revision is not None else None
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            await lock_mutation_identity(conn, who, require_admin=False)
            await self.authority.authorize_read(conn, who)
            rows = await (await conn.execute(f"""SELECT DISTINCT ON(source_revision) * FROM {self.receipt_table} WHERE owner_id=%s
                AND (%s::text IS NULL OR ticker=%s) AND (%s::uuid IS NULL OR request_id=%s)
                AND (%s::uuid IS NULL OR source_revision=%s) ORDER BY source_revision,created_at DESC LIMIT 101""",
                (who.id, code, code, request_id, request_id, revision, revision))).fetchall()
            if not rows and request_id is not None:
                admission = await (await conn.execute('SELECT * FROM sec_acquisition_admissions WHERE owner_id=%s AND request_id=%s AND source_version=%s',
                    (who.id,request_id,self.source_version))).fetchone()
                if admission:
                    return admission['result']
            if not rows:
                raise HTTPException(503 if request_id is None else 404, 'SEC公司资料尚未采集' if request_id is None else '未找到原请求回执')
            if len(rows) > 100:
                raise HTTPException(503, '请显式选择公司资料来源版本')
            choices, available = set(), []
            for row in rows:
                try:
                    _, policy = await self.authority.config(conn, who.id, row['source_revision'])
                except HTTPException:
                    continue
                if policy.source != 'sec' or policy.source_version != self.source_version or self.purpose not in policy.purposes or 'US' not in policy.markets:
                    continue
                await self.verify_observation(conn, who, row, policy)
                choices.add(row['source_revision'])
                available.append(row)
            if not choices:
                raise HTTPException(403, '公司资料来源许可已变化，原件仍保留')
            if len(choices) != 1:
                raise HTTPException(409, '请显式选择公司资料来源版本')
            return available[0]['result']


    async def close(self, who, request_id):
        rid = UUID(str(request_id))
        async with self.db.connection() as conn, conn.transaction():
            if getattr(who, 'native_client', False) or getattr(who, 'grant_id', None) or getattr(who, 'legacy_client', False):
                raise HTTPException(403, 'SEC来源操作仅限Web管理会话')
            await lock_mutation_identity(conn, who, require_admin=True)
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('sec-operation:'+who.id+str(rid),))
            prior = await (await conn.execute(f'SELECT result FROM {self.receipt_table} WHERE owner_id=%s AND request_id=%s', (who.id,rid))).fetchone()
            if prior:
                return prior['result']
            admission = await (await conn.execute('SELECT * FROM sec_acquisition_admissions WHERE owner_id=%s AND request_id=%s', (who.id,rid))).fetchone()
            if admission:
                if admission['source_version'] != self.source_version:
                    raise HTTPException(409, '原请求编号已用于不同来源操作')
                # Admitted external work cannot honestly be declared never executed.
                return admission['result']
            result = {'state':'closed','requestId':str(rid),'executed':False}
            await conn.execute("""INSERT INTO sec_acquisition_admissions(owner_id,request_id,source_version,fingerprint,result)
                VALUES(%s,%s,%s,%s,%s)""", (who.id,rid,self.source_version,
                sha256(canonical({'closed':True}).encode()).hexdigest(),Jsonb(result)))
            return result

    async def original(self, who, page_id):
        page_id = UUID(str(page_id))
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            await lock_mutation_identity(conn, who, require_admin=False)
            await self.authority.authorize_read(conn, who)
            row = await (await conn.execute(f"""SELECT p.*,r.source_revision FROM {self.page_table} p
                JOIN {self.receipt_table} r ON r.owner_id=p.owner_id AND r.request_id=p.request_id
                WHERE p.owner_id=%s AND p.id=%s""", (who.id,page_id))).fetchone()
            if not row:
                raise HTTPException(404, '未找到来源原件')
            try:
                _, policy = await self.authority.config(conn, who.id, row['source_revision'])
            except HTTPException as exc:
                raise HTTPException(403, '来源显示许可已变化，原件仍保留') from exc
            if (policy.source != 'sec' or policy.source_version != self.source_version
                    or self.purpose not in policy.purposes or 'US' not in policy.markets):
                raise HTTPException(403, '来源显示口径已变化')
            raw = bytes(row['raw_bytes'])
            if sha256(raw).hexdigest() != row['raw_sha256']:
                raise HTTPException(503, '来源原件完整性校验失败')
            return raw, row['raw_sha256'], row['representation']


def project(sec, entry):
    def text(value):
        return value if isinstance(value, str) else ''
    exchanges = sec.get('exchanges')
    exchange = text(exchanges[0]) if isinstance(exchanges, list) and exchanges else ''
    industry = text(sec.get('sicDescription'))
    industry = INDUSTRY_ZH.get(industry, industry)
    curated = CURATED.get(entry['ticker'], {})
    fiscal = text(sec.get('fiscalYearEnd'))
    business = sec.get('addresses', {}).get('business', {}) if isinstance(sec.get('addresses'), dict) else {}
    business = business if isinstance(business, dict) else {}
    return {'supported': True, 'source': 'SEC EDGAR', 'company': text(sec.get('name')) or entry['title'],
            'symbol': entry['ticker']+'.US',
            'exchange': {'Nasdaq': '纳斯达克全球精选市场', 'NYSE': '纽约证券交易所'}.get(exchange, exchange or '美国证券市场'),
            'founded': curated.get('founded', '—'), 'industry': industry or '—',
            'fiscalYearEnd': f'{int(fiscal[:2])} 月 {int(fiscal[2:])} 日' if len(fiscal)==4 and fiscal.isascii() and fiscal.isdigit() else '—',
            'website': curated.get('website') or text(sec.get('website')), 'description': curated.get('description', ''),
            'address': ', '.join(text(business.get(key)) for key in ('street1','city','stateOrCountry','zipCode') if text(business.get(key))),
            'phone': text(sec.get('phone')),
            'migration': {'descriptionState': 'legacy_editorial' if curated.get('description') else 'unavailable', 'foundedState': 'legacy_editorial' if curated.get('founded') else 'unknown', 'sourceTimeKnown': False}}
