"""Anonymous reads of separately licensed public facts; never owner data or IO."""

from dataclasses import asdict
from hashlib import sha256
from uuid import UUID

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .dividend_sources import Target
from .market_authority import query_from
from .market_contract import Query, digest, number
from .market_quote_reads import project
from .market_worker import decode

# Locators authorize private evidence access; a public quote is not that grant.
_PRIVATE_KEYS = frozenset({
    'sourcepageid', 'sourcepageids', 'pageid', 'pageids', 'taskid', 'jobid',
    'requestid', 'ownerid', 'targetid', 'targetfingerprint', 'streamid',
    'originalpath', 'originalurl', 'contentpath', 'rawbytes', 'raw', 'context',
})
_EXACT_FIELDS = frozenset({'open', 'high', 'low', 'prevClose', 'change', 'changePct',
                           'volume', 'amount', 'amountRolling24h'})


def public_projection(dto):
    def clean(value):
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items()
                    if key.replace('_', '').lower() not in _PRIVATE_KEYS}
        if isinstance(value, list):
            return [clean(item) for item in value]
        return value

    result = clean(dto)
    if isinstance(result.get('dayStatsExact'), dict):
        exact = {}
        for key, value in result['dayStatsExact'].items():
            if key not in _EXACT_FIELDS:
                continue
            try:
                exact[key] = str(number(value, signed=key in {'change', 'changePct'}))
            except (ValueError, TypeError, OverflowError):
                continue
        result['dayStatsExact'] = exact
    fund = result.get('fundMetrics')
    if isinstance(fund, dict):
        for field in ('units', 'assetsUnderManagement', 'netAssetValue', 'calculatedMarketCap', 'price'):
            try:
                fund[field] = str(number(fund[field])) if fund.get(field) is not None else None
            except (ValueError, TypeError, OverflowError):
                fund[field] = None
    return result


class PublicQuotes:
    def __init__(self, authority):
        self.authority = authority
        self.db = authority.db

    async def read(self, items, *, session=None, include_market_cap=True, retain_evidence=False, snapshot=None, observed_at=None):
        # Snapshot locators are service-internal only; HTTP callers never bind these arguments.
        quotes, states, evidence = {}, {}, {}
        if snapshot is not None and not isinstance(snapshot,dict):raise ValueError('public_snapshot_invalid')
        if observed_at is not None and (snapshot is None or observed_at.tzinfo is None):raise ValueError('public_snapshot_clock_invalid')
        async with self.db.connection() as conn, conn.transaction():
            # READ COMMITTED + Authority.current's license lock serialize revocation.
            licenses = await (await conn.execute(
                'SELECT id FROM public_market_licenses ORDER BY id LIMIT 101'
            )).fetchall()
            if len(licenses) > 100:
                raise HTTPException(503, '公共来源数量超过可核对范围')
            active = []
            for license_row in licenses:
                try:
                    row, policy = await self.authority.current(conn, license_row['id'], 'display')
                except HTTPException as error:
                    if error.status_code not in (403, 404, 409, 410, 503):
                        raise
                    continue
                if not policy.fixture:
                    targets = [Target(**raw) for raw in getattr(self.db.settings, 'public_market_source_targets', ()) if raw.get('id') == policy.target_id]
                    if len(targets) != 1 or targets[0].fingerprint != policy.target_fingerprint:
                        continue
                    try:
                        targets[0].validate(self.db.settings.environment)
                    except (ValueError, TypeError, HTTPException):
                        continue
                active.append((row, policy))
            if not active:
                raise HTTPException(503, '公共报价再分发许可未配置或已失效')
            now = (await (await conn.execute('SELECT clock_timestamp() AS now')).fetchone())['now']
            for item in items:
                candidates = []
                selected = snapshot.get(item['id']) if snapshot is not None else None
                if snapshot is not None and selected is None:
                    states[item['id']]={'state':'unknown'}
                    continue
                for row, policy in active:
                    if selected is not None and str(row['id'])!=selected['licenseId']:continue
                    for market, code, instrument, selected_session in policy.symbols:
                        if (market, code) != (item['market'], item['code']) or session is not None and session != selected_session:
                            continue
                        query = Query('latest', market, code, session=selected_session, instrument=instrument)
                        candidates.append((row, policy, query))
                key = item['id']
                if len(candidates) != 1:
                    states[key] = {'state': 'ambiguous_public_source' if candidates else 'public_scope_unavailable'}
                    continue
                license_row, policy, query = candidates[0]
                await self.authority.current(conn, license_row['id'], 'display', query)
                rows = await (await conn.execute(
                    '''SELECT f.*, p.raw_bytes,p.raw_sha256,p.complete,p.issues,p.task_id AS page_task_id,
                              t.license_id AS task_license_id,t.query AS task_query,p.http_status
                       FROM public_market_facts f JOIN public_market_pages p ON p.id=f.page_id
                       JOIN public_market_tasks t ON t.id=f.task_id
                       WHERE f.license_id=%s AND f.query=%s::jsonb AND (%s::uuid IS NULL OR f.id=%s)
                       ORDER BY f.source_time DESC,f.id DESC LIMIT 2''',
                    (license_row['id'], Jsonb(asdict(query)), UUID(selected['factId']) if selected else None, UUID(selected['factId']) if selected else None),
                )).fetchall()
                if not rows:
                    states[key] = {'state': 'unknown'}
                    continue
                fact = rows[0]
                try:
                    if fact['task_id'] != fact['page_task_id'] or fact['task_license_id'] != license_row['id'] or query_from(fact['task_query']) != query:
                        raise ValueError('public_binding_mismatch')
                    if selected is not None and (str(fact['page_id'])!=selected['pageId'] or fact['raw_sha256']!=selected['rawSha256']):raise ValueError('public_snapshot_binding_mismatch')
                    raw = bytes(fact['raw_bytes'])
                    if fact['http_status'] not in (None, 200) or not fact['complete'] or fact['issues'] or sha256(raw).hexdigest() != fact['raw_sha256']:
                        raise ValueError('public_original_unverified')
                    decoded, issues, cursor = decode(policy, query, raw)
                    if cursor is not None or issues or not any(digest(value) == digest(fact['contents']) for value in decoded):
                        raise ValueError('public_fact_unverified')
                    if len(rows) > 1 and rows[1]['source_time'] == fact['source_time'] and digest(rows[1]['contents']) != digest(fact['contents']):
                        raise ValueError('public_fact_ambiguous')
                    dto, state = project(fact, policy, query.market, observed_at or now, include_market_cap=include_market_cap)
                    if dto is None:
                        raise ValueError('public_projection_unavailable')
                except (ValueError, TypeError, KeyError, OverflowError):
                    states[key] = {'state': 'unverified_public_source'}
                    continue
                # No private target, page locator, task/owner identifier or raw payload.
                evidence[key]={'licenseId':str(license_row['id']),'factId':str(fact['id']),'pageId':str(fact['page_id']),'rawSha256':fact['raw_sha256']}
                quotes[key] = public_projection(dto)
                states[key] = {'state': state, 'licenseRevision': policy.license_revision,
                               'sourceTime': fact['source_time'].isoformat(),
                               'priceExact': str(number(fact['contents']['price'], positive=True))}
        result={'quotes': quotes, 'quoteStates': states}
        if retain_evidence:result['_publicEvidence']=evidence
        return result
