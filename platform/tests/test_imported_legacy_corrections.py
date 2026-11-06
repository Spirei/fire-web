"""A verified account must never make an unknown old owner/global scope complete."""

from decimal import Decimal

import pytest
from actual_fee_test_support import actual_case, actual_operation
from legacy_fee_source_fixture import old_pg
from test_legacy_trade_corrections import native_headers

__all__ = ['old_pg']


@pytest.mark.parametrize('version', [1, 2])
async def test_imported_actual_account_does_not_fabricate_complete_legacy_owner_snapshot(
    client, admin, app, old_pg, pg, tmp_path, version,
):
    async with actual_case(client, admin, app, old_pg, pg, tmp_path, fee='1.11') as (approved, hosted, _grant, _source, account, fill, actual):
        await actual_operation(approved, actual)
        # The canonical account remains independently known and usable.
        scoped = await approved.get('/api/cash/accounts/' + account)
        assert scoped.status_code == 200
        cash = scoped.json()['currencies'][0]
        assert cash['complete'] and not cash['ownerCashComplete']
        assert Decimal(cash['balance']) == Decimal('898.89')
        async with hosted.state.db.connection() as conn:
            before = await (await conn.execute('SELECT fees,cash_delta FROM trade_ledger WHERE id=%s', (fill['tradeId'],))).fetchone()
            amendments = (await (await conn.execute('SELECT count(*) n FROM trade_amendments')).fetchone())['n']
        headers = {**await native_headers(hosted.state.db, admin), 'x-alcor-trading-context': 'nullable-v1', 'x-alcor-trade-fees': 'details-v1'}
        result = await approved.get(f'/api/v{version}/account-assets/trading', headers=headers)
        assert result.status_code == 409
        assert result.json() == {'code': 40902, 'message': '原账还有未核对范围，请按已核对账户查看；完整总额暂不可用', 'data': None}
        assert result.headers['x-alcor-financial-scope'] == 'incomplete'
        async with hosted.state.db.connection() as conn:
            assert await (await conn.execute('SELECT fees,cash_delta FROM trade_ledger WHERE id=%s', (fill['tradeId'],))).fetchone() == before
            assert (await (await conn.execute('SELECT count(*) n FROM trade_amendments')).fetchone())['n'] == amendments
