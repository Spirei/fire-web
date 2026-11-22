"""Private mirror of committed device fills. No cloud portfolio posting occurs here."""

import json
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg.types.json import Jsonb

from .fx_provider_parser import unique
from .legacy_identity import assert_native_origin, native_identity
from .profile_http import bounded_body
from .security import lock_mutation_identity, lock_read_identity

PATH = '/api/v2/account-assets/native-fills'
ORDERS_PATH = '/api/v2/account-assets/native-orders'
FIELDS = {
    'tradeId', 'market', 'code', 'name', 'side', 'quantity', 'price', 'fees',
    'priceCurrency', 'filledAt', 'execution',
}
OPTIONAL = {'settlementCurrency', 'settlementAmount', 'broker'}
CURRENCIES = {'US': 'USD', 'HK': 'HKD', 'CN': 'CNY'}
ORDER_STATES = {'pending', 'filled', 'cancelled', 'expired'}
ORDER_FIELDS = FIELDS - {'filledAt'} | {'status', 'createdAt', 'recordId', 'orderPrice', 'orderType'}
ORDER_OPTIONAL = OPTIONAL | {'filledAt', 'accountMarket', 'tif', 'session', 'startsAt',
                             'triggerPrice', 'parentOrderId', 'deletedAt', 'deletedFrom'}


def discovery():
    return {'version': 1, 'path': PATH, 'write_scope': 'portfolio.write',
            'idempotency': 'immutable-owner-trade-id',
            'orders': {'version': 1, 'path': ORDERS_PATH, 'read_scope': 'portfolio.read',
                       'write_scope': 'portfolio.write', 'idempotency': 'owner-order-state-v1'}}


def validate_amount(value, scale, *, positive=False):
    if not isinstance(value, str) or not re.fullmatch(rf'-?[0-9]{{1,32}}(?:\.[0-9]{{1,{scale}}})?', value):
        raise ValueError
    number = Decimal(value)
    if positive and number <= 0:
        raise ValueError
    return number


def validate_fill(fill):
    try:
        if not isinstance(fill, dict) or not FIELDS <= fill.keys() or fill.keys() - FIELDS - OPTIONAL:
            raise ValueError
        if any(not isinstance(fill[key], str) for key in FIELDS):
            raise ValueError
        trade_id = UUID(fill['tradeId'])
        if str(trade_id) != fill['tradeId'] or CURRENCIES.get(fill['market']) != fill['priceCurrency']:
            raise ValueError
        if not (0 < len(fill['name']) <= 160 and re.fullmatch(r'[A-Za-z0-9.\-]{1,32}', fill['code'])):
            raise ValueError
        if fill['side'] not in ('buy', 'sell') or fill['execution'] not in ('recorded', 'conditional', 'recurring'):
            raise ValueError
        if any(validate_amount(fill[k], 8, positive=True) > Decimal('1000000000000000') for k in ('price', 'quantity')):
            raise ValueError
        if not 0 <= validate_amount(fill['fees'], 8) <= Decimal('1000000000000000'):
            raise ValueError
        occurred = datetime.fromisoformat(fill['filledAt'])
        if occurred.tzinfo is None or occurred > datetime.now(UTC) + timedelta(minutes=5):
            raise ValueError
        broker = fill.get('broker')
        if broker is not None and (not isinstance(broker, str) or len(broker) > 160):
            raise ValueError
        settle = fill.get('settlementAmount')
        currency = fill.get('settlementCurrency')
        if settle is not None:
            validate_amount(settle, 16)
        if (settle is None) != (currency is None) or currency not in (None, fill['priceCurrency'], 'CNY' if fill['market'] == 'HK' else fill['priceCurrency']):
            raise ValueError
        return trade_id, occurred
    except (ValueError, TypeError, OverflowError) as exc:
        raise HTTPException(400, '本机成交记录无效') from exc


def order_time(raw):
    if not isinstance(raw, str) or len(raw) > 40:
        raise ValueError
    stamp = datetime.fromisoformat(raw)
    if stamp.tzinfo is None:
        raise ValueError
    return stamp


def validate_order(item):
    try:
        if not isinstance(item, dict) or not ORDER_FIELDS <= item.keys() or item.keys() - ORDER_FIELDS - ORDER_OPTIONAL:
            raise ValueError
        if any(not isinstance(item[key], str) for key in ORDER_FIELDS):
            raise ValueError
        status = item['status']
        original_status = item.get('deletedFrom') if status == 'deleted' else status
        if original_status not in ORDER_STATES or (status == 'deleted') != ('deletedAt' in item and 'deletedFrom' in item):
            raise ValueError
        if status != 'deleted' and ('deletedAt' in item or 'deletedFrom' in item):
            raise ValueError
        trade_id = UUID(item['tradeId'])
        if str(trade_id) != item['tradeId'] or CURRENCIES.get(item['market']) != item['priceCurrency']:
            raise ValueError
        if not (0 < len(item['name']) <= 160 and 0 < len(item['recordId']) <= 200
                and re.fullmatch(r'[A-Za-z0-9.\-]{1,32}', item['code'])):
            raise ValueError
        if (item['side'] not in ('buy', 'sell') or item['orderType'] not in ('limit', 'market')
                or item['execution'] not in ('recorded', 'conditional', 'recurring')
                or (item['execution'] != 'conditional' and original_status != 'filled')):
            raise ValueError
        if any(validate_amount(item[k], 8, positive=True) > Decimal('1000000000000000')
               for k in ('price', 'quantity', 'orderPrice')) or not 0 <= validate_amount(item['fees'], 8) <= Decimal('1000000000000000'):
            raise ValueError
        created = order_time(item['createdAt'])
        future = datetime.now(UTC) + timedelta(minutes=5)
        if created > future:
            raise ValueError
        if status == 'deleted' and not created <= order_time(item['deletedAt']) <= future:
            raise ValueError
        if 'startsAt' in item:
            order_time(item['startsAt'])
        if 'parentOrderId' in item and (str(UUID(item['parentOrderId'])) != item['parentOrderId'] or item['parentOrderId'] == item['tradeId']):
            raise ValueError
        for field in ('tif', 'session'):
            if field in item and (not isinstance(item[field], str) or not 0 < len(item[field]) <= 64):
                raise ValueError
        if 'triggerPrice' in item:
            validate_amount(item['triggerPrice'], 8, positive=True)
        if 'broker' in item and (not isinstance(item['broker'], str) or len(item['broker']) > 160):
            raise ValueError
        if item.get('accountMarket', item['market']) not in (item['market'], 'CN' if item['market'] == 'HK' else item['market']):
            raise ValueError
        if original_status == 'filled':
            _, occurred = validate_fill({key: value for key, value in item.items() if key in FIELDS | OPTIONAL})
        else:
            if item.keys() & {'filledAt', 'settlementCurrency', 'settlementAmount'}:
                raise ValueError
            occurred = created
        return trade_id, occurred
    except (ValueError, TypeError, AttributeError, OverflowError) as exc:
        raise HTTPException(400, '本机订单记录无效') from exc


def same_fill(old, new):
    return (all(old.get(key) == new.get(key) for key in
                ('tradeId', 'market', 'code', 'side', 'priceCurrency', 'execution', 'settlementCurrency'))
            and order_time(old['filledAt']) == order_time(new['filledAt'])
            and all(Decimal(old[key]) == Decimal(new[key]) if old.get(key) is not None and new.get(key) is not None
                    else old.get(key) is None and new.get(key) is None
                    for key in ('quantity', 'price', 'fees', 'settlementAmount')))


async def lock_order(conn, owner, identifier):
    await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))',
                       (f'native-order:{owner}:{identifier}',))


async def save_order(conn, who, identifier, occurred, item):
    await lock_mutation_identity(conn, who, require_admin=False)
    await lock_order(conn, who.id, identifier)
    status = item['status']
    existing = await (await conn.execute('SELECT item FROM native_synced_orders WHERE owner_id=%s AND order_id=%s',
                                         (who.id, identifier))).fetchone()
    if existing:
        previous = existing['item']
        if previous == item:
            return
        immutable = ('tradeId', 'recordId', 'market', 'code', 'side', 'quantity', 'createdAt', 'orderPrice',
                     'execution', 'orderType', 'parentOrderId', 'startsAt')
        previous_status = previous['status']
        next_status = item['deletedFrom'] if status == 'deleted' else status
        legal = (previous_status == 'pending' and status != 'pending') or (
            previous_status in ORDER_STATES - {'pending'} and status == 'deleted' and next_status == previous_status)
        if (not legal or any(item.get(key) != previous.get(key) for key in immutable)
                or previous_status == 'filled' and not same_fill(previous, item)):
            raise HTTPException(409, '原订单状态已变化')
    legacy = await (await conn.execute('SELECT fill FROM native_synced_fills WHERE owner_id=%s AND trade_id=%s',
                                       (who.id, identifier))).fetchone()
    if legacy and (item.get('deletedFrom', status) != 'filled' or not same_fill(legacy['fill'], item)):
        raise HTTPException(409, '原成交编号已对应不同的记录')
    if status == 'filled' and not legacy:
        fill = {key: value for key, value in item.items() if key in FIELDS | OPTIONAL}
        await conn.execute('INSERT INTO native_synced_fills(owner_id,trade_id,occurred_at,fill) VALUES (%s,%s,%s,%s)',
                           (who.id, identifier, occurred, Jsonb(fill)))
    await conn.execute('''INSERT INTO native_synced_orders(owner_id,order_id,status,occurred_at,item)
                          VALUES (%s,%s,%s,%s,%s)
                          ON CONFLICT (owner_id,order_id) DO UPDATE
                          SET status=EXCLUDED.status, occurred_at=EXCLUDED.occurred_at,
                              item=EXCLUDED.item, synced_at=clock_timestamp()''',
                       (who.id, identifier, status, occurred, Jsonb(item)))


def order_projection(item):
    filled = item.get('status', 'filled') == 'filled'
    stamp = item.get('filledAt') or item['createdAt']
    qty, price = Decimal(item['quantity']), Decimal(item['price'])
    return {
        'id': item['tradeId'], 'orderNo': item['tradeId'], 'recordId': item.get('recordId', ''),
        'market': item['market'], 'accountMarket': item.get('accountMarket',
            'CN' if item['market'] == 'HK' and item.get('settlementCurrency') == 'CNY' else item['market']),
        'code': item['code'], 'name': item['name'], 'side': item['side'],
        'status': item.get('status', 'filled'), 'qty': float(qty), 'price': float(price),
        'fees': float(item['fees']), 'amount': float(qty * price), 'currency': item['priceCurrency'],
        'settlementCurrency': item.get('settlementCurrency'),
        'settlementAmount': float(item['settlementAmount']) if item.get('settlementAmount') is not None else None,
        'createdAt': item.get('createdAt'), 'tradedAt': stamp, 'startsAt': item.get('startsAt'),
        'orderType': item.get('orderType'), 'orderPrice': float(item.get('orderPrice', item['price'])),
        'executedPrice': float(price) if filled else None, 'filledQty': float(qty) if filled else 0,
        'triggerPrice': float(item['triggerPrice']) if item.get('triggerPrice') is not None else None,
        'parentOrderId': item.get('parentOrderId'), 'tif': item.get('tif'), 'session': item.get('session'),
        'broker': item.get('broker') or '', 'note': '', 'realizedPnl': None,
        'executionModel': 'app_order_mirror', 'apiManaged': True, 'cancellable': False,
        'actualFeeKnown': filled, 'brokerExecution': False,
    }


async def fetch_orders(conn, owner, *, before=None, limit=100, record_id=None, today=False):
    cursor = await conn.execute('''
        SELECT order_id,occurred_at,item FROM (
            SELECT order_id,occurred_at,item FROM native_synced_orders
            WHERE owner_id=%(owner)s AND status<>'deleted'
              AND (%(record)s::text IS NULL OR item->>'recordId'=%(record)s)
              AND (%(stamp)s::timestamptz IS NULL OR (occurred_at,order_id)<(%(stamp)s,%(id)s::uuid))
            UNION ALL
            SELECT trade_id,occurred_at,fill FROM native_synced_fills f
            WHERE owner_id=%(owner)s AND %(record)s::text IS NULL
              AND (%(stamp)s::timestamptz IS NULL OR (occurred_at,trade_id)<(%(stamp)s,%(id)s::uuid))
              AND NOT EXISTS (SELECT 1 FROM native_synced_orders o WHERE o.owner_id=f.owner_id AND o.order_id=f.trade_id)
        ) AS source
        CROSS JOIN LATERAL (SELECT CASE item->>'market' WHEN 'US' THEN 'America/New_York'
            WHEN 'HK' THEN 'Asia/Hong_Kong' ELSE 'Asia/Shanghai' END AS exchange) AS tz
        WHERE NOT %(today)s OR timezone(tz.exchange,occurred_at)::date=timezone(tz.exchange,now())::date
        ORDER BY occurred_at DESC,order_id DESC LIMIT %(limit)s
    ''', {'owner': owner, 'record': record_id, 'stamp': before[0] if before else None,
          'id': before[1] if before else None, 'limit': limit, 'today': today})
    return await cursor.fetchall()


def mount_native_trade_sync(app):
    db = app.state.db

    @app.post(ORDERS_PATH)
    @app.get(ORDERS_PATH)
    async def native_orders(request: Request):
        headers = {'Cache-Control': 'private, no-store', 'Vary': 'Authorization', 'X-Alcor-API-Version': '2'}
        upload = request.method == 'POST'
        try:
            assert_native_origin(request, db.settings)
            who, _ = await native_identity(request, db, 'portfolio.write' if upload else 'portfolio.read')
            params = request.query_params
            if upload:
                if params:
                    raise HTTPException(400, '不支持查询参数')
                if not await app.state.rate_limit(db, 'native-orders:' + who.id, 120, window_seconds=60):
                    raise HTTPException(429, '同步频率过高，请稍后再试')
                item = json.loads(await bounded_body(request, 8192), object_pairs_hook=unique)
                identifier, occurred = validate_order(item)
                async with db.connection() as conn, conn.transaction():
                    await save_order(conn, who, identifier, occurred, item)
                value = {'ownerId': who.id, 'tradeId': str(identifier), 'status': item['status']}
            else:
                if (set(params) - {'before', 'scope'} or any(len(params.getlist(key)) != 1 for key in params)
                        or params.get('scope', 'all') not in ('all', 'today')):
                    raise ValueError
                before = None
                if 'before' in params:
                    stamp, identifier = params['before'].split('|')
                    before = (order_time(stamp), UUID(identifier))
                async with db.connection() as conn, conn.transaction():
                    await lock_read_identity(conn, who, require_admin=False)
                    rows = await fetch_orders(conn, who.id, before=before, limit=101, today=params.get('scope') == 'today')
                tail = rows[99] if len(rows) > 100 else None
                value = {'ownerId': who.id, 'items': [order_projection(row['item']) for row in rows[:100]],
                         'before': f"{tail['occurred_at'].isoformat()}|{tail['order_id']}" if tail else None}
            return JSONResponse({'code': 0, 'message': 'ok', 'data': value}, headers=headers)
        except (ValueError, UnicodeError, RecursionError):
            return JSONResponse({'code': 40001, 'message': '订单同步参数无效', 'data': None}, status_code=400, headers=headers)
        except HTTPException as exc:
            return JSONResponse({'code': getattr(exc, 'business_code', exc.status_code * 100 + 1),
                                 'message': str(exc.detail), 'data': None}, status_code=exc.status_code, headers=headers)

    @app.get(PATH)
    @app.post(PATH)
    async def native_fills(request: Request):
        headers = {'Cache-Control': 'private, no-store', 'Vary': 'Authorization', 'X-Alcor-API-Version': '2'}
        upload = request.method == 'POST'
        try:
            assert_native_origin(request, db.settings)
            who, _ = await native_identity(request, db, 'portfolio.write' if upload else 'portfolio.read')
            if upload:
                if request.query_params:
                    raise HTTPException(400, '不支持查询参数')
                if not await app.state.rate_limit(db, 'native-fills:' + who.id, 120, window_seconds=60):
                    raise HTTPException(429, '同步频率过高，请稍后再试')
                try:
                    fill = json.loads(await bounded_body(request, 8192), object_pairs_hook=unique)
                except (ValueError, UnicodeError, RecursionError) as exc:
                    raise HTTPException(400, '本机成交数据无效') from exc
                trade_id, occurred = validate_fill(fill)
                async with db.connection() as conn, conn.transaction():
                    await lock_mutation_identity(conn, who, require_admin=False)
                    await lock_order(conn, who.id, trade_id)
                    deleted = await (await conn.execute('''SELECT 1 FROM native_synced_orders
                        WHERE owner_id=%s AND order_id=%s AND status='deleted' ''', (who.id, trade_id))).fetchone()
                    if deleted:
                        raise HTTPException(409, '原订单已删除')
                    await conn.execute('''INSERT INTO native_synced_fills(owner_id, trade_id, occurred_at, fill)
                                          VALUES (%s, %s, %s, %s) ON CONFLICT (owner_id, trade_id) DO NOTHING''',
                                       (who.id, trade_id, occurred, Jsonb(fill)))
                    row = await (await conn.execute('SELECT fill FROM native_synced_fills WHERE owner_id=%s AND trade_id=%s',
                                                    (who.id, trade_id))).fetchone()
                    if row['fill'] != fill:
                        raise HTTPException(409, '原成交编号已对应不同的记录')
                value = {'ownerId': who.id, 'tradeId': str(trade_id)}
            else:
                params = request.query_params
                if set(params) - {'before'} or len(params.getlist('before')) > 1:
                    raise HTTPException(400, '同步查询参数无效')
                try:
                    before = UUID(params['before']) if 'before' in params else None
                except ValueError as exc:
                    raise HTTPException(400, '成交分页游标无效') from exc
                async with db.connection() as conn, conn.transaction():
                    await lock_read_identity(conn, who, require_admin=False)
                    cursor = await conn.execute('''SELECT fill FROM native_synced_fills f WHERE owner_id=%s
                        AND (%s::uuid IS NULL OR trade_id<%s::uuid)
                        AND NOT EXISTS (SELECT 1 FROM native_synced_orders o
                            WHERE o.owner_id=f.owner_id AND o.order_id=f.trade_id AND o.status='deleted')
                        ORDER BY trade_id DESC LIMIT 101''', (who.id, before, before))
                    rows = await cursor.fetchall()
                items = [row['fill'] for row in rows[:100]]
                value = {'ownerId': who.id, 'items': items, 'before': items[-1]['tradeId'] if len(rows) > 100 else None}
            return JSONResponse({'code': 0, 'message': 'ok', 'data': value}, headers=headers)
        except HTTPException as exc:
            code = getattr(exc, 'business_code', exc.status_code * 100 + 1)
            return JSONResponse({'code': code, 'message': str(exc.detail), 'data': None},
                                status_code=exc.status_code, headers=headers)
