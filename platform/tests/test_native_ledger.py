import asyncio
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import pytest_asyncio

from alcor_api.cli import create_user
from alcor_api.main import create_app
from alcor_api.native_trading_cycle import cycle_range
from test_legacy_trade_corrections import native_headers
from test_trading import setup

ASSETS = '/api/v2/account-assets'
LEDGER = ASSETS + '/native-ledger'
TRANSACTIONS = LEDGER + '/transactions'
SCOPES = 'portfolio.read portfolio.write assets.read positions.read cash.read orders.read'


@pytest_asyncio.fixture
async def app(settings, request):
    enabled = getattr(request, 'param', True)
    instance = create_app(settings.model_copy(update={'native_ledger_enabled': enabled}))
    async with instance.router.lifespan_context(instance):
        yield instance


@pytest.mark.asyncio
@pytest.mark.parametrize('app', [False], indirect=True)
async def test_disabled_ledger_does_not_discover_or_accept_writes(client, admin, db):
    headers = await native_headers(db, admin, SCOPES)
    assert 'native_ledger' not in await data(client.get('/api/v2/auth/config'))
    await data(client.get(LEDGER, headers=headers), 404)
    await data(client.post(TRANSACTIONS, headers=headers, json={}), 404)


def order(record, broker=None, *, at, created=None, side='buy', quantity='15', price='300',
          fees='1.05', net='4501.05'):
    return {
        'tradeId': str(uuid4()), 'recordId': record, 'brokerAccountId': broker,
        'market': 'US', 'code': 'AAPL', 'name': 'Synthetic security', 'accountMarket': 'US',
        'side': side, 'status': 'filled', 'execution': 'recorded', 'quantity': quantity,
        'price': price, 'fees': fees, 'priceCurrency': 'USD', 'settlementCurrency': 'USD',
        'settlementAmount': net, 'orderType': 'limit', 'orderPrice': price,
        'createdAt': created or datetime.now(UTC).isoformat(), 'filledAt': at,
    }


def trade(base, fill, before, after, cash_before, cash_after, *, cost=None):
    return {
        'requestId': str(uuid4()), 'kind': 'trade', 'baseRevision': base, 'orders': [fill],
        'positions': [{k: fill[k] for k in ('recordId', 'brokerAccountId', 'market', 'accountMarket', 'code', 'name')}
                      | {'quantityBefore': before, 'quantityAfter': after, 'unitCostAfter': cost}],
        'cash': [{'currency': 'USD', 'brokerAccountId': fill['brokerAccountId'],
                  'balanceBefore': cash_before, 'balanceAfter': cash_after}],
    }


async def data(request, expected=200):
    response = await request
    assert response.status_code == expected, response.text
    return response.json().get('data')


async def adopt(client, headers, baseline):
    body = {'requestId': str(uuid4()), 'kind': 'adopt', 'baseRevision': 0,
            'legacyRevision': baseline['legacyRevision']}
    receipt = await data(client.post(TRANSACTIONS, headers=headers, json=body))
    assert receipt['sourceRevision'] == 1
    return receipt


@pytest.mark.asyncio
async def test_backdated_trade_changes_all_views_once_across_devices(client, admin, db):
    broker, record = await setup(client, amount='0', qty='18', cost=None)
    identifier = record['id']
    phone = await native_headers(db, admin, SCOPES)
    other_phone = await native_headers(db, admin, SCOPES)
    assert (await data(client.get('/api/v2/auth/config')))['native_ledger']['version'] == 1
    baseline = await data(client.get(LEDGER, headers=phone))
    assert baseline['source'] == 'legacy' and baseline['sourceRevision'] == 0
    assert baseline['positions'][0]['quantity'] == '18' and baseline['positions'][0]['unitCost'] is None
    assert baseline['positions'][0]['brokerAccountId'] == broker
    assert {item['brokerAccountId']: item['balance'] for item in baseline['cash']} == {None: '0', broker: '0'}
    async with db.connection() as conn:
        assert not await (await conn.execute('SELECT 1 FROM native_ledger_heads')).fetchone()
    await adopt(client, phone, baseline)
    at = '2026-10-28T22:50:00+08:00'
    fill = order(identifier, broker, at=at)
    body = trade(1, fill, '18', '33', '0', '-4501.05')
    body['cash'][0].pop('brokerAccountId')  # The shipping App DTO submits global cash.
    path = TRANSACTIONS + '/' + body['requestId']
    await data(client.get(path, headers=other_phone), 404)
    await data(client.post(TRANSACTIONS, headers=phone,
                           json={**body, 'cash': [dict(body['cash'][0], balanceAfter='-4500')]}), 400)
    assert (await data(client.get(LEDGER, headers=other_phone)))['sourceRevision'] == 1
    first, retry = await asyncio.gather(
        data(client.post(TRANSACTIONS, headers=phone, json=body)),
        data(client.post(TRANSACTIONS, headers=other_phone, json=body)),
    )
    assert first == retry == await data(client.get(path, headers=other_phone))
    assert first == {'sourceRevision': 2, 'requestId': body['requestId'], 'kind': 'trade', 'ownerId': admin}
    await data(client.post(TRANSACTIONS, headers=phone, json={**body, 'baseRevision': 2}), 409)
    await data(client.post(TRANSACTIONS, headers=phone, json={**body, 'requestId': str(uuid4())}), 409)
    snapshot = await data(client.get(LEDGER, headers=other_phone))
    assert snapshot['positions'][0]['quantity'] == '33' and snapshot['positions'][0]['unitCost'] is None
    assert snapshot['orders'] == [fill]
    assert {item['brokerAccountId']: item['balance'] for item in snapshot['cash']} == {None: '-4501.05', broker: '-4501.05'}
    positions = await data(client.get(ASSETS + '/positions', headers=other_phone))
    assert positions['items'][0]['qty'] == 33 and positions['items'][0]['cost'] is None
    summary = await data(client.get(ASSETS + '/summary', headers=other_phone))
    assert summary['summary']['totalCash'] == -4501.05
    cash = await data(client.get(ASSETS + '/cash', headers=other_phone))
    assert cash['balances'] == {'USD': -4501.05}
    broker_cash = await data(client.get(f'/api/v2/broker-accounts/{broker}/cash', headers=other_phone))
    assert broker_cash['currencies'][0]['balance'] == -4501.05
    for version in ('v1', 'v2'):
        response = await data(client.get(f'/api/{version}/records/{identifier}', headers=other_phone))
        assert response['qty'] == 33 and response['cost'] == '' and response['brokerAccountId'] == broker
    listing = await data(client.get('/api/v2/records?market=US&pageSize=1', headers=other_phone))
    assert listing[0]['qty'] == 33
    for suffix in ('/orders?scope=all', '/native-orders'):
        items = (await data(client.get(ASSETS + suffix, headers=other_phone)))['items']
        assert len(items) == 1 and items[0]['id'] == fill['tradeId']
        assert datetime.fromisoformat(items[0]['tradedAt']) == datetime.fromisoformat(at)
        assert items[0]['brokerAccountId'] == broker
    other_owner = await create_user(db.settings, 'other-ledger', 'other-ledger-test-password-1')
    unauthorized = await native_headers(db, other_owner, 'portfolio.read')
    await data(client.get(path, headers=unauthorized), 404)
    assert (await data(client.get(LEDGER, headers=unauthorized)))['orders'] == []
    async with db.connection() as conn:
        head = await (await conn.execute('SELECT count(*) AS n FROM native_ledger_transactions WHERE owner_id=%s', (admin,))).fetchone()
        assert head['n'] == 2
        legacy = await (await conn.execute('SELECT qty FROM portfolio_records WHERE owner_id=%s AND id=%s', (admin, identifier))).fetchone()
        assert legacy['qty'] == 18


@pytest.mark.asyncio
async def test_first_trade_and_order_lifecycle_with_no_cash_opening(client, admin, db):
    headers = await native_headers(db, admin, SCOPES)
    baseline = await data(client.get(LEDGER, headers=headers))
    await adopt(client, headers, baseline)
    now = datetime.now(UTC)
    fill = order('first-buy', at=now.isoformat(), quantity='2', price='25', fees='1', net='51')
    receipt = await data(client.post(TRANSACTIONS, headers=headers,
                                     json=trade(1, fill, '0', '2', None, None, cost='25.5')))
    assert receipt['sourceRevision'] == 2
    record = await data(client.get('/api/v2/records/first-buy', headers=headers))
    assert record['qty'] == 2 and record['cost'] == 25.5
    by_record = await data(client.get(ASSETS + '/orders?scope=all&recordId=first-buy', headers=headers))
    assert [item['id'] for item in by_record['items']] == [fill['tradeId']]
    cycle = cycle_range(now)[0].isoformat()
    result = await data(client.get(ASSETS + '/trading-cycle', params={'cycleStart': cycle}, headers=headers))
    assert result['items'][0]['id'] == fill['tradeId']
    assert result['items'][0]['positionQtyBefore'] is None
    assert result['uncertainRecords'] == ['first-buy']
    assert (await data(client.get(LEDGER, headers=headers)))['cash'] == [
        {'currency': 'USD', 'brokerAccountId': None, 'balance': None},
    ]

    sell = order('first-buy', at=now.isoformat(), side='sell', quantity='1', price='30', fees='1', net='29')
    pending = {k: v for k, v in sell.items() if k not in ('filledAt', 'settlementCurrency', 'settlementAmount')}
    pending.update(status='pending', execution='conditional')
    amended = dict(fill, price='26', orderPrice='26', settlementAmount='53', editHistory=[
        {'quantity': '2', 'price': '25', 'settlementAmount': '51', 'settlementCurrency': 'USD',
         'editedAt': (now + timedelta(seconds=1)).isoformat()},
    ])

    async def orders_only(base, item):
        return await data(client.post(TRANSACTIONS, headers=headers, json={'requestId': str(uuid4()),
            'kind': 'trade', 'baseRevision': base, 'orders': [item], 'positions': [], 'cash': []}))

    await data(client.post(TRANSACTIONS, headers=headers, json=trade(2, amended, '2', '2', None, None, cost='26.5')))
    await orders_only(3, pending)
    await orders_only(4, dict(pending, status='cancelled'))
    visible = (await data(client.get(ASSETS + '/orders?scope=all', headers=headers)))['items']
    cancelled = next(item for item in visible if item['id'] == pending['tradeId'])
    assert cancelled['nativeActions'] == {'cancel': False, 'delete': True, 'edit': False}
    stamp = (now + timedelta(seconds=2)).isoformat()
    await orders_only(5, dict(pending, status='deleted', deletedFrom='cancelled', deletedAt=stamp))
    legacy = {k: v for k, v in pending.items() if k != 'brokerAccountId'}
    await data(client.post(ASSETS + '/native-orders', headers=headers, json=legacy), 409)
    fresh_sell = dict(sell, tradeId=str(uuid4()))
    await data(client.post(TRANSACTIONS, headers=headers,
                           json=trade(6, fresh_sell, '2', '1', None, None, cost='26.5')))
    deleted_sale = dict(fresh_sell, status='deleted', deletedFrom='filled', deletedAt=stamp)
    await data(client.post(TRANSACTIONS, headers=headers,
                           json=trade(7, deleted_sale, '1', '2', None, None, cost='26.5')))
    snapshot = await data(client.get(LEDGER, headers=headers))
    assert snapshot['sourceRevision'] == 8 and snapshot['positions'][0]['quantity'] == '2'
    assert [item['status'] for item in snapshot['orders']] == ['filled', 'deleted', 'deleted']
    for suffix in ('/orders?scope=all', '/native-orders'):
        items = (await data(client.get(ASSETS + suffix, headers=headers)))['items']
        assert [(item['id'], item['price'], item['editCount']) for item in items] == [(fill['tradeId'], 26, 1)]
    eventual_sell = dict(sell, tradeId=str(uuid4()), execution='conditional')
    new_pending = {k: v for k, v in eventual_sell.items() if k not in ('filledAt', 'settlementCurrency', 'settlementAmount')}
    await orders_only(8, dict(new_pending, status='pending'))
    await data(client.post(TRANSACTIONS, headers=headers,
                           json=trade(9, eventual_sell, '2', '1', None, None, cost='26.5')))
    assert (await data(client.get(LEDGER, headers=headers)))['positions'][0]['quantity'] == '1'
