import asyncio
import re
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
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
async def test_backdated_trade_changes_all_views_once_across_devices(client, admin, db, app, monkeypatch):
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
    signals_before = (await client.get('/api/account/changes')).json()['revisions']['portfolio']
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
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url='http://testserver',
                                 headers={'Origin': 'http://testserver'}) as web:
        login = await web.post('/api/auth/login', json={'username': 'AdminOne', 'password': 'Synthetic9Pass'})
        assert login.status_code == 200, login.text
        session = (await web.get('/api/fire/session')).json()
        web.headers.update({'X-CSRF-Token': session['csrf'], 'X-Alcor-Expected-Account': admin})
        changes = await web.get('/api/account/changes')
        assert changes.status_code == 200, changes.text
        assert changes.json()['revisions']['portfolio'] > signals_before
        from alcor_api import legacy_registered_cash, portfolio_daily

        async def unreadable_historical_cash(*_args, **_kwargs):
            raise AssertionError('adopted accounts must read their current balance directly')

        with monkeypatch.context() as unavailable:
            unavailable.setattr(legacy_registered_cash, 'read_registered_cash', unreadable_historical_cash)
            assert (await web.get('/api/fire/funds')).json()['balances'] == {'USD': -4501.05}
            for suffix in ('?balancesOnly=1', '?limit=1'):
                assert (await data(web.get('/api/v1/funds' + suffix)))['balances'] == {'USD': -4501.05}
        assert (await web.get('/api/records')).json()[0]['qty'] == 33
        records = '/api/personal-data-transfer/records'
        archived = await web.get(records, params={'type': 'position', 'id': identifier})
        assert archived.status_code == 200, archived.text
        assert archived.json()['data']['qty'] == '33'
        folders = await web.get(records, params={'section': 'positions', 'groupBy': 'market'})
        assert folders.json()['items'] == [{'market': 'US', 'count': 1}]
        for section, expected_id in [('positions', identifier), ('trades', fill['tradeId']), ('funds', body['requestId'])]:
            listing = await web.get(records, params={'section': section})
            assert listing.status_code == 200, listing.text
            assert any(row['id'] == expected_id for row in listing.json()['items'])
        assert (await web.get(records, params={'section': 'positions'},
                              headers={'X-Alcor-Expected-Account': 'different'})).status_code == 403

        async def observed_close(_conn, _history, _owner, _row, day):
            return {'currency': 'USD', 'value': '200', 'tradeDay': day.isoformat()}, None

        monkeypatch.setattr(portfolio_daily, 'close_input', observed_close)
        day = datetime.now(UTC).date()
        for valuation_day in (day, day + timedelta(days=1)):
            value = await portfolio_daily.capture_day(db, None, admin, 'real', valuation_day,
                                                       now=portfolio_daily.boundary(valuation_day) + timedelta(hours=1))
            assert value['nativeLedgerRevision'] == 2
            assert value['cashByCurrency'] == {'USD': '-4501.05'}
            assert value['equity'] == '2098.95'
        history = await web.get('/api/fire/asset-analysis/trend')
        assert history.status_code == 200, history.text
        assert [(row['equity'], row['pnl']) for row in history.json()['items'][:2]] == [('2098.95', '0.00'), ('2098.95', None)]

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
    other_device = await native_headers(db, admin, SCOPES)
    baseline = await data(client.get(LEDGER, headers=headers))
    await adopt(client, headers, baseline)

    foreign_owner = await create_user(db.settings, 'separate-ledger', 'separate-ledger-test-password-1')
    foreign_device = await native_headers(db, foreign_owner, SCOPES)

    async def portfolio_revision(device=other_device):
        changes = await data(client.get('/api/v2/account-sync', headers=device))
        return changes['revisions']['portfolio']

    revision = await portfolio_revision()
    foreign_revision = await portfolio_revision(foreign_device)
    now = datetime.now(UTC)
    fill = order('first-buy', at=now.isoformat(), quantity='2', price='25', fees='1', net='51')
    create = trade(1, fill, '0', '2', None, None, cost='25.5')
    receipt = await data(client.post(TRANSACTIONS, headers=headers, json=create))
    assert receipt['sourceRevision'] == 2
    assert await portfolio_revision() == revision + 1
    assert await data(client.post(TRANSACTIONS, headers=headers, json=create)) == receipt
    assert await portfolio_revision() == revision + 1
    record = await data(client.get('/api/v2/records/first-buy', headers=other_device))
    assert record['qty'] == 2 and record['cost'] == 25.5
    by_record = await data(client.get(ASSETS + '/orders?scope=all&recordId=first-buy', headers=headers))
    assert [item['id'] for item in by_record['items']] == [fill['tradeId']]
    cycle = cycle_range(now)[0].isoformat()
    result = await data(client.get(ASSETS + '/trading-cycle', params={'cycleStart': cycle}, headers=headers))
    assert result['items'][0]['id'] == fill['tradeId']
    assert result['items'][0]['positionQtyBefore'] == 0
    assert result['items'][0]['positionQtyAfter'] == 2
    assert result['uncertainRecords'] == []
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

    await data(client.post(TRANSACTIONS, headers=headers, json=trade(2, amended, '2', '2', None, None)), 400)
    assert await portfolio_revision() == revision + 1
    await data(client.post(TRANSACTIONS, headers=headers, json=trade(2, amended, '2', '2', None, None, cost='26.5')))
    assert await portfolio_revision() == revision + 2
    amended_record = await data(client.get('/api/v2/records/first-buy', headers=other_device))
    assert amended_record['qty'] == 2 and amended_record['cost'] == 26.5
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
    before_delete = await portfolio_revision()
    invalid_delete = trade(7, deleted_sale, '1', '3', None, None, cost='26.5')
    await data(client.post(TRANSACTIONS, headers=headers, json=invalid_delete), 400)
    assert await portfolio_revision() == before_delete
    await data(client.post(TRANSACTIONS, headers=headers,
                           json=trade(7, deleted_sale, '1', '2', None, None, cost='26.5')))
    assert await portfolio_revision() == before_delete + 1
    assert await portfolio_revision(foreign_device) == foreign_revision
    assert (await data(client.get(LEDGER, headers=foreign_device)))['orders'] == []
    snapshot = await data(client.get(LEDGER, headers=other_device))
    assert snapshot['sourceRevision'] == 8 and snapshot['positions'][0]['quantity'] == '2'
    assert [item['status'] for item in snapshot['orders']] == ['filled', 'deleted', 'deleted']
    assert snapshot['orderNumbers'][pending['tradeId']] == pending_number
    assert snapshot['orderNumbers'][fill['tradeId']] == opened['orderNumbers'][fill['tradeId']]
    for suffix in ('/orders?scope=all', '/native-orders'):
        items = (await data(client.get(ASSETS + suffix, headers=other_device)))['items']
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


async def _create_manual_broker_and_record(client, *, name, code, qty, cost, price='100', currencies=('USD',)):
    created = await client.post(
        '/api/broker-accounts',
        json={
            'request_id': str(uuid4()), 'name': name, 'provider_id': None,
            'account_kind': 'real', 'currency': currencies[0], 'currencies': list(currencies),
        },
    )
    assert created.status_code == 201, created.text
    broker = created.json()['data']['id']
    preview = await client.post(
        '/api/portfolio/records/preview',
        json={
            'kind': 'create',
            'data': {
                'name': f'Synthetic {code}', 'code': code, 'market': 'US', 'accountMarket': '',
                'price': price, 'qty': qty, 'cost': cost, 'group': '', 'note': '',
                'brokerAccountId': broker,
            },
        },
    )
    assert preview.status_code == 200, preview.text
    confirmed = await client.post(
        '/api/portfolio/records/confirm',
        json={'previewId': preview.json()['previewId'], 'requestId': str(uuid4())},
    )
    assert confirmed.status_code == 200, confirmed.text
    return broker, confirmed.json()['record']


@pytest.mark.asyncio
async def test_adoption_preserves_legacy_cost_registered_cash_and_clears_past_cycle_uncertain(
    client, app, admin, db, tmp_path,
):
    from test_legacy_registered_cash import archive, reseal, sealed_book, store_packet

    stored = sealed_book()
    stored['originals']['funds'][0]['amount'] = '12083.51'  # +27 stockNetFlow = 12110.51 USD
    reseal(stored)
    binding, _ = archive(tmp_path, stored)
    app.state.db.settings.backup_dir = tmp_path
    await store_packet(db, admin, stored, binding)

    longbridge, googl = await _create_manual_broker_and_record(
        client, name='Longbridge', code='GOOGL', qty='18', cost='367.486', price='320',
    )
    ibkr_resp = await client.post(
        '/api/broker-accounts',
        json={
            'request_id': str(uuid4()), 'name': 'IBKR', 'provider_id': None,
            'account_kind': 'real', 'currency': 'USD', 'currencies': ['USD'],
        },
    )
    assert ibkr_resp.status_code == 201, ibkr_resp.text
    ibkr = ibkr_resp.json()['data']['id']

    headers = await native_headers(db, admin, SCOPES)
    baseline = await data(client.get(LEDGER, headers=headers))
    assert baseline['positions'] == [{
        'recordId': googl['id'], 'brokerAccountId': longbridge, 'market': 'US', 'accountMarket': 'US',
        'code': 'GOOGL', 'name': 'Synthetic GOOGL', 'quantity': '18', 'unitCost': '367.486',
    }]
    cash_by_key = {(item['brokerAccountId'], item['currency']): item['balance'] for item in baseline['cash']}
    assert cash_by_key[(None, 'USD')] == '12110.51'
    assert cash_by_key[(None, 'HKD')] == '0'
    assert cash_by_key[(longbridge, 'USD')] is None
    assert cash_by_key[(ibkr, 'USD')] is None

    await adopt(client, headers, baseline)
    old_buy_1 = order(
        googl['id'], longbridge, at='2026-10-28T22:30:00+08:00',
        quantity='15', price='300', fees='1.05', net='4501.05',
    )
    old_buy_1.update(code='GOOGL', name='Synthetic GOOGL')
    tx1 = trade(1, old_buy_1, '18', '33', '12110.51', '7609.46', cost='336.84236364')
    tx1['cash'][0].pop('brokerAccountId')
    await data(client.post(TRANSACTIONS, headers=headers, json=tx1))

    old_buy_2 = order(
        'skuu-native-rec', ibkr, at='2026-11-20T22:30:00+08:00',
        quantity='300', price='10.0068', fees='1.50', net='3003.54',
    )
    old_buy_2.update(code='SKUU', name='Synthetic SKUU')
    tx2 = trade(2, old_buy_2, '0', '300', '7609.46', '4605.92', cost='10.0118')
    tx2['cash'][0].pop('brokerAccountId')
    await data(client.post(TRANSACTIONS, headers=headers, json=tx2))

    positions = await data(client.get(ASSETS + '/positions', headers=headers))
    by_code = {item['code']: item for item in positions['items']}
    assert by_code['GOOGL']['qty'] == 33 and by_code['GOOGL']['cost'] == 336.84236364
    assert by_code['SKUU']['qty'] == 300 and by_code['SKUU']['cost'] == 10.0118

    cash = await data(client.get(ASSETS + '/cash', headers=headers))
    assert cash['complete'] is True
    assert cash['balances']['USD'] == 4605.92

    summary = await data(client.get(ASSETS + '/summary', headers=headers))
    assert summary['summary']['costComplete'] is True
    assert summary['summary']['cashComplete'] is True
    assert summary['summary']['totalCash'] == 4605.92

    cycle = await data(client.get(ASSETS + '/trading-cycle', headers=headers))
    assert cycle['items'] == []
    assert cycle['uncertainRecords'] == []


@pytest.mark.asyncio
async def test_trading_cycle_reconstructs_same_day_chain_and_flags_ambiguous_cases(client, admin, db):
    broker, record = await setup(client, amount='5000', qty='20', cost='100')
    headers = await native_headers(db, admin, SCOPES)
    await adopt(client, headers, await data(client.get(LEDGER, headers=headers)))
    now = datetime.now(UTC)
    wall, _ = cycle_range(now)
    in_cycle_1 = wall + timedelta(minutes=1)
    in_cycle_2 = wall + timedelta(minutes=2)
    earlier_cycle = wall - timedelta(hours=2)

    buy_old = order(record['id'], broker, at=earlier_cycle.isoformat(), created=earlier_cycle.isoformat(),
                    side='buy', quantity='5', price='100', fees='0', net='500')
    await data(client.post(TRANSACTIONS, headers=headers,
                           json=trade(1, buy_old, '20', '25', '5000', '4500', cost='100')))

    buy_today = order(record['id'], broker, at=in_cycle_1.isoformat(), created=in_cycle_1.isoformat(),
                      side='buy', quantity='10', price='110', fees='0', net='1100')
    await data(client.post(TRANSACTIONS, headers=headers,
                           json=trade(2, buy_today, '25', '35', '4500', '3400', cost='102.85714286')))

    sell_today = order(record['id'], broker, at=in_cycle_2.isoformat(), created=in_cycle_2.isoformat(),
                       side='sell', quantity='4', price='120', fees='0', net='480')
    await data(client.post(TRANSACTIONS, headers=headers,
                           json=trade(3, sell_today, '35', '31', '3400', '3880', cost='102.85714286')))

    today = await data(client.get(ASSETS + '/trading-cycle', headers=headers))
    assert today['uncertainRecords'] == []
    ordered = sorted(today['items'], key=lambda row: row['tradedAt'])
    assert [(row['id'], row['positionQtyBefore'], row['positionQtyAfter']) for row in ordered] == [
        (buy_today['tradeId'], 25, 35),
        (sell_today['tradeId'], 35, 31),
    ]

    past_start = cycle_range(earlier_cycle)[0].isoformat()
    past = await data(client.get(ASSETS + '/trading-cycle', params={'cycleStart': past_start}, headers=headers))
    assert [row['id'] for row in past['items']] == [buy_old['tradeId']]
    assert past['items'][0]['positionQtyBefore'] is None
    assert past['uncertainRecords'] == [record['id']]


@pytest.mark.asyncio
async def test_repair_native_ledger_baseline_backfills_cost_and_registered_cash_idempotently(
    client, app, admin, db, tmp_path,
):
    from psycopg.types.json import Jsonb
    from alcor_api.native_ledger_repair import repair_native_ledger_baseline
    from test_legacy_registered_cash import archive, reseal, sealed_book, store_packet

    stored = sealed_book()
    stored['originals']['funds'][0]['amount'] = '12083.51'  # +27 = 12110.51 USD
    reseal(stored)
    binding, _ = archive(tmp_path, stored)
    app.state.db.settings.backup_dir = tmp_path
    db.settings.backup_dir = tmp_path
    await store_packet(db, admin, stored, binding)

    longbridge, googl = await _create_manual_broker_and_record(
        client, name='Longbridge', code='GOOGL', qty='18', cost='367.486', price='320',
    )
    nvda_preview = await client.post(
        '/api/portfolio/records/preview',
        json={
            'kind': 'create',
            'data': {
                'name': 'Synthetic NVDA', 'code': 'NVDA', 'market': 'US', 'accountMarket': '',
                'price': '130', 'qty': '10', 'cost': '120', 'group': '', 'note': '',
                'brokerAccountId': longbridge,
            },
        },
    )
    assert nvda_preview.status_code == 200, nvda_preview.text
    nvda = (await client.post(
        '/api/portfolio/records/confirm',
        json={'previewId': nvda_preview.json()['previewId'], 'requestId': str(uuid4())},
    )).json()['record']

    ibkr_resp = await client.post(
        '/api/broker-accounts',
        json={
            'request_id': str(uuid4()), 'name': 'IBKR', 'provider_id': None,
            'account_kind': 'real', 'currency': 'USD', 'currencies': ['USD'],
        },
    )
    ibkr = ibkr_resp.json()['data']['id']

    headers = await native_headers(db, admin, SCOPES)
    # Simulate old ab36d6c8 buggy adoption (unitCost=None, global cash=None) + GOOGL/SKUU fills.
    googl_fill = order(
        googl['id'], longbridge, at='2026-10-28T22:30:00+08:00',
        quantity='15', price='300', fees='1.05', net='4501.05',
    )
    googl_fill.update(code='GOOGL', name='Synthetic GOOGL')
    skuu_fill = order(
        'skuu-prod-rec', ibkr, at='2026-11-20T22:30:00+08:00',
        quantity='300', price='10.0068', fees='1.50', net='3003.54',
    )
    skuu_fill.update(code='SKUU', name='Synthetic SKUU')
    buggy_snapshot = {
        'positions': [
            {'recordId': googl['id'], 'brokerAccountId': longbridge, 'market': 'US', 'accountMarket': 'US',
             'code': 'GOOGL', 'name': 'Synthetic GOOGL', 'quantity': '33', 'unitCost': None},
            {'recordId': nvda['id'], 'brokerAccountId': longbridge, 'market': 'US', 'accountMarket': 'US',
             'code': 'NVDA', 'name': 'Synthetic NVDA', 'quantity': '10', 'unitCost': None},
            {'recordId': 'skuu-prod-rec', 'brokerAccountId': ibkr, 'market': 'US', 'accountMarket': 'US',
             'code': 'SKUU', 'name': 'Synthetic SKUU', 'quantity': '300', 'unitCost': '10.0118'},
        ],
        'cash': [
            {'currency': 'USD', 'brokerAccountId': None, 'balance': None},
            {'currency': 'USD', 'brokerAccountId': longbridge, 'balance': None},
            {'currency': 'USD', 'brokerAccountId': ibkr, 'balance': None},
        ],
        'orders': [googl_fill, skuu_fill],
        'orderHistory': {},
        'orderNumbers': {googl_fill['tradeId']: '0000000001', skuu_fill['tradeId']: '0000000002'},
    }
    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            'INSERT INTO native_ledger_heads(owner_id,revision,snapshot) VALUES(%s,3,%s)',
            (admin, Jsonb(buggy_snapshot)),
        )

    dry = await repair_native_ledger_baseline(db, admin, apply=False)
    assert dry['changed'] is True and dry['applied'] is False and dry['revision'] == 3 and dry['nextRevision'] == 4
    pos_map = {item['code']: item['unitCostAfter'] for item in dry['positionUpdates']}
    assert pos_map == {'GOOGL': '336.84236364', 'NVDA': '120'}
    cash_map = {item['currency']: item['balanceAfter'] for item in dry['cashUpdates']}
    assert cash_map['USD'] == '4605.92'
    assert (await data(client.get(LEDGER, headers=headers)))['sourceRevision'] == 3

    applied = await repair_native_ledger_baseline(db, admin, apply=True)
    assert applied['changed'] is True and applied['applied'] is True and applied['revision'] == 4

    again = await repair_native_ledger_baseline(db, admin, apply=True)
    assert again['changed'] is False and again['applied'] is False and again['revision'] == 4

    repaired_ledger = await data(client.get(LEDGER, headers=headers))
    assert repaired_ledger['sourceRevision'] == 4
    repaired_positions = {item['code']: item for item in repaired_ledger['positions']}
    assert repaired_positions['GOOGL']['unitCost'] == '336.84236364'
    assert repaired_positions['NVDA']['unitCost'] == '120'
    assert repaired_positions['SKUU']['unitCost'] == '10.0118'

    summary = await data(client.get(ASSETS + '/summary', headers=headers))
    assert summary['summary']['costComplete'] is True
    assert summary['summary']['cashComplete'] is True
    assert summary['summary']['totalCash'] == 4605.92

    # Subsequent native trade on previously untouched NVDA succeeds cleanly at revision 4 -> 5.
    nvda_buy = order(
        nvda['id'], longbridge, at='2026-11-23T22:00:00+08:00',
        quantity='5', price='150', fees='1', net='751',
    )
    nvda_buy.update(code='NVDA', name='Synthetic NVDA')
    tx_nvda = trade(4, nvda_buy, '10', '15', '4605.92', '3854.92', cost='130.06666667')
    tx_nvda['cash'][0].pop('brokerAccountId')
    receipt = await data(client.post(TRANSACTIONS, headers=headers, json=tx_nvda))
    assert receipt['sourceRevision'] == 5


@pytest.mark.asyncio
async def test_partial_sale_keeps_cost_and_repairs_old_missing_basis(client, admin, db):
    from psycopg.types.json import Jsonb
    from alcor_api.native_ledger import ledger_head
    from alcor_api.native_ledger_repair import repair_native_ledger_baseline

    broker, record = await setup(client, amount='100', qty='47', cost='-0.125')
    first_device = await native_headers(db, admin, SCOPES)
    second_device = await native_headers(db, admin, SCOPES)
    baseline = await data(client.get(LEDGER, headers=first_device))
    await adopt(client, first_device, baseline)
    now = datetime.now(UTC)
    sell = order(record['id'], broker, at=now.isoformat(), side='sell',
                 quantity='30', price='12.5', fees='0.75', net='374.25')
    body = trade(1, sell, '47', '17', '100', '474.25', cost='-0.125')
    body['cash'][0].pop('brokerAccountId')
    lost_cost = {**body, 'positions': [{**body['positions'][0], 'unitCostAfter': None}]}
    await data(client.post(TRANSACTIONS, headers=first_device, json=lost_cost), 400)
    wrong_cost = {**body, 'positions': [{**body['positions'][0], 'unitCostAfter': '12.5'}]}
    await data(client.post(TRANSACTIONS, headers=first_device, json=wrong_cost), 400)
    await data(client.get(TRANSACTIONS + '/' + body['requestId'], headers=second_device), 404)
    receipt = await data(client.post(TRANSACTIONS, headers=first_device, json=body))
    assert await data(client.get(TRANSACTIONS + '/' + body['requestId'], headers=second_device)) == receipt
    snapshot = await data(client.get(LEDGER, headers=second_device))
    assert [(p['quantity'], p['unitCost']) for p in snapshot['positions']] == [('17', '-0.125')]
    assert snapshot['orders'][0]['tradeId'] == sell['tradeId']

    async with db.connection() as conn, conn.transaction():
        head = await ledger_head(conn, admin)
        head['snapshot']['positions'][0]['unitCost'] = None
        await conn.execute('UPDATE native_ledger_heads SET snapshot=%s WHERE owner_id=%s', (Jsonb(head['snapshot']), admin))
    preview = await repair_native_ledger_baseline(db, admin, apply=False)
    assert [p['unitCostAfter'] for p in preview['positionUpdates']] == ['-0.125']
    assert preview['cashUpdates'] == []
    assert (await data(client.get(LEDGER, headers=second_device)))['positions'][0]['unitCost'] is None
    assert (await repair_native_ledger_baseline(db, admin, apply=True))['applied']
    assert not (await repair_native_ledger_baseline(db, admin, apply=True))['applied']
    repaired = await data(client.get(LEDGER, headers=second_device))
    assert repaired['orders'] == snapshot['orders'] and repaired['cash'] == snapshot['cash']
    assert repaired['positions'][0]['unitCost'] == '-0.125'
    summary = await data(client.get(ASSETS + '/summary', headers=second_device))
    assert summary['summary']['costComplete']

    later = order(record['id'], broker, at=now.isoformat(), side='sell',
                  quantity='5', price='10', fees='1', net='49')
    later_trade = trade(repaired['sourceRevision'], later, '17', '12', '474.25', '523.25', cost='-0.125')
    later_trade['cash'][0].pop('brokerAccountId')
    later_receipt = await data(client.post(TRANSACTIONS, headers=first_device, json=later_trade))
    stamp = datetime.now(UTC).isoformat()
    removed = [
        dict(original, status='deleted', deletedFrom='filled', deletedAt=stamp) for original in (sell, later)
    ]
    batch = trade(later_receipt['sourceRevision'], removed[0], '12', '47', '523.25', '100', cost='-0.125')
    batch['orders'] = removed
    batch['cash'][0].pop('brokerAccountId')
    invalid = {**batch, 'cash': [{**batch['cash'][0], 'balanceAfter': '101'}]}
    await data(client.post(TRANSACTIONS, headers=first_device, json=invalid), 400)
    before_delete = await data(client.get(LEDGER, headers=second_device))
    assert [o['status'] for o in before_delete['orders']] == ['filled', 'filled']
    assert before_delete['positions'][0]['quantity'] == '12'
    deleted = await data(client.post(TRANSACTIONS, headers=first_device, json=batch))
    assert await data(client.get(TRANSACTIONS + '/' + batch['requestId'], headers=second_device)) == deleted
    after_delete = await data(client.get(LEDGER, headers=second_device))
    assert [o['status'] for o in after_delete['orders']] == ['deleted', 'deleted']
    assert (after_delete['positions'][0]['quantity'], after_delete['positions'][0]['unitCost']) == ('47', '-0.125')
    assert next(c['balance'] for c in after_delete['cash'] if c['brokerAccountId'] is None) == '100'
