"""Production-sized desired set through real native HTTP, leases and private PG."""

import asyncio
from datetime import UTC, datetime, timedelta
from time import monotonic
from uuid import uuid4

from alcor_api.market_runtime import batch_cycle
from market_subscription_candidate.test_subscriptions import native


async def test_114_native_subscriptions_complete_bounded_worker_cycle_without_financial_changes(market):
    client,app,authority,transport,revision=market
    headers,_=await native(app)
    headers['x-alcor-market-source']=revision
    symbols=[f'SYN{i:03}' for i in range(114)]
    for offset in (0,100):
        response=await client.post('/api/v2/quote-subscriptions',headers=headers,
            json={'items':[{'market':'US','code':code} for code in symbols[offset:offset+100]]})
        assert response.status_code==200,response.text
    # Feed the existing controlled representation with actual per-security PG
    # proofs. No external supplier or business/account mutation is involved.
    authority.clock=lambda:datetime(2026,10,20,14,tzinfo=UTC)+timedelta(seconds=1)
    started=monotonic()
    async with asyncio.timeout(60):
        for _ in range(20):
            assert await batch_cycle(authority,transport,uuid4())
            async with app.state.db.connection() as conn:
                count=(await (await conn.execute('SELECT count(DISTINCT stream_id) n FROM market_facts')).fetchone())['n']
            if count==114:break
    assert count==114 and monotonic()-started<60
    async with app.state.db.connection() as conn:
        for table in ('portfolio_records','trade_ledger','cash_ledger_entries','broker_accounts'):
            # Every table name is a fixed test constant, never request data.
            exists=(await (await conn.execute('SELECT to_regclass(%s) present',(table,))).fetchone())['present']
            if exists:
                assert (await (await conn.execute(f'SELECT count(*) n FROM {table}')).fetchone())['n']==0
        facts=await (await conn.execute("SELECT s.query->>'code' code,f.contents FROM market_facts f JOIN market_streams s ON s.id=f.stream_id AND s.owner_id=f.owner_id ORDER BY code")).fetchall()
        assert {row['code'] for row in facts}==set(symbols)
        assert all(row['contents']['price']=='340.000001' for row in facts)
