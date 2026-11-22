import asyncio
import re
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
import pytest_asyncio
from psycopg.errors import CheckViolation

from alcor_api.cli import create_user
from alcor_api.internal_orders import pending_reservations
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
    number = snapshot['orderNumbers'][fill['tradeId']]
    assert re.fullmatch(r'[0-9]{10}', number)
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
        assert items[0]['orderNo'] == number and items[0]['orderNoSource'] == 'platform_assigned'
        assert datetime.fromisoformat(items[0]['tradedAt']) == datetime.fromisoformat(at)
        assert items[0]['brokerAccountId'] == broker
        assert items[0]['orderActivity'] == [{'id': fill['tradeId'] + ':1', 'timestamp': at,
                                             'kind': 'filled', 'quantity': 15.0, 'price': 300.0}]
    flat = await data(client.get('/api/v2/orders?includeAppOrders=1', headers=other_phone))
    assert [(item['id'], item['orderNo']) for item in flat['orders']] == [(fill['tradeId'], number)]
    assert flat['coverage']['available'] == 1
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
    opened = await data(client.get(LEDGER, headers=headers))
    pending_number = opened['orderNumbers'][pending['tradeId']]
    assert re.fullmatch(r'[0-9]{10}', pending_number)
    await orders_only(4, dict(pending, status='cancelled'))
    visible = (await data(client.get(ASSETS + '/orders?scope=all', headers=headers)))['items']
    cancelled = next(item for item in visible if item['id'] == pending['tradeId'])
    assert cancelled['nativeActions'] == {'cancel': False, 'delete': True, 'edit': False}
    assert cancelled['orderNo'] == pending_number
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
    assert snapshot['orderNumbers'][pending['tradeId']] == pending_number
    assert snapshot['orderNumbers'][fill['tradeId']] == opened['orderNumbers'][fill['tradeId']]
    for suffix in ('/orders?scope=all', '/native-orders'):
        items = (await data(client.get(ASSETS + suffix, headers=headers)))['items']
        assert [(item['id'], item['price'], item['editCount']) for item in items] == [(fill['tradeId'], 26, 1)]
    eventual_sell = dict(sell, tradeId=str(uuid4()), execution='conditional')
    new_pending = {k: v for k, v in eventual_sell.items() if k not in ('filledAt', 'settlementCurrency', 'settlementAmount')}
    await orders_only(8, dict(new_pending, status='pending'))
    await data(client.post(TRANSACTIONS, headers=headers,
                           json=trade(9, eventual_sell, '2', '1', None, None, cost='26.5')))
    assert (await data(client.get(LEDGER, headers=headers)))['positions'][0]['quantity'] == '1'


@pytest.mark.asyncio
async def test_old_pending_transfers_once_with_original_revisions_and_a_write_fence(client, admin, db):
    broker, record = await setup(client)
    headers = await native_headers(db, admin, SCOPES + ' orders.write orders.cancel')
    path = ASSETS + '/trading'
    latest = await data(client.get(path, headers=headers))
    draft = {'accountId': admin, 'recordId': record['id'], 'recordRevision': record['revision'],
             'snapshotRevision': latest['snapshotRevision'], 'side': 'buy', 'mode': 'order',
             'orderType': 'limit', 'qty': 2, 'price': 20, 'fees': 1, 'tif': 'gtc', 'session': 'REGULAR'}
    preview = await data(client.post(path + '/preview', headers=headers, json=draft))
    await data(client.post(path + '/submissions', headers=headers, json={
        **draft, 'requestId': str(uuid4()), 'previewRevision': preview['previewRevision'],
    }))
    first = (await data(client.get(LEDGER, headers=headers)))
    assert first['adoptionBlockers'] == []
    initial = first['orders'][0]
    assert initial['status'] == 'pending' and initial['brokerAccountId'] == broker
    order_id = initial['tradeId']
    before_move = (await data(client.get(ASSETS + '/orders?scope=all', headers=headers)))['items'][0]
    assert before_move['cancellable'] and before_move['orderNo'].isdigit()
    latest = await data(client.get(path, headers=headers))
    amendment = {**draft, 'snapshotRevision': latest['snapshotRevision'], 'orderRevision': 1, 'qty': 3}
    edit_path = path + '/orders/' + order_id
    preview = await data(client.post(edit_path + '/preview', headers=headers, json=amendment))
    await data(client.put(edit_path, headers=headers, json={
        **amendment, 'requestId': str(uuid4()), 'previewRevision': preview['previewRevision'],
    }))
    await data(client.post(TRANSACTIONS, headers=headers, json={'requestId': str(uuid4()), 'kind': 'adopt',
        'baseRevision': 0, 'legacyRevision': first['legacyRevision']}), 409)
    handoff = await data(client.get(LEDGER, headers=headers))
    await adopt(client, headers, handoff)
    canonical = await data(client.get(LEDGER, headers=headers))
    assert canonical['orders'][0]['tradeId'] == order_id
    assert [event['quantity'] for event in canonical['orderHistory'][order_id]] == ['2', '3']
    cancellation = {'requestId': str(uuid4()), 'accountId': admin, 'orders': [
        {'orderId': order_id, 'recordId': record['id'], 'market': 'US', 'code': record['code'],
         'revision': 2, 'recordRevision': record['revision']},
    ]}
    await data(client.post(ASSETS + '/orders/cancellations', headers=headers, json=cancellation), 409)
    async with db.connection() as conn:
        reserves = await pending_reservations(conn, admin, 'real', 'USD')
        assert reserves['cash'] == 0
        with pytest.raises(CheckViolation) as rejected:
            async with conn.transaction():
                await conn.execute("UPDATE internal_orders SET status='cancelled',cancelled_at=now() "
                                   "WHERE owner_id=%s AND id=%s", (admin, order_id))
        assert rejected.value.diag.constraint_name == 'native_ledger_transferred_order_read_only'
    edited_at = datetime.now(UTC).isoformat()
    amended = {**canonical['orders'][0], 'quantity': '4', 'changedAt': edited_at, 'price': '21', 'orderPrice': '21'}
    update = {'requestId': str(uuid4()), 'kind': 'trade', 'baseRevision': 1,
              'orders': [amended], 'positions': [], 'cash': []}
    first, replay = await asyncio.gather(*(data(client.post(TRANSACTIONS, headers=headers, json=update)) for _ in range(2)))
    assert first == replay and first['sourceRevision'] == 2
    snapshot = await data(client.get(LEDGER, headers=headers))
    assert [(event['revision'], event['quantity']) for event in snapshot['orderHistory'][order_id]] == [(1,'2'),(2,'3'),(3,'4')]
    assert snapshot['orderHistory'][order_id][-1]['occurredAt'] == edited_at
    for path in ('/api/v1/account-assets/orders?scope=all', ASSETS + '/orders?scope=all', ASSETS + '/native-orders'):
        projected = (await data(client.get(path, headers=headers)))['items'][0]
        assert projected['id'] == order_id and projected['orderNo'] == before_move['orderNo']
        assert projected['nativeActions'] == {'cancel': True, 'delete': True, 'edit': True}
        assert projected['cancellable'] is False
        assert [(row['id'], row['kind'], row['quantity'], row['price']) for row in projected['orderActivity']] == [
            (order_id + ':3', 'amended', 4, 21),
            (order_id + ':2', 'amended', 3, 20),
            (order_id + ':1', 'submitted', 2, 20),
        ]
        assert projected['orderActivity'][0]['timestamp'] == edited_at
    old_mirror = {key: amended[key] for key in amended if key not in ('brokerAccountId', 'changedAt')}
    await data(client.post(ASSETS + '/native-orders', headers=headers, json=old_mirror), 409)


@pytest.mark.asyncio
async def test_legacy_cancellation_and_adoption_have_a_single_winner(client, admin, db):
    _, record = await setup(client)
    headers = await native_headers(db, admin, SCOPES + ' orders.write orders.cancel')
    path = ASSETS + '/trading'
    latest = await data(client.get(path, headers=headers))
    pending = {'accountId': admin, 'recordId': record['id'], 'recordRevision': record['revision'],
        'snapshotRevision': latest['snapshotRevision'], 'side': 'buy', 'mode': 'order',
        'orderType': 'limit', 'qty': 2, 'price': 20, 'fees': 1, 'tif': 'gtc', 'session': 'REGULAR'}
    preview = await data(client.post(path + '/preview', headers=headers, json=pending))
    await data(client.post(path + '/submissions', headers=headers, json={
        **pending, 'requestId': str(uuid4()), 'previewRevision': preview['previewRevision'],
    }))
    baseline = await data(client.get(LEDGER, headers=headers))
    order_id = baseline['orders'][0]['tradeId']
    adopt_request = {'requestId': str(uuid4()), 'kind': 'adopt', 'baseRevision': 0,
                     'legacyRevision': baseline['legacyRevision']}
    cancellation = {'requestId': str(uuid4()), 'accountId': admin, 'orders': [
        {'orderId': order_id, 'recordId': record['id'], 'market': 'US', 'code': record['code'],
         'revision': 1, 'recordRevision': record['revision']},
    ]}
    adoption, cancel = await asyncio.gather(
        client.post(TRANSACTIONS, headers=headers, json=adopt_request),
        client.post(ASSETS + '/orders/cancellations', headers=headers, json=cancellation),
    )
    assert sorted((adoption.status_code, cancel.status_code)) == [200, 409], (adoption.text, cancel.text)
    final = await data(client.get(LEDGER, headers=headers))
    if adoption.status_code == 200:
        assert final['source'] == 'native' and final['orders'][0]['tradeId'] == order_id
    else:
        assert final['source'] == 'legacy' and final['orders'] == []
        await adopt(client, headers, final)


@pytest.mark.asyncio
async def test_merge_keeps_exact_cash_and_original_trading_days(client, admin, db):
    broker, record = await setup(client, amount='0', qty='0', cost=None)
    headers = await native_headers(db, admin, SCOPES)
    await adopt(client, headers, await data(client.get(LEDGER, headers=headers)))
    now = datetime.now(UTC)
    earlier = now - timedelta(days=2)
    first = order(record['id'], broker, at=earlier.isoformat(), quantity='2', price='25', fees='1', net='51')
    second = order(record['id'], broker, at=now.isoformat(), quantity='3', price='33.33333333', fees='2', net='101.99999999')
    await data(client.post(TRANSACTIONS, headers=headers, json=trade(1, first, '0', '2', '0', '-51')))
    await data(client.post(TRANSACTIONS, headers=headers, json=trade(2, second, '2', '5', '-51', '-152.99999999')))
    original_numbers = (await data(client.get(LEDGER, headers=headers)))['orderNumbers']
    merge = {'requestId': str(uuid4()), 'kind': 'merge', 'baseRevision': 3,
             'orderIds': [first['tradeId'], second['tradeId']], 'mergedOrderId': str(uuid4()),
             'filledAt': second['filledAt']}
    await data(client.post(TRANSACTIONS, headers=headers,
                          json={**merge, 'filledAt': (earlier - timedelta(hours=1)).isoformat()}), 409)
    receipt = await data(client.post(TRANSACTIONS, headers=headers, json=merge))
    assert receipt == await data(client.post(TRANSACTIONS, headers=headers, json=merge))
    snapshot = await data(client.get(LEDGER, headers=headers))
    numbers = snapshot['orderNumbers']
    merged_number = numbers[merge['mergedOrderId']]
    assert re.fullmatch(r'[0-9]{10}', merged_number)
    assert {identifier: numbers[identifier] for identifier in merge['orderIds']} == original_numbers
    assert len(set(numbers.values())) == 3
    assert snapshot['positions'][0]['quantity'] == '5'
    assert {cash['balance'] for cash in snapshot['cash']} == {'-152.99999999'}
    combined = next(item for item in snapshot['orders'] if item['tradeId'] == merge['mergedOrderId'])
    assert combined['grossAmount'] == '149.99999999'
    assert combined['settlementAmount'] == '152.99999999'
    assert combined['filledAt'] == second['filledAt']
    assert combined['mergedFromOrderIds'] == merge['orderIds']
    assert all(item['mergedIntoOrderId'] == merge['mergedOrderId'] for item in snapshot['orders'] if item['status'] == 'deleted')
    items = (await data(client.get(ASSETS + '/orders?scope=all', headers=headers)))['items']
    assert [item['id'] for item in items] == [merge['mergedOrderId']]
    assert items[0]['orderNo'] == merged_number
    config = await data(client.get('/api/v2/auth/config'))
    assert config['account_assets']['features']['financial_order_basis'] is True
    v1 = await data(client.get('/api/v1/auth/config'))
    assert 'financial_order_basis' not in v1['account_assets']['features']
    path = ASSETS + '/orders?scope=all&status=all&basis=financial'
    executions = await data(client.get(path, headers=headers))
    assert executions['basis'] == 'financial' and executions['count'] == 2
    assert (executions['accountId'], executions['status'], executions['source'], executions['executionModel']) == (
        admin, 'all', 'local_trade_ledger', 'atomic_internal_orders',
    )
    assert [(item['id'], item['orderNo'], item['qty'], item['fees'], item['settlementAmount'])
            for item in executions['items']] == [
        (second['tradeId'], original_numbers[second['tradeId']], 3, 2, 101.99999999),
        (first['tradeId'], original_numbers[first['tradeId']], 2, 1, 51),
    ]
    for execution, original in zip(executions['items'], (second, first)):
        assert datetime.fromisoformat(execution['tradedAt']) == datetime.fromisoformat(original['filledAt'])
        assert execution['status'] == 'filled' and not any(execution['nativeActions'].values())
        assert execution['revision'] == snapshot['orderHistory'][execution['id']][-1]['revision']
    by_record = await data(client.get(path + '&recordId=' + record['id'], headers=headers))
    assert by_record['items'] == executions['items']
    today = await data(client.get(ASSETS + '/orders?scope=today&basis=financial', headers=headers))
    assert [item['id'] for item in today['items']] == [second['tradeId']]
    await data(client.get(path + '&basis=financial', headers=headers), 400)
    await data(client.get(ASSETS + '/orders?status=pending&basis=financial', headers=headers), 400)
    await data(client.get('/api/v1/account-assets/orders?basis=financial', headers=headers), 400)
    for original, stamp in ((first, earlier), (second, now)):
        result = await data(client.get(ASSETS + '/trading-cycle', headers=headers,
                                      params={'cycleStart': cycle_range(stamp)[0].isoformat()}))
        assert [item['id'] for item in result['items']] == [original['tradeId']]


@pytest.mark.asyncio
async def test_app_attachment_batch_records_children_and_cancels_sibling_atomically(client, admin, db):
    broker, record = await setup(client, amount='0', qty='0', cost=None)
    headers = await native_headers(db, admin, SCOPES)
    await adopt(client, headers, await data(client.get(LEDGER, headers=headers)))
    now = datetime.now(UTC)
    start, activation, execution = (now + timedelta(seconds=offset) for offset in range(3))
    parent_fill = order(record['id'], broker, at=activation.isoformat(), created=start.isoformat(),
                        quantity='2', price='24', fees='1', net='49')
    parent_fill.update(execution='conditional', orderPrice='25', changedAt=activation.isoformat())
    parent = {key: value for key, value in parent_fill.items()
              if key not in ('filledAt', 'settlementCurrency', 'settlementAmount', 'changedAt')}
    parent.update(status='pending', price='25')
    await data(client.post(TRANSACTIONS, headers=headers, json={
        'requestId': str(uuid4()), 'kind': 'trade', 'baseRevision': 1,
        'orders': [parent], 'positions': [], 'cash': [],
    }))

    def child(price, above):
        item = order(record['id'], broker, at=execution.isoformat(), created=activation.isoformat(),
                     side='sell', quantity='2', price=price, fees='1')
        return {key: value for key, value in item.items()
                if key not in ('filledAt', 'settlementCurrency', 'settlementAmount')} | {
                    'status': 'pending', 'execution': 'conditional', 'parentOrderId': parent['tradeId'],
                    'startsAt': activation.isoformat(), 'expiresAt': (now + timedelta(days=1)).date().isoformat(),
                    'session': 'regular', 'triggerPrice': price, 'triggerAbove': above,
                }

    take, stop = child('32', True), child('18', False)
    buy = trade(2, parent_fill, '0', '2', '0', '-49', cost='24.5')
    buy['orders'].extend((take, stop))
    await data(client.post(TRANSACTIONS, headers=headers, json=buy))
    opened = await data(client.get(LEDGER, headers=headers))
    assert {item['tradeId']: item['status'] for item in opened['orders']} == {
        parent['tradeId']: 'filled', take['tradeId']: 'pending', stop['tradeId']: 'pending',
    }
    for item in opened['orders'][1:]:
        assert item['parentOrderId'] == parent['tradeId'] and item['startsAt'] == activation.isoformat()
        assert item['triggerAbove'] == (item['tradeId'] == take['tradeId'])

    take_fill = dict(take, status='filled', filledAt=execution.isoformat(), changedAt=execution.isoformat(),
                     settlementCurrency='USD', settlementAmount='63')
    sell = trade(3, take_fill, '2', '0', '-49', '14')
    sell['orders'].append(dict(stop, status='cancelled', changedAt=execution.isoformat()))
    wrong_cash = {**sell, 'cash': [dict(sell['cash'][0], balanceAfter='15')]}
    await data(client.post(TRANSACTIONS, headers=headers, json=wrong_cash), 400)
    assert await data(client.get(LEDGER, headers=headers)) == opened
    receipt = await data(client.post(TRANSACTIONS, headers=headers, json=sell))
    assert receipt == await data(client.post(TRANSACTIONS, headers=headers, json=sell))
    closed = await data(client.get(LEDGER, headers=headers))
    assert closed['orderNumbers'] == opened['orderNumbers']
    assert {item['tradeId']: item['status'] for item in closed['orders']} == {
        parent['tradeId']: 'filled', take['tradeId']: 'filled', stop['tradeId']: 'cancelled',
    }
    assert closed['positions'][0]['quantity'] == '0'
    assert {item['balance'] for item in closed['cash']} == {'14'}
