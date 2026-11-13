"""Real PG: bounded lease commits stay atomic, disjoint and permission checked."""

import asyncio
from dataclasses import asdict
from uuid import uuid4

import pytest

from alcor_api.market_contract import Query
from alcor_api.market_worker import Bound, claim_batch, execute, schedule
from alcor_api.security import Identity
from .test_market_authority import demand, market, market_settings  # noqa: F401


async def test_114_real_tasks_commit_twenty_leases_once_and_keep_revocation_and_stale_lease_guards(market):
    client, app, authority, transport, revision = market
    await demand(client, revision, Query('latest', 'US', 'SYN000'))
    # Set up the production-sized registered set through the same domain proof,
    # without weakening the separate HTTP mutation budget to build a fixture.
    async with authority.db.connection() as conn:
        actor = await (await conn.execute('''SELECT u.id,u.username,u.role,s.token_hash,s.expires_at
            FROM market_source_configs c JOIN users u ON u.id=c.owner_id
            JOIN sessions s ON s.user_id=u.id WHERE c.revision=%s AND s.client_id='new-web' ''', (revision,))).fetchone()
    who = Identity(**actor, csrf='')
    for index in range(1, 114):
        await authority.demand(who, uuid4(), revision, asdict(Query('latest', 'US', f'SYN{index:03}')))
    assert await schedule(authority) == 100
    assert await schedule(authority) == 14
    first_worker, second_worker = uuid4(), uuid4()
    first, second = await asyncio.gather(
        claim_batch(authority.db, first_worker, kind='market.latest'),
        claim_batch(authority.db, second_worker, kind='market.latest'),
    )
    assert len(first) == len(second) == 20
    assert not {t['id'] for t in first} & {t['id'] for t in second}
    assert all(t['lease_version'] == 1 and t['attempts'] == 1 for t in first+second)
    async with authority.db.connection() as conn:
        for worker in (first_worker, second_worker):
            proof = await (await conn.execute('''SELECT count(*) AS n,count(DISTINCT xmin::text) AS commits,
                bool_and(status='running' AND lease_until>clock_timestamp()
                         AND lease_until<clock_timestamp()+interval '31 seconds') AS bounded
                FROM tasks WHERE lease_owner=%s''', (worker,))).fetchone()
            assert proof == {'n':20, 'commits':1, 'bounded':True}
    # A rolled-back admission cannot leave part of a batch running.
    rollback_worker = uuid4()
    async with authority.db.connection() as conn:
        with pytest.raises(RuntimeError, match='controlled_rollback'):
            async with conn.transaction():
                assert len(await claim_batch(Bound(conn, authority.db.settings), rollback_worker)) == 20
                raise RuntimeError('controlled_rollback')
        assert not (await (await conn.execute('SELECT 1 FROM tasks WHERE lease_owner=%s', (rollback_worker,))).fetchone())
    # The old worker may not publish or issue IO after its lease is reclaimed.
    async with authority.db.connection() as conn:
        await conn.execute("UPDATE tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=%s", (first[0]['id'],))
    reclaimed = await claim_batch(authority.db, uuid4(), kind='market.latest', maximum=1)
    assert len(reclaimed) == 1 and reclaimed[0]['id'] == first[0]['id']
    assert reclaimed[0]['lease_version'] == 2
    assert await execute(authority, first[0], transport) == 'lost'
    assert transport.calls == 0
    # Leasing is not authorization: the original licence is checked before IO.
    response = await client.request('DELETE', '/api/market/sources/'+revision, json={'request_id':str(uuid4())})
    assert response.status_code == 200, response.text
    assert await execute(authority, second[0], transport) == 'cancelled'
    assert transport.calls == 0
    async with authority.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM market_facts')).fetchone())['n'] == 0


@pytest.mark.parametrize('maximum', [0, 21, True, 2.0])
async def test_lease_batch_rejects_unbounded_or_noninteger_capacity(maximum):
    with pytest.raises(ValueError, match='market_worker_batch_invalid'):
        await claim_batch(None, uuid4(), maximum=maximum)
