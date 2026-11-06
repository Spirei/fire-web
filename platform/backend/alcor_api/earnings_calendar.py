"""Explicit calendar acquisition with durable UUID admission and licensed immutable reads."""

import calendar
import hashlib
from datetime import date, datetime
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

import httpcore
from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .fx_reference import external_delivery_blocked
from .market_contract import digest
from .security import lock_mutation_identity


def month_key(value):
    if not isinstance(value, str) or len(value) != 7:
        raise ValueError('calendar_month_invalid')
    begin = date.fromisoformat(value + '-01')
    if not 2000 <= begin.year <= 2100:
        raise ValueError('calendar_month_invalid')
    return value


def calendar_query(market, month):
    if market not in ('US', 'CN', 'HK'):
        raise ValueError('calendar_market_invalid')
    now = datetime.now(ZoneInfo('America/New_York'))
    return market, month_key(month if month is not None else now.strftime('%Y-%m'))


class EarningsCalendar:
    def __init__(self, authority, targets=()):
        self.authority, self.db, self.targets = authority, authority.db, tuple(targets)

    def target(self, policy):
        from .earnings_calendar_protocol import PURPOSE, SOURCE_VERSION
        matches = [row for row in self.targets if row.id == policy.target_id]
        if (len(matches) != 1 or policy.source_version != SOURCE_VERSION or PURPOSE not in policy.purposes
                or matches[0].source != policy.source or matches[0].fingerprint != policy.target_fingerprint):
            raise HTTPException(503, '财报日历来源尚未显式授权')
        try:
            return matches[0].validate()
        except (ValueError,TypeError):
            raise HTTPException(503,'已安装日历来源配置无效') from None

    async def licensed(self, conn, who, revision, market):
        _, policy = await self.authority.config(conn, who.id, revision)
        target = self.target(policy)
        if market not in policy.markets or target.source != {'US':'nasdaq','CN':'eastmoney','HK':'xueqiu'}[market]:
            raise HTTPException(403, '日历来源未授权此市场')
        return policy, target

    async def collect(self, who, body):
        from .earnings_calendar_protocol import fetch, parse
        if not isinstance(body, dict) or set(body) != {'requestId','sourceRevision','market','month','pageKey'}:
            raise ValueError('calendar_collection_invalid')
        rid, revision = UUID(str(body['requestId'])), UUID(str(body['sourceRevision']))
        market, month = calendar_query(body['market'], body['month'])
        key = body['pageKey']
        if not isinstance(key, str) or len(key) > 32:
            raise ValueError('calendar_page_invalid')
        fingerprint = digest({**body,'requestId':str(rid),'sourceRevision':str(revision)})
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who, require_admin=True)
            await self.authority.owner_lock(conn, who)
            old = await (await conn.execute('SELECT * FROM earnings_calendar_admissions WHERE owner_id=%s AND request_id=%s', (who.id,rid))).fetchone()
            if old:
                if old['request_hash'] != fingerprint:
                    raise HTTPException(409, '原请求编号已用于不同日历采集')
                return await self.receipt_on(conn, who, rid)
            policy, target = await self.licensed(conn,who,revision,market)
            if await external_delivery_blocked(conn):
                raise HTTPException(409,'恢复隔离尚未解除，未执行外部采集')
            # Validate the exact fixed page before committing admission; no source request here.
            try:
                target.request(market, month, key)
            except OSError:
                raise HTTPException(503,'日历来源的私有凭据不可用') from None
            await conn.execute('INSERT INTO earnings_calendar_admissions(owner_id,request_id,source_revision,request_hash,market,month,page_key) VALUES(%s,%s,%s,%s,%s,%s,%s)',
                               (who.id,rid,revision,fingerprint,market,month,key))
        # Admission is durable before IO. Unknown requests are never automatically repeated.
        raw, page_id, captured = b'', uuid4(), False
        result = {'requestId':str(rid),'sourceRevision':str(revision),'market':market,'month':month,
                  'pageKey':key,'state':'unknown','items':[],'nextPage':None,'sourcePageId':str(page_id),
                  'httpStatus':None,'pageComplete':False}
        denied = None
        try:
            async with self.db.connection() as conn,conn.transaction():
                await lock_mutation_identity(conn,who,require_admin=True)
                current,_ = await self.licensed(conn,who,revision,market)
                if current.fingerprint!=policy.fingerprint or await external_delivery_blocked(conn):
                    raise HTTPException(409,'采集许可或恢复隔离已变化，未执行外部采集')
                raw = await fetch(target, market, month, key)
            captured = True
            result.update(httpStatus=200,pageComplete=True)
            result.update(parse(raw,market,month,key),state='observed')
        except HTTPException as exc:
            denied = exc
            result.update(state='blocked',error='collection_authorization_changed')
        except (ValueError,TypeError,KeyError,OverflowError,RecursionError,OSError,TimeoutError,
                httpcore.NetworkError,httpcore.ProtocolError,httpcore.TimeoutException) as exc:
            # Source bytes, including unsuccessful responses, remain private evidence.
            if isinstance(getattr(exc,'raw',None),bytes):
                raw = exc.raw
                captured = True
                result.update(httpStatus=getattr(exc,'status',None),pageComplete=getattr(exc,'complete',False))
            result['error'] = 'source_unavailable_or_invalid'
        result.update(pageCaptured=captured,sourcePageId=str(page_id) if captured else None)
        if captured and result['state']=='unknown':
            result['state']='partial'
        result.update(licenseRevision=policy.license_revision,automaticCollection=False,
                      fullBusinessHistoryVerified=False,calendarCompletenessVerified=False)
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ('market-owner:'+who.id,))
            await conn.execute('''INSERT INTO earnings_calendar_pages(owner_id,request_id,id,source_revision,policy_fingerprint,license_revision,
                market,month,page_key,raw_bytes,raw_sha256,result) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (who.id,rid,page_id,revision,policy.fingerprint,policy.license_revision,market,month,key,raw,hashlib.sha256(raw).hexdigest(),Jsonb(result)))
            try:
                await lock_mutation_identity(conn,who,require_admin=True)
                current,_ = await self.licensed(conn,who,revision,market)
                if current.fingerprint != policy.fingerprint:
                    raise HTTPException(409, '日历来源许可已变化')
            except HTTPException as exc:
                denied = exc
        if denied is not None:
            raise denied
        return result

    async def receipt_on(self, conn, who, request_id):
        admission = await (await conn.execute('SELECT * FROM earnings_calendar_admissions WHERE owner_id=%s AND request_id=%s', (who.id,request_id))).fetchone()
        if not admission:
            raise HTTPException(404,'原日历请求不存在')
        await self.licensed(conn,who,admission['source_revision'],admission['market'])
        row = await (await conn.execute('SELECT result FROM earnings_calendar_pages WHERE owner_id=%s AND request_id=%s', (who.id,request_id))).fetchone()
        return row['result'] if row else {'requestId':str(request_id),'state':'unknown','automaticRetry':False}

    async def receipt(self, who, request_id):
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn,who,require_admin=True)
            return await self.receipt_on(conn,who,UUID(str(request_id)))

    async def read(self, who, market, month=None, source_revision=None):
        market,month = calendar_query(market,month)
        revision = UUID(str(source_revision)) if source_revision else None
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            await lock_mutation_identity(conn,who,require_admin=False)
            await self.authority.authorize_read(conn,who)
            rows = await (await conn.execute('''SELECT DISTINCT ON(source_revision,page_key,(result->>'state'='observed')) * FROM earnings_calendar_pages
                WHERE owner_id=%s AND market=%s AND month=%s AND (%s::uuid IS NULL OR source_revision=%s)
                ORDER BY source_revision,page_key,(result->>'state'='observed'),created_at DESC LIMIT 2003''',(who.id,market,month,revision,revision))).fetchall()
            if len(rows)>2002:
                raise HTTPException(503,'日历页超出读取范围')
            usable,retained = {},[]
            for row in rows:
                try:
                    policy,_ = await self.licensed(conn,who,row['source_revision'],market)
                    if policy.fingerprint != row['policy_fingerprint']:
                        raise HTTPException(403,'source_changed')
                except HTTPException:
                    retained.append(str(row['source_revision']))
                    continue
                usable.setdefault(str(row['source_revision']),[]).append(row)
            if len(usable)>1:
                raise HTTPException(409,'存在多个已许可日历来源，请选择来源版本')
            selected = next(iter(usable.values()),[])
            items,observed,seen = [],[],set()
            for row in selected:
                if row['result']['state']!='observed':
                    continue
                try:
                    from .earnings_calendar_protocol import parse
                    from .market_discovery_protocol import digest as observation_digest
                    raw = bytes(row['raw_bytes'])
                    result = row['result']
                    if (hashlib.sha256(raw).hexdigest() != row['raw_sha256']
                            or result.get('httpStatus') != 200 or result.get('pageComplete') is not True
                            or result.get('sourcePageId') != str(row['id'])
                            or row['license_revision'] != result.get('licenseRevision')):
                        raise ValueError()
                    projected = parse(raw,market,month,row['page_key'])
                    if any(observation_digest(result.get(key)) != observation_digest(value) for key,value in projected.items()):
                        raise ValueError()
                except (ValueError,TypeError,KeyError,OverflowError,RecursionError,UnicodeError):
                    raise HTTPException(503,'日程与保留原件无法核对') from None
                observed.append(row)
                for item in row['result']['items']:
                    identity = (item['symbol'],item['date'],item['time'],item['quarter'])
                    if identity not in seen:
                        seen.add(identity)
                        items.append(item)
            items.sort(key=lambda item:(item['date'],item['symbol'],item['time']))
            known_days = {row['page_key'] for row in observed} if market=='US' else set()
            year,number = (int(part) for part in month.split('-'))
            days = [date(year,number,n).isoformat() for n in range(1,calendar.monthrange(year,number)[1]+1)]
            first = observed[0] if observed else None
            return {'market':market,'month':month,'items':items,'updatedAt':max((r['created_at'] for r in observed),default=None).isoformat() if observed else None,
                    'state':'observed' if observed else 'retained_unavailable' if retained else 'unknown',
                    'sourceRevision':str(first['source_revision']) if first else str(revision) if revision else None,
                    'licenseRevision':first['license_revision'] if first else None,
                    'sourcePageId':str(first['id']) if first else None,'sourcePageIds':[str(row['id']) for row in observed],
                    'coverage':{'complete':False,'missingDates':[day for day in days if day not in known_days] if market=='US' else [],
                                'basis':'provider_calendar_schedule','observedPageKeys':[row['page_key'] for row in observed],
                                'pageResults':[{'pageKey':row['page_key'],'state':row['result']['state'],'nextPage':row['result'].get('nextPage')} for row in selected],
                                'calendarCompletenessVerified':False},
                    'retainedSources':sorted(set(retained)),'automaticCollection':False}

    async def original(self, who, page_id):
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who,require_admin=False)
            await self.authority.authorize_read(conn,who)
            row = await (await conn.execute('SELECT * FROM earnings_calendar_pages WHERE owner_id=%s AND id=%s',(who.id,UUID(str(page_id))))).fetchone()
            if not row:
                raise HTTPException(404,'日历原件不存在')
            if not row['result'].get('pageCaptured'):
                raise HTTPException(404,'原请求没有捕获来源响应，不存在日历原件')
            policy,_ = await self.licensed(conn,who,row['source_revision'],row['market'])
            raw = bytes(row['raw_bytes'])
            if policy.fingerprint!=row['policy_fingerprint'] or hashlib.sha256(raw).hexdigest()!=row['raw_sha256']:
                raise HTTPException(503,'日历原件许可或校验失败')
            return raw,row['raw_sha256']
