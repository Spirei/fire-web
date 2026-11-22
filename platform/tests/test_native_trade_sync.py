from datetime import UTC, datetime
from uuid import uuid4

import pytest

from test_legacy_trade_corrections import native_headers
from alcor_api.cli import create_user

PATH = '/api/v2/account-assets/native-fills'
ORDERS = '/api/v2/account-assets/native-orders'


@pytest.mark.asyncio
async def test_native_fill_mirror_is_idempotent_and_leaves_cloud_accounting_untouched(app, client, admin, db):
    operations = app.openapi()['paths'][PATH]
    assert operations['get']['operationId'] != operations['post']['operationId']
    read_only = await native_headers(db, admin, 'portfolio.read')
    headers = await native_headers(db, admin, 'portfolio.read portfolio.write')
    fill = dict(tradeId=str(uuid4()), market='HK', code='00700', name='腾讯验收', side='buy',
                quantity='2', price='605.50123456', fees='1.01', priceCurrency='HKD',
                filledAt=datetime.now(UTC).isoformat(), execution='recorded',
                settlementCurrency='CNY', settlementAmount='1080.51', broker='验收账户')
    assert (await client.post(PATH, json=fill)).status_code == 401
    assert (await client.post(PATH, json=fill, headers=read_only)).status_code == 403
    assert (await client.post(PATH, json={**fill, 'ownerId': 'other'}, headers=headers)).status_code == 400
    first = await client.post(PATH, json=fill, headers=headers)
    assert first.status_code == 200, first.text
    retry = await client.post(PATH, json=fill, headers=headers)
    assert retry.json() == first.json()
    conflict = await client.post(PATH, json={**fill, 'price': '600'}, headers=headers)
    assert conflict.status_code == 409
    current = await client.get(PATH, headers=read_only)
    assert current.json()['data'] == {'ownerId': admin, 'items': [fill], 'before': None}
    assert (await client.get(PATH + '?before=' + fill['tradeId'], headers=read_only)).json()['data']['items'] == []
    async with db.connection() as conn:
        for table in ('trade_ledger', 'cash_ledger_entries', 'portfolio_records'):
            assert (await (await conn.execute('SELECT count(*) AS n FROM ' + table)).fetchone())['n'] == 0


@pytest.mark.asyncio
async def test_order_lifecycle_preserves_history_and_deletion_wins_over_retries(app, client, admin, db, settings):
    operations = app.openapi()['paths'][ORDERS]
    assert operations['get']['operationId'] != operations['post']['operationId']
    headers = await native_headers(db, admin, 'portfolio.read portfolio.write')
    read_only = await native_headers(db, admin, 'portfolio.read')
    another = await create_user(settings, 'OtherAppOwner', 'Synthetic9Pass')
    other_headers = await native_headers(db, another, 'portfolio.read portfolio.write')
    created = datetime.now(UTC).isoformat()
    pending = dict(tradeId=str(uuid4()), market='US', code='GOOGL', name='Google', side='buy',
                   quantity='2', orderPrice='100', price='100', fees='1', priceCurrency='USD',
                   execution='conditional', orderType='limit', recordId='ios-position', status='pending',
                   createdAt=created, tif='撤单前有效')

    async def put(item, auth=headers, expected=200):
        response = await client.post(ORDERS, json=item, headers=auth)
        assert response.status_code == expected, response.text
        return response.json()['data']

    async def list_orders(auth=read_only, query=''):
        response = await client.get(ORDERS + query, headers=auth)
        assert response.status_code == 200, response.text
        return response.json()['data']['items']

    await put(pending, read_only, 403)
    pending_receipt = await put(pending)
    assert pending_receipt == await put(pending)
    rows = await list_orders(query='?scope=today')
    assert [(row['id'], row['status'], row['executedPrice']) for row in rows] == [(pending['tradeId'], 'pending', None)]
    assert await list_orders(other_headers) == []

    cancelled = {**pending, 'status': 'cancelled'}
    await put(cancelled)
    await put(pending, expected=409)
    assert [row['status'] for row in await list_orders()] == ['cancelled']
    deleted = {**cancelled, 'status': 'deleted', 'deletedFrom': 'cancelled', 'deletedAt': created}
    assert await put(deleted) == await put(deleted)
    await put(cancelled, expected=409)
    assert await list_orders() == []

    historical = {**pending, 'tradeId': str(uuid4()), 'execution': 'recorded', 'side': 'sell',
                  'filledAt': '2026-10-28T14:30:00Z', 'status': 'filled', 'price': '99.5',
                  'settlementCurrency': 'USD', 'settlementAmount': '198'}
    legacy = {field: historical[field] for field in ('tradeId', 'market', 'code', 'name', 'side', 'quantity',
              'price', 'fees', 'priceCurrency', 'filledAt', 'execution', 'settlementCurrency', 'settlementAmount')}
    assert (await client.post(PATH, json=legacy, headers=headers)).status_code == 200
    assert len(await list_orders()) == 1
    await put(historical)
    rows = await list_orders()
    assert len(rows) == 1 and rows[0]['createdAt'] == created and rows[0]['tradedAt'] == historical['filledAt']
    assert await list_orders(query='?scope=today') == []
    await put({**historical, 'status': 'deleted', 'deletedFrom': 'pending', 'deletedAt': created}, expected=400)
    removed = {**historical, 'status': 'deleted', 'deletedFrom': 'filled', 'deletedAt': created}
    await put(removed)
    await put(historical, expected=409)
    assert await list_orders() == []
    assert (await client.get(PATH, headers=read_only)).json()['data']['items'] == []
    assert (await client.post(PATH, json=legacy, headers=headers)).status_code == 409
    async with db.connection() as conn:
        for table in ('trade_ledger', 'cash_ledger_entries', 'portfolio_records'):
            assert (await (await conn.execute('SELECT count(*) AS n FROM ' + table)).fetchone())['n'] == 0
