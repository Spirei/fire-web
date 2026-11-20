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
FIELDS = {
    'tradeId', 'market', 'code', 'name', 'side', 'quantity', 'price', 'fees',
    'priceCurrency', 'filledAt', 'execution',
}
OPTIONAL = {'settlementCurrency', 'settlementAmount', 'broker'}
CURRENCIES = {'US': 'USD', 'HK': 'HKD', 'CN': 'CNY'}


def discovery():
    return {'version': 1, 'path': PATH, 'write_scope': 'portfolio.write',
            'idempotency': 'immutable-owner-trade-id'}


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


def mount_native_trade_sync(app):
    db = app.state.db

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
                    cursor = await conn.execute('''SELECT fill FROM native_synced_fills WHERE owner_id=%s
                                                   AND (%s::uuid IS NULL OR trade_id<%s::uuid)
                                                   ORDER BY trade_id DESC LIMIT 101''', (who.id, before, before))
                    rows = await cursor.fetchall()
                items = [row['fill'] for row in rows[:100]]
                value = {'ownerId': who.id, 'items': items, 'before': items[-1]['tradeId'] if len(rows) > 100 else None}
            return JSONResponse({'code': 0, 'message': 'ok', 'data': value}, headers=headers)
        except HTTPException as exc:
            code = getattr(exc, 'business_code', exc.status_code * 100 + 1)
            return JSONResponse({'code': code, 'message': str(exc.detail), 'data': None},
                                status_code=exc.status_code, headers=headers)
