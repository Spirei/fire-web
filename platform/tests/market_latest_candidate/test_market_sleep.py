"""Retained subscriptions sleep after client inactivity and wake on explicit demand."""
from uuid import uuid4
from alcor_api.market_contract import Query
from alcor_api.market_worker import claim,execute,schedule
from .test_market_authority import demand,market,market_settings,read  # noqa: F401


async def test_inactive_latest_retains_facts_sleeps_without_source_calls_and_wakes(market):
    client,app,authority,transport,revision=market
    first=await demand(client,revision);await schedule(authority)
    task=await claim(authority.db,uuid4());assert await execute(authority,task,transport)=='observed'
    async with authority.db.connection() as conn:
        await conn.execute("UPDATE market_demands SET hot_until=clock_timestamp()-interval '1 second'")
        await conn.execute("UPDATE market_streams SET next_due=clock_timestamp()-interval '1 second'")
    cold=await claim(authority.db,uuid4());assert cold['id']==task['id']
    assert await execute(authority,cold,transport)=='sleeping' and transport.calls==1
    assert await claim(authority.db,uuid4()) is None
    assert (await read(client,revision)).json()['facts']
    await demand(client,revision,expected=first['revision']);assert await schedule(authority)==0
    awake=await claim(authority.db,uuid4());assert awake['id']==task['id']
    assert await execute(authority,awake,transport)=='observed' and transport.calls==2
    async with authority.db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) AS n FROM market_streams')).fetchone())['n']==1
        assert (await(await conn.execute('SELECT count(*) AS n FROM tasks')).fetchone())['n']==1


async def test_removing_sleeping_demand_cancels_original_task_without_source_call(market):
    client,app,authority,transport,revision=market
    first=await demand(client,revision);await schedule(authority)
    async with authority.db.connection() as conn:
        await conn.execute("UPDATE market_demands SET hot_until=clock_timestamp()-interval '1 second'")
    task=await claim(authority.db,uuid4());assert await execute(authority,task,transport)=='sleeping'
    await demand(client,revision,expected=first['revision'],remove=True)
    cancelled=await claim(authority.db,uuid4());assert cancelled['id']==task['id']
    assert await execute(authority,cancelled,transport)=='authorization_revoked' and transport.calls==0
    async with authority.db.connection() as conn:
        row=await(await conn.execute('SELECT status FROM tasks WHERE id=%s',(task['id'],))).fetchone()
    assert row['status']=='cancelled'


async def test_hot_observation_is_not_blocked_by_older_dormant_maintenance(market):
    client,app,authority,transport,revision=market
    cold=await demand(client,revision)
    async with authority.db.connection() as conn:
        await conn.execute("UPDATE market_demands SET hot_until=clock_timestamp()-interval '1 second'")
    hot=await demand(client,revision,Query('latest','US','MSFT'))
    await schedule(authority)
    async with authority.db.connection() as conn:
        await conn.execute("UPDATE market_streams SET next_due=clock_timestamp()-interval '1 hour' WHERE id=%s",(cold['streamId'],))
    first=await claim(authority.db,uuid4());assert first['payload']['streamId']==hot['streamId']
    assert await execute(authority,first,transport)=='observed' and transport.calls==1
    second=await claim(authority.db,uuid4());assert second['payload']['streamId']==cold['streamId']
    assert await execute(authority,second,transport)=='sleeping' and transport.calls==1
