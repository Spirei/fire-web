"""Observed history retains actual dates; GET cannot silently collect a gap."""
from uuid import uuid4

from f16_history_candidate.test_history_protocols import seeded
from market_latest_candidate.test_market_authority import market, market_settings  # noqa: F401
from test_trading import setup


async def test_actual_retained_closes_gaps_and_revoked_license(market):  # noqa: F811
    client, app, authority, revision, transport, headers = await seeded(market)
    _, record = await setup(client, qty='2', cost='5')
    async def counts():
        async with app.state.db.connection() as conn:
            return {table: (await (await conn.execute('SELECT count(*) n FROM '+table)).fetchone())['n']
                    for table in ('market_demands', 'market_data_jobs', 'market_source_pages', 'trade_ledger', 'cash_ledger_entries')}
    before = await counts()
    response = await client.get('/api/v1/portfolio-series?days=1200', headers=headers)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value['closes'][record['id']] == [{'d':'2026-10-20','c':10}, {'d':'2026-10-21','c':11}]
    assert value['orders'] == []
    assert value['migration']['coverage']['historyCoverageKnown'] is False
    assert value['migration']['periodAnalysis']['completePeriodReturn']['value'] is None
    # A second source selection with no bars cannot be silently replaced with
    # the retained first source, nor trigger a remote read on this GET.
    changed = await client.post('/api/market/sources', json={'request_id':str(uuid4()),'policy_id':'fixture'})
    assert changed.status_code == 200, changed.text
    authority.policies = ()
    revoked = await client.get('/api/v1/portfolio-series?days=1200', headers=headers)
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()['closes'] == {}
    assert any(row['domain']=='closes' for row in revoked.json()['migration']['coverage']['missing'])
    assert await counts() == before and transport.calls == 4
