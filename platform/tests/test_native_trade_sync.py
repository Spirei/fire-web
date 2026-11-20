from datetime import UTC, datetime
from uuid import uuid4

import pytest

from test_legacy_trade_corrections import native_headers

PATH = '/api/v2/account-assets/native-fills'


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
