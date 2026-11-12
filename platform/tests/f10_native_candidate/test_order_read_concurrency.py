"""An order-list read must not serialize the App's asset and quote inputs."""

import asyncio

import pytest

from alcor_api import legacy_native_orders
from test_legacy_trade_corrections import native_headers
from test_trading import setup


async def financial_rows(db, owner):
    async with db.connection() as conn:
        return {
            table: await (await conn.execute(
                f'SELECT to_jsonb(t)::text AS value FROM {table} t '
                'WHERE owner_id=%s ORDER BY to_jsonb(t)::text', (owner,),
            )).fetchall()
            for table in ('portfolio_records', 'trade_ledger', 'cash_ledger_entries',
                          'cash_ledger_accounts', 'internal_orders', 'broker_accounts')
        }


@pytest.mark.parametrize('version', (1, 2))
async def test_order_read_shares_identity_with_asset_reads_and_still_blocks_revocation(
    client, db, admin, monkeypatch, version,
):
    await setup(client)
    headers = await native_headers(db, admin, 'portfolio.read')
    before = await financial_rows(db, admin)
    entered, release, revoke_started = asyncio.Event(), asyncio.Event(), asyncio.Event()
    snapshot = legacy_native_orders.snapshot_in_transaction

    async def paused(*args, **kwargs):
        entered.set()
        await release.wait()
        return await snapshot(*args, **kwargs)

    monkeypatch.setattr(legacy_native_orders, 'snapshot_in_transaction', paused)
    path = f'/api/v{version}/account-assets/orders?scope=all&status=all'
    listing = asyncio.create_task(client.get(path, headers=headers))
    revoking = None
    try:
        async with asyncio.timeout(3):
            await entered.wait()
        async with asyncio.timeout(2):
            responses = await asyncio.gather(*(
                client.get('/api/v2/' + name, headers=headers)
                for name in ('account-assets', 'account-sync', 'records')
            ))
        assert all(row.status_code == 200 for row in responses), [row.text for row in responses]
        assert not listing.done()

        async def revoke():
            async with db.connection() as conn:
                revoke_started.set()
                await conn.execute(
                    'UPDATE identity_app_grants SET revoked_at=clock_timestamp() '
                    'WHERE user_id=%s AND revoked_at IS NULL', (admin,),
                )

        revoking = asyncio.create_task(revoke())
        async with asyncio.timeout(3):
            await revoke_started.wait()
        await asyncio.sleep(.1)
        assert not revoking.done(), 'revocation must wait for the accepted read to finish'
    finally:
        release.set()
        await asyncio.gather(listing, *([revoking] if revoking else []), return_exceptions=True)
    assert listing.result().status_code == 200, listing.result().text
    assert (await client.get(path, headers=headers)).status_code == 401
    assert await financial_rows(db, admin) == before, 'order and asset reads never rewrite financial data'
