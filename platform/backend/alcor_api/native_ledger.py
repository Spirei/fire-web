"""Atomic owner ledger for App-authored accounting transactions."""

import json
import re
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, localcontext
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from .asset_request_domains import require_domain
from .broker_accounts import serialize_brokers
from .broker_metadata import fingerprint
from .cash_overview import CashOverview
from .fx_provider_parser import unique
from .legacy_identity import assert_native_origin, native_identity
from .native_app_auth import CLIENT
from .native_trade_sync import CURRENCIES, extends_fill_history, order_time, same_fill, validate_amount, validate_order
from .profile_http import body_budget, bounded_body
from .security import lock_mutation_identity, lock_read_identity

PATH = '/api/v2/account-assets/native-ledger'
TRANSACTIONS = PATH + '/transactions'
MAX_REVISION = 9007199254740991
ITEM_LIMIT = 100


def discovery():
    return {'version': 1, 'snapshot_path': PATH, 'transactions_path': TRANSACTIONS,
            'receipt_path': TRANSACTIONS + '/{requestId}', 'read_scope': 'portfolio.read',
            'write_scope': 'portfolio.write', 'source_revision_field': 'sourceRevision'}


def text(value, maximum):
    if (not isinstance(value, str) or not 1 <= len(value) <= maximum
            or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value)):
        raise ValueError
    return value


def amount(value, scale=16, *, nullable=False, nonnegative=False):
    if nullable and value is None:
        return None
    number = validate_amount(value, scale)
    if abs(number) >= Decimal('1e30') or nonnegative and number < 0:
        raise ValueError
    return number


def decimal_text(value):
    if value is None:
        return None
    output = format(value, 'f')
    return output.rstrip('0').rstrip('.') if '.' in output and value else '0' if value == 0 else output


def broker_id(value):
    return None if value is None else text(value, 200)


def position_identity(item):
    return item['market'], item.get('accountMarket') or item['market'], item['code'], item.get('brokerAccountId')


def validate_position(item):
    required = {'recordId', 'market', 'code', 'name', 'quantityBefore', 'quantityAfter', 'unitCostAfter'}
    if not isinstance(item, dict) or not required <= item.keys() or item.keys() - required - {'accountMarket', 'brokerAccountId'}:
        raise ValueError
    text(item['recordId'], 200)
    text(item['name'], 160)
    market, account_market, code, account = position_identity(item)
    if market not in CURRENCIES or (market, account_market) not in {(market, market), ('HK', 'CN')}:
        raise ValueError
    if not re.fullmatch(r'[A-Za-z0-9.\-]{1,32}', code):
        raise ValueError
    broker_id(account)
    amount(item['quantityBefore'], 8, nonnegative=True)
    amount(item['quantityAfter'], 8, nonnegative=True)
    amount(item['unitCostAfter'], nullable=True, nonnegative=True)
    return item['recordId']


def cash_key(item):
    return item.get('brokerAccountId'), item['currency']


def validate_cash(item):
    required = {'currency', 'balanceBefore', 'balanceAfter'}
    if not isinstance(item, dict) or not required <= item.keys() or item.keys() - required - {'brokerAccountId'}:
        raise ValueError
    if not re.fullmatch(r'[A-Z]{3}', item['currency']):
        raise ValueError
    broker_id(item.get('brokerAccountId'))
    amount(item['balanceBefore'], nullable=True)
    amount(item['balanceAfter'], nullable=True)
    return cash_key(item)


def validate_ledger_order(item):
    if not isinstance(item, dict):
        raise ValueError
    for field, limit in (('name', 160), ('recordId', 200), ('tif', 64), ('session', 64)):
        if field in item:
            text(item[field], limit)
    if item.get('broker') != '' and 'broker' in item:
        text(item['broker'], 160)
    account = broker_id(item.get('brokerAccountId'))
    if 'changedAt' in item:
        order_time(item['changedAt'])
    if 'triggerAbove' in item and (type(item['triggerAbove']) is not bool or 'triggerPrice' not in item):
        raise ValueError
    if 'expiresAt' in item:
        expiry = item['expiresAt']
        if len(expiry) == 10:
            date.fromisoformat(expiry)
        else:
            order_time(expiry)
    identifier, _ = validate_order({key: value for key, value in item.items()
                                    if key not in {'brokerAccountId', 'changedAt', 'expiresAt', 'triggerAbove'}})
    return str(identifier), {**item, 'brokerAccountId': account}


def index(items, validate):
    if not isinstance(items, list) or len(items) > ITEM_LIMIT:
        raise ValueError
    indexed = {}
    for item in items:
        key = validate(item)
        if key in indexed:
            raise ValueError
        indexed[key] = item
    return indexed


def validate_transaction(raw):
    common = {'requestId', 'kind', 'baseRevision'}
    if not isinstance(raw, dict) or not common <= raw.keys() or type(raw['baseRevision']) is not int:
        raise ValueError
    rid = UUID(raw['requestId'])
    if str(rid) != raw['requestId'] or not 0 <= raw['baseRevision'] < MAX_REVISION:
        raise ValueError
    if raw['kind'] == 'adopt':
        if raw.keys() != common | {'legacyRevision'} or raw['baseRevision'] != 0 or not re.fullmatch(r'[0-9a-f]{64}', raw['legacyRevision']):
            raise ValueError
        return rid, {}, {}, {}
    if raw['kind'] == 'merge':
        if raw.keys() != common | {'orderIds', 'mergedOrderId', 'filledAt'}:
            raise ValueError
        ids = raw['orderIds']
        if not isinstance(ids, list) or not 2 <= len(ids) <= ITEM_LIMIT or len(set(ids)) != len(ids):
            raise ValueError
        if raw['mergedOrderId'] in ids or any(str(UUID(id_)) != id_ for id_ in [*ids, raw['mergedOrderId']]):
            raise ValueError
        order_time(raw['filledAt'])
        return rid, {}, {}, {}
    if raw['kind'] != 'trade' or raw.keys() != common | {'orders', 'positions', 'cash'}:
        raise ValueError
    if not isinstance(raw['orders'], list) or not 1 <= len(raw['orders']) <= ITEM_LIMIT:
        raise ValueError
    orders = dict(validate_ledger_order(item) for item in raw['orders'])
    if len(orders) != len(raw['orders']):
        raise ValueError
    return rid, orders, index(raw['positions'], validate_position), index(raw['cash'], validate_cash)


async def ledger_head(conn, owner):
    return await (await conn.execute(
        'SELECT revision,snapshot,updated_at FROM native_ledger_heads WHERE owner_id=%s', (owner,),
    )).fetchone()


async def require_legacy_write(conn, owner, account_kind):
    if account_kind == 'real' and await (await conn.execute(
        'SELECT 1 FROM native_ledger_heads WHERE owner_id=%s', (owner,),
    )).fetchone():
        conflict('实盘账本已接入 App 原生同步，请通过原生账本提交')


async def legacy_baseline(conn, db, who, *, lock_orders=False):
    from .scope_coverage import require_global
    from .native_ledger_handoff import pending
    await require_global(conn, who.id)
    records = await (await conn.execute('''
        SELECT r.id,r.market,r.account_market,r.code,r.name,r.qty,r.broker_account_id
        FROM portfolio_records r LEFT JOIN broker_accounts b
          ON b.owner_id=r.owner_id AND b.id=r.broker_account_id AND b.deleted_at IS NULL
        WHERE r.owner_id=%s AND r.deleted_at IS NULL
          AND (r.qty IS NOT NULL OR r.trade_tip_id IS NOT NULL OR r.position_transfer_id IS NOT NULL)
          AND (r.broker_account_id IS NULL OR
          (b.account_kind='real' AND b.holding_source='manual'))
        ORDER BY r.id
    ''', (who.id,))).fetchall()
    positions = [{'recordId': r['id'], 'brokerAccountId': r['broker_account_id'], 'market': r['market'],
                  'accountMarket': r['account_market'] or r['market'], 'code': r['code'], 'name': r['name'],
                  'quantity': decimal_text(r['qty']), 'unitCost': None} for r in records]
    overview = await CashOverview(db).on_connection(conn, who)
    real = next(book for book in overview['books'] if book['accountKind'] == 'real')
    cash = [{'currency': row['currency'], 'brokerAccountId': None,
             'balance': decimal_text(Decimal(row['ownerBalance'])) if row['ownerBalance'] is not None else None}
            for row in real['currencies']]
    for broker in overview['accounts']:
        if broker['accountKind'] != 'real' or broker['holdingSource'] != 'manual':
            continue
        for row in broker['snapshot']['currencies']:
            value = row['balance']
            cash.append({'currency': row['currency'], 'brokerAccountId': broker['accountId'],
                         'balance': decimal_text(Decimal(value)) if value is not None else None})
    orders, history, transfers, blockers, numbers = await pending(conn, who.id, positions, lock=lock_orders)
    return {'positions': positions, 'cash': sorted(cash, key=lambda row: (row['brokerAccountId'] or '', row['currency'])),
            'orders': orders, 'orderHistory': history, 'adoptionBlockers': blockers, 'orderNumbers': numbers}, transfers


def conflict(message='原生账本版本已变化，请重新读取后确认'):
    raise HTTPException(409, message)


def transition(prior, item):
    status = item['status']
    if prior is None:
        if status not in {'pending', 'filled'} or item.get('editHistory'):
            conflict('原订单不存在或未接入原生账本')
        return
    stable = ('tradeId', 'recordId', 'side', 'createdAt', 'execution', 'orderType', 'parentOrderId', 'startsAt')
    if position_identity(prior) != position_identity(item) or any(item.get(key) != prior.get(key) for key in stable):
        conflict('原订单身份已变化')
    old = prior['status']
    if old == status == 'pending':
        mutable = {'quantity', 'orderPrice', 'price', 'fees', 'triggerPrice', 'triggerAbove',
                   'tif', 'session', 'expiresAt', 'changedAt'}
        if (not item.get('changedAt') or {k:v for k,v in item.items() if k not in mutable}
                != {k:v for k,v in prior.items() if k not in mutable}
                or Decimal(item['orderPrice']) != Decimal(item['price'])
                or all(item.get(key) == prior.get(key) for key in mutable - {'changedAt'})):
            conflict('待成改单须保留原单身份并记录实际变更')
        return
    incoming = item.get('deletedFrom', status)
    eligible = old == 'pending' and (status in {'filled', 'cancelled', 'expired'} or incoming == 'pending' and status == 'deleted')
    removed = old in {'filled', 'cancelled', 'expired'} and status == 'deleted' and incoming == old
    edited = (old == status == 'filled' or old == incoming == 'filled' and status == 'deleted') and extends_fill_history(prior, item)
    unchanged = (Decimal(item['quantity']) == Decimal(prior['quantity'])
                 and Decimal(item['orderPrice']) == Decimal(prior['orderPrice'])
                 and item.get('editHistory') == prior.get('editHistory')
                 and (old != 'filled' or same_fill(prior, item)))
    if not (edited or (eligible or removed) and unchanged):
        conflict('原订单状态或编辑历史已变化')
    if prior.get('mergedFromOrderIds') and status != 'deleted':
        conflict('合并成交保留精确原单金额，需分开核对原成交')


def settlement(item):
    market, account_market, _, broker = position_identity(item)
    currency = CURRENCIES[account_market]
    quantity, price, fees = (Decimal(item[key]) for key in ('quantity', 'price', 'fees'))
    buy = item['side'] == 'buy'
    gross = Decimal(item['grossAmount']) if item.get('mergedFromOrderIds') else quantity * price
    standard = gross + (fees if buy else -fees)
    value = item.get('settlementAmount')
    if (item.get('settlementCurrency', currency) != currency
            or account_market != market and (value is None or Decimal(value) <= 0)
            or account_market == market and value is not None and Decimal(value) != standard):
        raise HTTPException(400, '成交原币结算与订单不一致')
    net = standard if value is None else Decimal(value)
    return (broker, currency), quantity if buy else -quantity, -net if buy else net


async def checked_brokers(conn, owner, orders):
    accounts = {item.get('brokerAccountId') for item in orders.values()} - {None}
    if not accounts:
        return
    rows = await (await conn.execute('''
        SELECT id FROM broker_accounts WHERE owner_id=%s AND id=ANY(%s)
            AND deleted_at IS NULL AND account_kind='real' AND holding_source='manual'
    ''', (owner, sorted(accounts)))).fetchall()
    if {row['id'] for row in rows} != accounts:
        conflict('券商不属于本人可记录的实盘账户')


async def check_record_identities(conn, owner, state, orders):
    existing_ids = {row['recordId'] for row in state['positions']}
    new_positions = {order['recordId']: order for order in orders.values() if order['recordId'] not in existing_ids}
    if not new_positions:
        return
    rows = await (await conn.execute('''
        SELECT r.id,r.market,r.account_market,r.code,r.broker_account_id,
               r.qty,r.trade_tip_id,r.position_transfer_id,r.deleted_at,b.account_kind,b.holding_source
        FROM portfolio_records r LEFT JOIN broker_accounts b ON b.owner_id=r.owner_id
          AND b.id=r.broker_account_id AND b.deleted_at IS NULL
        WHERE r.owner_id=%s AND r.id=ANY(%s)
    ''', (owner, sorted(new_positions)))).fetchall()
    for row in rows:
        identity = (row['market'], row['account_market'] or row['market'], row['code'], row['broker_account_id'])
        if (row['deleted_at'] is not None or row['qty'] is not None or row['trade_tip_id'] is not None
                or row['position_transfer_id'] is not None or identity != position_identity(new_positions[row['id']])
                or row['broker_account_id'] is not None and (row['account_kind'], row['holding_source']) != ('real','manual')):
            conflict('持仓编号与现有记录冲突')


def append_history(history, item, now, request_id, prior=None):
    identifier = item['tradeId']
    events = list(history.get(identifier, []))
    if prior is not None and not events:
        events = [order_history_item(prior, prior['createdAt'], 1)]
    edit = item.get('editHistory')
    edited_at = edit[-1]['editedAt'] if edit and prior and edit != prior.get('editHistory') else None
    explicit = item.get('changedAt') or item.get('deletedAt') or edited_at or (item['createdAt'] if prior is None else None)
    occurred = explicit or now.isoformat()
    stamp = order_time(occurred)
    last_known = next((event['occurredAt'] for event in reversed(events) if event.get('timeSource') != 'server'), None)
    if (stamp < order_time(item['createdAt']) or stamp > now + timedelta(minutes=5)
            or explicit and last_known and stamp < order_time(last_known)):
        conflict('订单变更时间与原版本不一致')
    events.append({**order_history_item(item, occurred, (events[-1]['revision'] if events else 0) + 1),
                   'timeSource': 'app' if explicit else 'server', 'requestId': str(request_id)})
    history[identifier] = events


def order_history_item(item, occurred, revision):
    return {'revision': revision, 'occurredAt': occurred, 'status': item['status'],
            **{key: item[key] for key in ('quantity', 'price', 'orderPrice', 'fees')}}


def apply_trade(state, changed_orders, changed_positions, changed_cash, now, request_id):
    orders = {item['tradeId']: item for item in state['orders']}
    positions = {item['recordId']: item for item in state['positions']}
    cash = {cash_key(item): item for item in state['cash']}
    history = dict(state.get('orderHistory', {}))
    quantity_delta, cash_delta = defaultdict(Decimal), defaultdict(Decimal)
    identities = {}
    for identifier, item in changed_orders.items():
        before = orders.get(identifier)
        if before and item['status'] != 'pending':
            carried = {key: before[key] for key in ('expiresAt', 'triggerAbove', 'triggerPrice') if key in before}
            item = {**carried, **item}
        if before and before.get('mergedFromOrderIds'):
            item = {**item, **{key: before[key] for key in ('mergedFromOrderIds', 'grossAmount')}}
        transition(before, item)
        append_history(history, item, now, request_id, before)
        record = item['recordId']
        identity = position_identity(item)
        if record in positions and identity != position_identity(positions[record]):
            conflict('订单券商或证券与持仓不符')
        if record in identities and identity != identities[record]:
            conflict('同一笔持仓存在不同券商或证券')
        identities[record] = identity
        for sign, version in ((-1, before), (1, item)):
            if version and version['status'] == 'filled':
                key, quantity, money = settlement(version)
                quantity_delta[record] += sign * quantity
                cash_delta[key] += sign * money
        orders[identifier] = item

    global_keys = {(None, currency) for _, currency in cash_delta}
    if (changed_positions.keys() != quantity_delta.keys()
            or changed_cash.keys() - (cash_delta.keys() | global_keys)
            or any(key not in changed_cash and (None, key[1]) not in changed_cash for key in cash_delta)):
        raise HTTPException(400, '订单、持仓和原币现金变更必须一并提交')
    for record, change in changed_positions.items():
        position = positions.get(record)
        current = position['quantity'] if position is not None else '0'
        before, after = Decimal(change['quantityBefore']), Decimal(change['quantityAfter'])
        if current is None or Decimal(current) != before:
            conflict('持仓数量已变化或仍未知')
        if position_identity(change) != identities[record] or after != before + quantity_delta[record]:
            raise HTTPException(400, '订单与持仓数量变更不一致')
        if before > 0 and after > 0 and position['unitCost'] is None and change['unitCostAfter'] is not None:
            raise HTTPException(400, '缺少旧持仓成本依据')
        market, account_market, code, broker = position_identity(change)
        positions[record] = {'recordId': record, 'brokerAccountId': broker, 'market': market, 'accountMarket': account_market,
                             'code': code, 'name': change['name'], 'quantity': decimal_text(after), 'unitCost': change['unitCostAfter']}

    totals = defaultdict(Decimal)
    for (_, currency), delta in cash_delta.items():
        totals[currency] += delta
    for key, change in changed_cash.items():
        broker, currency = key
        current = cash.get(key, {}).get('balance')
        expected = Decimal(current) if current is not None else None
        before = amount(change['balanceBefore'], nullable=True)
        after = amount(change['balanceAfter'], nullable=True)
        delta = totals[currency] if broker is None else cash_delta[key]
        if expected != before:
            conflict('原币现金已变化，请重新读取')
        if after != (None if before is None else before + delta):
            raise HTTPException(400, '订单与原币现金变更不一致')
        cash[key] = {'currency': currency, 'brokerAccountId': broker, 'balance': decimal_text(after)}
    effects = {(None, currency): delta for currency, delta in totals.items()}
    effects.update({key: delta for key, delta in cash_delta.items() if key[0] is not None})
    for key, delta in effects.items():
        if key not in changed_cash:
            current = cash.get(key, {}).get('balance')
            balance = None if current is None else Decimal(current) + delta
            cash[key] = {'currency': key[1], 'brokerAccountId': key[0], 'balance': decimal_text(balance)}

    return {**state, 'positions': list(positions.values()), 'cash': list(cash.values()), 'orders': list(orders.values()),
            'orderHistory': history}


def apply_merge(state, raw, now, request_id):
    orders = {item['tradeId']: item for item in state['orders']}
    selected = [orders.get(identifier) for identifier in raw['orderIds']]
    identifier = raw['mergedOrderId']
    if identifier in orders or any(not order or order['status'] != 'filled' for order in selected):
        conflict('须选择本人仍生效且已成交的原单')
    template = selected[0]
    relation = set(raw['orderIds'])
    if (any(position_identity(item) != position_identity(template) or item['recordId'] != template['recordId']
            or item['side'] != template['side'] or item.get('parentOrderId') for item in selected)
            or any(item.get('parentOrderId') in relation and item['status'] == 'pending' for item in orders.values())):
        conflict('合并须使用同券商、同持仓、同方向且无在途附加单的成交')
    if not any(order_time(item['filledAt']) == order_time(raw['filledAt']) for item in selected):
        conflict('合并成交时间须选自原单')
    total_quantity = sum(Decimal(item['quantity']) for item in selected)
    total_fees = sum(Decimal(item['fees']) for item in selected)
    gross = sum(Decimal(item['grossAmount']) if item.get('mergedFromOrderIds')
                else Decimal(item['quantity']) * Decimal(item['price']) for item in selected)
    totals = [settlement(item) for item in selected]
    net = sum(entry[2] for entry in totals) * (-1 if template['side'] == 'buy' else 1)
    average = decimal_text((gross / total_quantity).quantize(Decimal('0.00000001'), rounding=ROUND_HALF_UP))
    combined = {key: template[key] for key in ('recordId','brokerAccountId','market','code','name','side','priceCurrency')}
    combined.update({'tradeId': identifier, 'status': 'filled', 'execution': 'recorded', 'orderType': 'limit',
        'quantity': decimal_text(total_quantity), 'price': average, 'orderPrice': average, 'fees': decimal_text(total_fees),
        'createdAt': now.isoformat(), 'filledAt': raw['filledAt'], 'settlementCurrency': totals[0][0][1],
        'settlementAmount': decimal_text(net)})
    if 'accountMarket' in template:
        combined['accountMarket'] = template['accountMarket']
    validate_ledger_order(combined)
    combined.update(grossAmount=decimal_text(gross), mergedFromOrderIds=raw['orderIds'])
    history = dict(state.get('orderHistory', {}))
    for item in selected:
        tombstone = {**item, 'status': 'deleted', 'deletedFrom': 'filled', 'deletedAt': now.isoformat(),
                     'mergedIntoOrderId': identifier}
        tombstone.pop('changedAt', None)
        append_history(history, tombstone, now, request_id, item)
        orders[item['tradeId']] = tombstone
    append_history(history, combined, now, request_id)
    orders[identifier] = combined
    return {**state, 'orders': list(orders.values()), 'orderHistory': history}


async def receipt(conn, owner, request_id):
    return await (await conn.execute(
        'SELECT fingerprint,receipt FROM native_ledger_transactions WHERE owner_id=%s AND request_id=%s',
        (owner, request_id),
    )).fetchone()


async def assign_order_numbers(conn, state, order_ids):
    numbers = state.get('orderNumbers', {})
    missing = [identifier for identifier in order_ids if identifier not in numbers]
    if missing:
        rows = await (await conn.execute("""
            SELECT order_id, nextval('trade_presentation_number')::text AS number
            FROM unnest(%s::text[]) AS pending(order_id)
        """, (missing,))).fetchall()
        state['orderNumbers'] = {**numbers, **{row['order_id']: row['number'] for row in rows}}


async def commit(conn, db, who, raw):
    request_id, orders, positions, cash = validate_transaction(raw)
    expected = fingerprint(raw)
    old = await receipt(conn, who.id, request_id)
    if old:
        if old['fingerprint'] != expected:
            conflict('原请求编号已用于不同内容')
        return old['receipt']
    await require_domain(conn, who.id, request_id, 'native_ledger')
    head = await ledger_head(conn, who.id)
    revision = head['revision'] if head else 0
    if revision != raw['baseRevision']:
        conflict()
    kind = raw['kind']
    now = (await (await conn.execute('SELECT clock_timestamp() AS at')).fetchone())['at']
    transfers = {}
    if kind == 'adopt':
        state, transfers = await legacy_baseline(conn, db, who, lock_orders=True)
        if fingerprint(state) != raw['legacyRevision']:
            conflict('旧账户基线已变化，请重新读取后确认接管')
        if state['adoptionBlockers']:
            conflict('存在尚不能完整接管的旧委托，请先核对在途订单')
        state.pop('adoptionBlockers')
    else:
        if not head:
            conflict('请先读取并接管旧账户基线')
        await checked_brokers(conn, who.id, orders)
        await check_record_identities(conn, who.id, head['snapshot'], orders)
        with localcontext() as context:
            context.prec = 80
            if kind == 'merge':
                state = apply_merge(head['snapshot'], raw, now, request_id)
                await assign_order_numbers(conn, state, (raw['mergedOrderId'],))
            else:
                state = apply_trade(head['snapshot'], orders, positions, cash, now, request_id)
                await assign_order_numbers(conn, state, orders)
    next_revision = revision + 1
    value = {'ownerId': who.id, 'requestId': str(request_id), 'kind': kind, 'sourceRevision': next_revision}
    await conn.execute('''
        INSERT INTO native_ledger_heads(owner_id,revision,snapshot) VALUES(%s,%s,%s)
        ON CONFLICT(owner_id) DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot,updated_at=clock_timestamp()
    ''', (who.id, next_revision, Jsonb(state)))
    for order_id, legacy_revision in transfers.items():
        await conn.execute('''
            INSERT INTO native_ledger_transferred_orders(owner_id,order_id,legacy_revision) VALUES(%s,%s,%s)
        ''', (who.id, order_id, legacy_revision))
    await conn.execute("INSERT INTO asset_request_domains(owner_id,request_id,domain) VALUES(%s,%s,'native_ledger')", (who.id, request_id))
    await conn.execute('''
        INSERT INTO native_ledger_transactions(owner_id,request_id,revision,fingerprint,event,receipt)
        VALUES(%s,%s,%s,%s,%s,%s)
    ''', (who.id, request_id, next_revision, expected, Jsonb(raw), Jsonb(value)))
    return value


def mount_native_ledger(app):
    db = app.state.db

    async def execute(request, request_id=None):
        headers = {'Cache-Control': 'no-store, private', 'Vary': 'Authorization', 'X-Alcor-API-Version': '2'}
        write = request.method == 'POST'
        try:
            if not app.state.native_ledger_enabled:
                raise HTTPException(404, '接口未启用')
            assert_native_origin(request, db.settings)
            who, grant = await native_identity(request, db, 'portfolio.write' if write else 'portfolio.read')
            if grant['client_id'] != CLIENT:
                raise HTTPException(401, '需要有效的 App 连接')
            if request.query_params:
                raise ValueError
            if write:
                if request.headers.get('content-type', '').split(';')[0].strip() != 'application/json':
                    raise ValueError
                if not await app.state.rate_limit(db, 'native-ledger:' + who.id, 120, window_seconds=60):
                    raise HTTPException(429, '同步频率过高，请稍后再试')
                raw = json.loads(await bounded_body(request, body_budget(TRANSACTIONS)), object_pairs_hook=unique)
            async with db.connection() as conn, conn.transaction():
                await serialize_brokers(conn, who.id, shared_read=not write)
                if write:
                    await lock_mutation_identity(conn, who, require_admin=False)
                    value = await commit(conn, db, who, raw)
                else:
                    await lock_read_identity(conn, who)
                    if request_id is not None:
                        old = await receipt(conn, who.id, request_id)
                        if not old:
                            raise HTTPException(404, '未找到已提交回执')
                        value = old['receipt']
                    else:
                        head = await ledger_head(conn, who.id)
                        state = head['snapshot'] if head else (await legacy_baseline(conn, db, who))[0]
                        value = {'ownerId': who.id, 'source': 'native' if head else 'legacy',
                                 'sourceRevision': head['revision'] if head else 0,
                                 'legacyRevision': None if head else fingerprint(state), **state}
            return JSONResponse({'code': 0, 'message': 'ok', 'data': value}, headers=headers)
        except UniqueViolation as exc:
            if exc.diag.constraint_name not in ('asset_request_domain', 'asset_request_domains_pkey', 'broker_request_domain'):
                raise
            return JSONResponse({'code': 40901, 'message': '原请求编号已用于其他金融操作', 'data': None},
                                status_code=409, headers=headers)
        except HTTPException as exc:
            return JSONResponse({'code': getattr(exc, 'business_code', exc.status_code * 100 + 1),
                                 'message': str(exc.detail), 'data': None}, status_code=exc.status_code,
                                headers={**headers, **(exc.headers or {})})
        except (ValueError, TypeError, AttributeError, KeyError, RecursionError):
            return JSONResponse({'code': 40001, 'message': '原生账本请求参数无效', 'data': None}, status_code=400, headers=headers)

    @app.get(PATH)
    async def snapshot(request: Request):
        return await execute(request)

    @app.post(TRANSACTIONS)
    async def transaction(request: Request):
        return await execute(request)

    @app.get(TRANSACTIONS + '/{request_id}')
    async def transaction_receipt(request_id: UUID, request: Request):
        return await execute(request, request_id)
