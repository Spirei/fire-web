"""Six legacy funds routes over immutable PG postings and shared funding commands."""
import json
import math
import re
from datetime import UTC, datetime
from decimal import Decimal, localcontext
from uuid import UUID, uuid4

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg.errors import UniqueViolation

from .actual_projection import PENDING_FEE_SQL
from .broker_accounts import CURRENCIES
from .broker_metadata import fingerprint
from .card_preferences import JS_WHITESPACE, js_text
from .cash_overview import CashOverview
from .fund_sources import FundSources
from .fx_provider_parser import unique
from .legacy_broker_read import iso
from .legacy_cash_read import money
from .legacy_identity import assert_native_origin, native_identity, web_identity
from .legacy_pinyin_match import matches as pinyin_matches
from .native_app_auth import CLIENT
from .profile_http import bounded_body
from .security import digest

TYPES = {'opening': 'opening', 'external_deposit': 'deposit', 'external_withdrawal': 'withdrawal'}
TOKENS = {'opening': ('期初', '期初资金', 'opening', '初始'), 'external_deposit': ('转入', '入金', 'deposit', '充值', '资金转入'),
          'external_withdrawal': ('转出', '出金', 'withdrawal', '资金转出'), 'reconcile_balance': ('调整', 'adjustment', '余额调整', '其他')}


def js_number(value):
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    raw = js_text(value).strip(JS_WHITESPACE)
    if not raw:
        return 0.0
    try:
        return float(int(raw, 0)) if raw.startswith(('0x', '0X', '0b', '0B', '0o', '0O')) else float(raw)
    except (ValueError, OverflowError):
        return math.nan


def legacy_amount(value):
    try:
        return money(value)
    except HTTPException:
        return None


def utf16(value, limit):
    return js_text(value).encode('utf-16-le', errors='surrogatepass')[:limit * 2].decode('utf-16-le', errors='surrogatepass')


def paging(query):
    def integer(key, default, minimum, maximum):
        value = js_number(query.get(key))
        return min(maximum, max(minimum, math.trunc(value or default))) if math.isfinite(value) else default
    currency = query.get('currency', '').upper()
    return integer('limit', 40, 1, 100), integer('offset', 0, 0, 9007199254740991), currency if currency in CURRENCIES else None, utf16(query.get('q', '').strip(JS_WHITESPACE), 60)


def operation_id(request):
    value = request.headers.get('x-alcor-request-id')
    if value is None:
        return str(uuid4()), True
    try:
        return str(UUID(value)), False
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(400, '原操作编号无效') from None


def transaction(row):
    amount = Decimal(row['amount'])
    original = row.get('original_id')
    order = row.get('original_order_id') or (str(row['source_trade_id']) if row.get('source_trade_id') else None)
    identifier = row.get('fund_id') or (original if original and original.startswith(('fund-', 'card-link-')) else 'fund-order-' + order if order else 'fund-cash-' + str(row['id']))
    return {'id': identifier, 'currency': row['currency'], 'type': row.get('origin_type') or TYPES.get(row['kind'], 'adjustment'),
            'amount': legacy_amount(amount.copy_abs()), 'registeredAmount': str(amount.copy_abs()),
            'direction': -1 if amount < 0 else 1, 'note': row['note'], 'occurredAt': iso(row['occurred_at']), 'createdAt': iso(row['created_at']),
            'sourceOrderId': order, 'stockCode': row.get('stock_code'), 'stockName': row.get('stock_name'), 'stockMarket': row.get('stock_market'),
            'accountKind': row['account_kind'], 'accountId': row['account_id'], 'cashEntryId': str(row['id']),
            'requestId': str(row['request_id']), 'amountAuthority': 'registered_posting',
            'actualFeeKnown': row.get('actual_fee_known'), 'independentDeletionSupported': bool(row.get('fund_id') or original and original.startswith('fund-') and not original.startswith('fund-order-')) and order is None and not identifier.startswith('card-link-')}


def like(text, query):
    # SQLite LIKE's wildcard behavior is part of the old funds search contract.
    pattern, text = '%' + query.lower() + '%', (text or '').lower()
    previous = [True] + [False] * len(text)
    for char in pattern:
        current = [previous[0] if char == '%' else False]
        for index, actual in enumerate(text, 1):
            current.append((current[index-1] or previous[index]) if char == '%' else previous[index-1] and (char == '_' or char == actual))
        previous = current
    return previous[-1]


def search_match(row, query):
    raw = query.strip(JS_WHITESPACE)
    compact = ''.join(raw.lower().split())
    if any(like(value, raw) for value in (row['note'], str(row['occurred_at']), row['currency'])):
        return True
    date_query = re.fullmatch(r'(\d{1,2})月(\d{1,2})日?', raw)
    if date_query and f"-{int(date_query[1]):02d}-{int(date_query[2]):02d}" in str(row['occurred_at']):
        return True
    date_query = re.fullmatch(r'(\d{4})[./-](\d{1,2})[./-](\d{1,2})', raw)
    if date_query and f"{date_query[1]}-{int(date_query[2]):02d}-{int(date_query[3]):02d}" in str(row['occurred_at']):
        return True
    category = row.get('origin_type') or TYPES.get(row['kind'], 'adjustment')
    mapping = {'deposit':'external_deposit','withdrawal':'external_withdrawal','adjustment':'reconcile_balance'}
    tokens = list(TOKENS.get(mapping.get(category,category), ()))
    tokens += {'buy':['买入','买','buy'],'sell':['卖出','卖','sell'],'dividend':['股息','分红','dividend']}.get(row.get('stock_side'), [])
    tokens += {'US':['美股','us','nasdaq','nyse'],'HK':['港股','hk','香港'],'CN':['a股','沪','深','京','cn','上证','深证'],'JP':['日股','jp','日本'],'KR':['韩股','kr','韩国'],'SG':['新加坡','sg'],'EU':['欧股','eu']}.get(row.get('stock_market'), [])
    if any(token.lower().startswith(compact) or len(compact) >= 2 and compact.startswith(token.lower()) for token in tokens):
        return True
    code = re.sub(r'^(SH|SZ|BJ|HK)', '', (row.get('stock_code') or '').strip().upper()).lower()
    if code:
        digits = code.lstrip('0') or '0'
        variants = {code,digits}
        if row.get('stock_market') == 'HK' or code.isdecimal():
            variants.update((digits.zfill(4),digits.zfill(5)))
        if any(value == compact or len(compact) >= 2 and (compact in value or value in compact) for value in variants):
            return True
    name = row.get('stock_name') or ''
    return bool(name and (compact in ''.join(name.lower().split()) or pinyin_matches(name,raw)) or row['note'] and pinyin_matches(row['note'],compact))


class LegacyFunds:
    def __init__(self, db):
        self.db, self.funds, self.overview = db, FundSources(db), CashOverview(db)

    async def state_on_connection(self, conn, who):
        overview = await self.overview.on_connection(conn, who)
        from .legacy_registered_cash import read_registered_cash
        registered = await read_registered_cash(conn, who, self.db.settings, overview)
        if registered is not None:
            return registered.dto
        scopes = {}
        for book in overview['books']:
            for row in book['currencies']:
                scopes.setdefault(row['currency'], []).append((book['accountKind'], row))
        balances, summaries = {}, {}
        for currency in CURRENCIES:
            candidates = scopes.get(currency, [])
            selected = candidates[0][1] if len(candidates) == 1 else None
            balances[currency] = legacy_amount(selected['ownerBalance']) if selected and selected['complete'] else None
            summaries[currency] = dict.fromkeys(('openingAsset', 'cashNetFlow', 'stockNetFlow', 'otherNetFlow'))
            if selected and selected['complete']:
                rows = await (await conn.execute("SELECT coalesce(f.origin_type,e.kind) AS kind,coalesce(sum(e.amount),0) AS amount FROM cash_ledger_entries e LEFT JOIN fund_sources f ON f.owner_id=e.owner_id AND f.cash_entry_id=e.id WHERE e.owner_id=%s AND e.account_kind=%s AND e.currency=%s AND affects_owner AND reversal_entry_id IS NULL AND NOT EXISTS(SELECT 1 FROM fund_sources f JOIN fund_source_retirements x ON x.owner_id=f.owner_id AND x.source_id=f.id WHERE f.owner_id=e.owner_id AND f.cash_entry_id=e.id) GROUP BY coalesce(f.origin_type,e.kind)", (who.id, candidates[0][0], currency))).fetchall()
                with localcontext() as ctx:
                    ctx.prec = 80
                    values = {'openingAsset': Decimal(0), 'cashNetFlow': Decimal(0), 'stockNetFlow': Decimal(0), 'otherNetFlow': Decimal(0)}
                    for row in rows:
                        key = 'openingAsset' if row['kind'] == 'opening' else 'cashNetFlow' if row['kind'] in ('external_deposit', 'external_withdrawal', 'deposit', 'withdrawal') else 'stockNetFlow' if row['kind'] in ('trade_buy', 'trade_sell', 'trade_dividend', 'fee_correction', 'trade_correction') else 'otherNetFlow'
                        values[key] += row['amount']
                    summaries[currency] = {key: legacy_amount(value) for key, value in values.items()}
        return {'balances': balances, 'summaries': summaries, 'cardCash': dict.fromkeys(CURRENCIES),
                'snapshotRevision': overview['snapshotRevision'], 'coverageScope': 'platform_owner_kind_original_currency',
                'historicalCoverageKnown': False, 'cardCashCoverageKnown': False,
                'unboundLegacyGlobalCashIncluded': False, 'accountKindsCombined': False}

    async def read(self, who, query):
        async with self.funds.context(who, shared_read=True) as conn:
            if query.get('balancesOnly') == '1':
                state = await self.state_on_connection(conn, who)
                return {key: state[key] for key in ('balances', 'cardCash')} | {'cardCashCoverageKnown': state['cardCashCoverageKnown']}
            limit, offset, currency, text = paging(query)
            joins = """ FROM cash_ledger_entries e LEFT JOIN fund_sources f ON f.owner_id=e.owner_id AND f.cash_entry_id=e.id
                LEFT JOIN trade_ledger t ON t.owner_id=e.owner_id AND t.id=e.source_trade_id
                LEFT JOIN portfolio_records p ON p.owner_id=t.owner_id AND p.id=t.record_id
                LEFT JOIN LATERAL(SELECT original_id FROM financial_import_links l WHERE l.owner_id=e.owner_id AND l.object_kind='cash' AND l.target_id=e.id::text ORDER BY l.source_instance,l.original_id LIMIT 1) c ON true
                LEFT JOIN LATERAL(SELECT original_id,original FROM financial_import_links l WHERE l.owner_id=e.owner_id AND l.object_kind='order' AND l.target_id=t.id::text ORDER BY l.source_instance,l.original_id LIMIT 1) o ON true"""
            where = """ WHERE e.owner_id=%s AND e.affects_owner AND e.reversal_entry_id IS NULL
                AND NOT EXISTS(SELECT 1 FROM fund_source_retirements x WHERE x.owner_id=f.owner_id AND x.source_id=f.id)
                AND (%s::text IS NULL OR e.currency=%s)"""
            args = (who.id, currency, currency)
            sql = "SELECT e.*,f.id AS fund_id,f.origin_type,c.original_id,o.original_id AS original_order_id,p.code AS stock_code,o.original->>'name' AS stock_name,p.market AS stock_market,t.side AS stock_side,CASE WHEN t.id IS NULL THEN NULL ELSE NOT (" + PENDING_FEE_SQL + ") END AS actual_fee_known" + joins + where + ' ORDER BY e.occurred_at DESC,e.created_at DESC,e.id'
            from .database_migration_history import registered_funds
            historical=await registered_funds(conn,who.id)
            if historical:
                native=await(await conn.execute(sql+' LIMIT 10001',args)).fetchall()
                if len(native)>10000:raise HTTPException(409,'资金记录超过完整合并预算，请按原币缩小范围')
                historical=[row for row in historical if not currency or row['currency']==currency]
                combined=[transaction(row) for row in native]+historical
                if text:
                    combined=[row for row in combined if search_match({'note':row.get('note') or '','occurred_at':row.get('occurredAt'),'currency':row['currency'],'origin_type':row['type'],'kind':row['type'],'stock_code':row.get('stockCode'),'stock_name':row.get('stockName'),'stock_market':row.get('stockMarket')},text)]
                combined.sort(key=lambda row:(row.get('occurredAt') or '',row.get('createdAt') or '',row['id']),reverse=True)
                result={'transactions':combined[offset:offset+limit],'pagination':{'limit':limit,'offset':offset,'total':len(combined),'hasMore':offset+limit<len(combined)}}
                if query.get('recordsOnly')!='1':result.update(await self.state_on_connection(conn,who))
                return result
            if text:
                rows, total = [], 0
                async with conn.cursor(name='fund_search_' + uuid4().hex) as stream:
                    await stream.execute(sql, args)
                    while page := await stream.fetchmany(512):
                        for row in page:
                            if search_match(row, text):
                                if offset <= total < offset + limit:
                                    rows.append(row)
                                total += 1
            else:
                total = (await (await conn.execute('SELECT count(*) AS n' + joins + where, args)).fetchone())['n']
                rows = await (await conn.execute(sql + ' LIMIT %s OFFSET %s', (*args, limit, offset))).fetchall()
            result = {'transactions': [transaction(row) for row in rows], 'pagination': {'limit': limit, 'offset': offset, 'total': total, 'hasMore': offset + limit < total}}
            if query.get('recordsOnly') != '1':
                result.update(await self.state_on_connection(conn, who))
            return result

    async def outcome_snapshot(self, conn, who, result, identifier, source_id, generated):
        source, tx = result.get('source'), None
        if source and not source_id:
            delta = Decimal(source['delta'])
            tx = {'id': source['id'], 'currency': source['currency'], 'type': source['type'],
                  'amount': legacy_amount(delta.copy_abs()), 'registeredAmount': str(delta.copy_abs()),
                  'direction': -1 if delta < 0 else 1, 'note': source['note'],
                  'occurredAt': iso(datetime.fromisoformat(source['occurredAt'])),
                  'createdAt': iso(datetime.fromisoformat(source['createdAt'])), 'sourceOrderId': None, 'accountKind': source['accountKind']}
        operation = {key: value for key, value in result.items() if key != 'legacySnapshot'}
        return {**await self.state_on_connection(conn, who), 'transaction': tx,
                **({'deleted': True, 'originalRetained': True, 'reversalCashEntryId': result.get('entryId')} if source_id else {}),
                'requestId': identifier, 'legacyClientIdempotency': not generated,
                'receiptPath': '/api/client/fund-sources/operations/' + identifier, 'operation': operation}

    async def mutate(self, who, raw, identifier, *, source_id=None, generated=False, expected_revision=None):
        if source_id and source_id.startswith(('fund-order-', 'card-link-')):
            raise HTTPException(404, '资金记录不存在，关联记录须在原业务处理')
        if not isinstance(raw, dict):
            raise HTTPException(400, '无效请求')
        request_hash = fingerprint({'method': 'delete' if source_id else 'post', 'sourceId': source_id, 'body': raw})
        async def project(conn, outcome):
            return await self.outcome_snapshot(conn, who, outcome, identifier, source_id, generated)
        async with self.funds.context(who) as conn:
            prior = await (await conn.execute('SELECT result FROM fund_source_operations WHERE owner_id=%s AND request_id=%s', (who.id, identifier))).fetchone()
            if prior:
                if prior['result'].get('state') == 'closed':
                    return {**prior['result'], 'requestId': identifier, 'legacyClientIdempotency': not generated}
                if prior['result'].get('legacyRequestHash') != request_hash:
                    raise HTTPException(409, '原操作编号已用于其他资金请求')
                result = prior['result']
            else:
                when = datetime.now(UTC).isoformat()
                if source_id:
                    payload = {'kind': 'delete', 'requestId': identifier, 'sourceId': source_id, 'sourceRevision': 1, 'occurredAt': when, 'note': '旧资金记录撤销，原件保留'}
                else:
                    currency = js_text(raw.get('currency')).upper()
                    if currency not in CURRENCIES:
                        raise HTTPException(400, '资金记录参数无效')
                    kind = await self.scope_on_connection(conn, who, currency)
                    if raw.get('action') == 'set_balance':
                        target, expected = js_number(raw.get('targetBalance')), js_number(raw.get('expectedBalance'))
                        if not isinstance(raw.get('currency'),str) or raw['currency'] not in CURRENCIES or not isinstance(raw.get('targetBalance'), (int, float)) or not isinstance(raw.get('expectedBalance'), (int, float)) or isinstance(raw.get('targetBalance'), bool) or isinstance(raw.get('expectedBalance'), bool) or not math.isfinite(target) or not math.isfinite(expected) or not 0 <= target <= 1e12:
                            raise HTTPException(400, '现金余额参数无效')
                        # Card and broker scope cannot be inferred from a total in an untyped old request.
                        if await (await conn.execute('SELECT 1 FROM card_wallet_accounts WHERE owner_id=%s LIMIT 1', (who.id,))).fetchone():
                            raise HTTPException(409, '卡与原币资金范围尚未明确关联，不能猜测调整差额')
                        state = await self.overview.on_connection(conn, who)
                        book = next(row for row in state['books'] if row['accountKind'] == kind)
                        current = next((row for row in book['currencies'] if row['currency'] == currency), None)
                        if not current or not current['complete'] or current['ownerBalance'] is None:
                            raise HTTPException(409, '现有现金来源不完整，不能猜测调整差额')
                        before = Decimal(current['ownerBalance'])
                        if abs(before - Decimal(str(target))) < Decimal('1e-8'):
                            if expected_revision is not None and state['revision'] != expected_revision:
                                raise HTTPException(409, '现金修订号已变化')
                            result = await self.funds.legacy_noop(conn, who, identifier, request_hash, currency, kind, before, project=project)
                            return result['legacySnapshot']
                        if abs(before - Decimal(str(expected))) > Decimal('1e-8'):
                            raise HTTPException(409, '现金余额已变化，请重新核对')
                        if abs(Decimal(str(target)) - before) > Decimal('1e12'):
                            raise HTTPException(400, '余额调整差额超出上限')
                        with localcontext() as ctx:
                            ctx.prec = 80
                            target_unallocated = Decimal(str(target)) - Decimal(current['registeredAttributedBalance'])
                        cash = {'accountId': None, 'accountKind': kind, 'currency': currency, 'action': 'reconcile_balance', 'amount': str(target_unallocated), 'occurredAt': when, 'note': '资产页可用现金核对调整'}
                    else:
                        type_, amount, direction = js_text(raw.get('type')), js_number(raw.get('amount')), js_number(raw.get('direction'))
                        note = js_text(raw.get('note') or '').strip(JS_WHITESPACE)
                        if type_ not in ('opening', 'deposit', 'withdrawal', 'adjustment') or not math.isfinite(amount) or not 0 < amount <= 1e12 or direction not in (-1, 1) or len(note.encode('utf-16-le', errors='surrogatepass')) // 2 > 200:
                            raise HTTPException(400, '资金记录参数无效')
                        if raw.get('occurredAt'):
                            try:
                                at = datetime.fromisoformat(js_text(raw['occurredAt']))
                                if at.tzinfo is None:
                                    if len(js_text(raw['occurredAt'])) == 10:
                                        at = at.replace(tzinfo=UTC)
                                    else:
                                        raise ValueError()
                                when = at.isoformat()
                            except (ValueError, TypeError):
                                raise HTTPException(400, '资金日期无效') from None
                        action = 'external_deposit' if direction > 0 else 'external_withdrawal'
                        if type_ == 'opening':
                            if direction < 0:
                                raise HTTPException(409, '期初不能声明负资金；历史原件需要单独核对')
                            action = 'external_deposit'
                        cash = {'accountId': None, 'accountKind': kind, 'currency': currency, 'action': action, 'amount': str(amount), 'occurredAt': when, 'note': note, **({'openingBasis': 'new_external_opening'} if action == 'opening' else {})}
                    payload = {'kind': 'create', 'requestId': identifier, 'sourceType': 'adjustment' if raw.get('action') == 'set_balance' else type_, 'cash': cash}
                # Parent context holds the owner lock; helper only re-enters the same connection.
                result = await self.funds.legacy_apply(who, payload, expected_revision=expected_revision, legacy_request_hash=request_hash, connection=conn, project=project)
            if result.get('legacySnapshot') is not None:
                return result['legacySnapshot']
            # Historical immutable receipts cannot be repaired by inventing a new balance snapshot.
            return {'requestId': identifier, 'operation': result, 'legacySnapshotUnavailable': True,
                    'legacyClientIdempotency': not generated}

    async def scope_on_connection(self, conn, who, currency):
        rows = await (await conn.execute("SELECT DISTINCT account_kind FROM cash_ledger_entries WHERE owner_id=%s AND currency=%s", (who.id, currency))).fetchall()
        if len(rows) != 1 or not await (await conn.execute("SELECT 1 FROM cash_ledger_entries WHERE owner_id=%s AND currency=%s AND account_kind=%s AND account_id IS NULL AND kind='opening'", (who.id,currency,rows[0]['account_kind'] if rows else None))).fetchone():
            raise HTTPException(409, '真实或模拟资金来源尚未唯一核实，不能按名称推定')
        return rows[0]['account_kind']


def mount_legacy_fund_sources(app, rate_limit):
    service = LegacyFunds(app.state.db)

    async def respond(request, version, source_id=None):
        headers = {'Cache-Control': 'no-store, private', 'Vary': 'Cookie, Authorization', 'X-Alcor-API-Version': str(version)}
        try:
            if version not in (1, 2):
                raise HTTPException(404, '接口不存在')
            db = app.state.db
            authorization = request.headers.get('authorization', '')
            if 'authorization' in request.headers and not authorization.startswith('Bearer '):
                raise HTTPException(401, '未登录')
            if version == 2 or authorization.startswith('Bearer fat_'):
                assert_native_origin(request, db.settings)
                who, grant = await native_identity(request, db, 'portfolio.read' if request.method == 'GET' else 'portfolio.write')
                if grant['client_id'] != CLIENT:
                    raise HTTPException(401, '未登录')
            else:
                who, _, _ = await web_identity(request, db, allow_v1_bearer=True)
            if request.method == 'GET':
                value = await service.read(who, request.query_params)
            else:
                if not await rate_limit(db, digest('legacy-funds:' + who.id), 30, window_seconds=60):
                    raise HTTPException(429, '操作过于频繁')
                identifier, generated = operation_id(request)
                revision = request.headers.get('x-alcor-expected-revision')
                if revision is not None and (not revision.isascii() or not revision.isdecimal() or len(revision) > 18):
                    raise HTTPException(400, '现金修订号无效')
                raw = {}
                if request.method == 'POST':
                    try:
                        raw = json.loads(await bounded_body(request, 16384), object_pairs_hook=unique,
                                         parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                    except (ValueError, TypeError, UnicodeError, RecursionError):
                        raise HTTPException(400, '无效请求') from None
                elif (await bounded_body(request, 128)).strip() not in (b'', b'{}'):
                    raise HTTPException(400, '无效请求')
                value = await service.mutate(who, raw, identifier, source_id=source_id, generated=generated,
                                             expected_revision=int(revision) if revision is not None else None)
            return JSONResponse({'code': 0, 'message': 'ok', 'data': value}, headers=headers)
        except UniqueViolation as exc:
            if exc.diag.constraint_name != 'asset_request_domain':
                raise
            return JSONResponse({'code': 40901, 'message': '原UUID已用于其他资产操作，请查询原回执'}, status_code=409, headers=headers)
        except HTTPException as exc:
            for key, value in (exc.headers or {}).items():
                if key.lower() in ('x-alcor-session-changed', 'x-alcor-reauthentication'):
                    headers[key] = value
            if exc.status_code in (401, 403):
                headers['X-Alcor-Retire-Context'] = 'true'
            return JSONResponse({'code': getattr(exc, 'business_code', exc.status_code * 100 + 1), 'message': str(exc.detail)}, status_code=exc.status_code, headers=headers)
        except Exception:  # noqa: BLE001 -- legacy boundary never exposes credentials, SQL or source data
            message = '资金暂时无法读取，请重试' if request.method == 'GET' else '资金结果未确认，请查询原UUID回执'
            return JSONResponse({'code': 50001, 'message': message}, status_code=500, headers=headers)

    @app.get('/api/v1/funds')
    async def read_v1(request: Request):
        return await respond(request, 1)

    @app.get('/api/v2/funds')
    async def read_v2(request: Request):
        return await respond(request, 2)

    @app.post('/api/v1/funds')
    async def post_v1(request: Request):
        return await respond(request, 1)

    @app.post('/api/v2/funds')
    async def post_v2(request: Request):
        return await respond(request, 2)

    @app.delete('/api/v1/funds/{source_id}')
    async def delete_v1(request: Request, source_id: str):
        return await respond(request, 1, source_id)

    @app.delete('/api/v2/funds/{source_id}')
    async def delete_v2(request: Request, source_id: str):
        return await respond(request, 2, source_id)
