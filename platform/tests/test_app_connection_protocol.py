"""Actual App HTTP contracts and concurrent PG authorization, on isolated data only."""

import asyncio

import pytest
from psycopg_pool import TooManyRequests

from alcor_api.native_app_auth import authenticate, identity_from_grant
from alcor_api.security import digest, lock_read_identity
from alcor_api.source_read_access import source_read_lock


async def connect(client):
    result = await client.post('/api/v2/auth/login', json={
        'client_id':'fire-ios','username':'AdminOne','password':'Synthetic9Pass',
    })
    assert result.status_code == 200, result.text
    pair = result.json()['data']
    return pair, {'authorization':'Bearer '+pair['access_token']}


def protocol(response, version):
    assert response.headers['x-alcor-api-version'] == str(version)
    assert response.headers['x-request-id']
    assert response.headers['x-content-type-options'] == 'nosniff'
    assert 'no-store' in response.headers['cache-control']
    assert 'authorization' in response.headers['vary'].lower()
    assert 'location' not in response.headers and 'set-cookie' not in response.headers
    assert isinstance(response.json()['code'], int)


async def test_asset_readers_share_current_proof_but_still_exclude_broker_writers(client,admin,app):
    from alcor_api.broker_accounts import serialize_brokers
    from alcor_api.market_history_reads import LicensedHistory
    from alcor_api.market_pool_sources import PoolSources
    from fastapi import HTTPException
    from source_pure_read_candidate.test_reads import snapshot
    from test_trading import setup
    await setup(client,name='Synthetic parallel asset read',qty='2',cost='10')
    pair,headers=await connect(client)
    before=await snapshot(app.state.db)
    # The overview's existing database-backed request budget is operational;
    # every financial, identity, source, preference and receipt table is checked.
    before.pop('auth_rate_limits',None)
    entered=asyncio.Event()
    async def writer():
        async with app.state.db.connection() as conn,conn.transaction():
            entered.set()
            await serialize_brokers(conn,admin)
            return True
    task=None
    try:
        async with app.state.db.connection() as conn,conn.transaction():
            # A real concurrent reader holds the original broker domains and
            # current grant proof. The HTTP paths must not upgrade either lock.
            for domain in ('identity-management:','broker-accounts:'):
                await conn.execute('SELECT pg_advisory_xact_lock_shared(hashtextextended(%s,0))',(domain+admin,))
            who=identity_from_grant(await authenticate(conn,pair['access_token']),pair['access_token'])
            await lock_read_identity(conn,who)
            responses=await asyncio.wait_for(asyncio.gather(*(
                client.get(path,headers=headers)
                for path in ('/api/v1/account-assets','/api/v2/account-assets','/api/v2/overview','/api/v2/records')
            )),8)
            for response in responses:
                assert response.status_code==200,response.text
                protocol(response,1 if '/v1/' in str(response.request.url) else 2)
            # History/pool reads share the same native proof too; missing source
            # material returns its real state promptly, not an UPDATE-lock wait.
            pool=await asyncio.wait_for(PoolSources(app.state.market_authority).read(who),2)
            assert pool['entries']==[]
            with pytest.raises(HTTPException) as missing:
                await asyncio.wait_for(LicensedHistory(app.state.market_authority).read(who,'US','AAPL',frame='day',adjust='none'),2)
            assert missing.value.status_code==503
            # PostgreSQL may give an already queued writer priority over later
            # readers; queue it only after checking concurrent read completion.
            task=asyncio.create_task(writer())
            await asyncio.wait_for(entered.wait(),3)
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(asyncio.shield(task),.1)
        assert await asyncio.wait_for(task,3) is True
    finally:
        if task and not task.done():task.cancel()
        if task:await asyncio.gather(task,return_exceptions=True)
    after=await snapshot(app.state.db)
    after.pop('auth_rate_limits',None)
    assert after==before


@pytest.mark.parametrize('version',[1,2])
async def test_versioned_success_failure_and_no_redirect_share_the_protocol(client, version):
    prefix=f'/api/v{version}'
    for method,path,status,code in [
        ('GET','/auth/config',200,0), ('GET','/rates',200,0),
        ('POST','/auth/config',405,40501), ('GET','/auth/config/',404,40401),
        ('GET','/not-published',404,40401), ('GET','/records',401,40101),
    ]:
        response=await client.request(method,prefix+path,follow_redirects=False)
        assert response.status_code == status, response.text
        protocol(response,version)
        assert response.json()['code'] == code
        if status==405: assert 'GET' in response.headers['allow']


async def test_same_app_can_read_in_parallel_without_initializing_financial_state(client,admin,app):
    pair,headers=await connect(client)
    async with app.state.db.connection() as conn,conn.transaction():
        who=identity_from_grant(await authenticate(conn,pair['access_token']),pair['access_token'],'portfolio.read')
        await source_read_lock(conn,who)
        # The old UPDATE identity lock would wait for this shared proof to end.
        paths=['/api/v2/auth/me','/api/v2/records','/api/v2/quote-subscriptions']
        responses=await asyncio.wait_for(asyncio.gather(*(client.get(path,headers=headers) for path in paths)),5)
        for response in responses:
            assert response.status_code==200,response.text
            protocol(response,2)
        quote=await asyncio.wait_for(client.post('/api/v2/quotes',headers=headers,json={'items':[{'id':'synthetic-record','market':'US','code':'AAPL'}]}),5)
        assert quote.status_code in (200,503),quote.text
        protocol(quote,2)
        assert not await (await conn.execute('SELECT 1 FROM portfolio_record_collections WHERE owner_id=%s',(admin,))).fetchone()
        assert not await (await conn.execute('SELECT 1 FROM portfolio_records WHERE owner_id=%s',(admin,))).fetchone()


async def test_refresh_waits_for_read_proof_and_keeps_the_same_grant(client,admin,app,monkeypatch):
    import alcor_api.native_app_auth as native
    pair,headers=await connect(client)
    entered=asyncio.Event()
    original=native.active_grant
    async def gated(conn,grant_id,*,lock=False,shared=False):
        if lock: entered.set()
        return await original(conn,grant_id,lock=lock,shared=shared)
    monkeypatch.setattr(native,'active_grant',gated)
    task=None
    try:
        async with app.state.db.connection() as conn,conn.transaction():
            who=identity_from_grant(await authenticate(conn,pair['access_token']),pair['access_token'])
            await lock_read_identity(conn,who)
            task=asyncio.create_task(client.post('/api/v2/auth/token',json={
                'grant_type':'refresh_token','client_id':'fire-ios','refresh_token':pair['refresh_token'],
            }))
            await asyncio.wait_for(entered.wait(),3)
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(asyncio.shield(task),.1)
        refreshed=await asyncio.wait_for(task,5)
        assert refreshed.status_code==200,refreshed.text
        protocol(refreshed,2)
        next_pair=refreshed.json()['data']
        assert next_pair['grant_id']==pair['grant_id'] and next_pair['scope']==pair['scope']
        async with app.state.db.connection() as conn,conn.transaction():
            await conn.execute("UPDATE identity_app_access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=%s",(digest(pair['access_token']),))
        expired=await client.get('/api/v2/auth/me',headers=headers)
        assert expired.status_code==401 and expired.json()['code']==40102
        valid=await client.get('/api/v2/auth/me',headers={'authorization':'Bearer '+next_pair['access_token']})
        assert valid.status_code==200,valid.text
    finally:
        if task and not task.done():
            task.cancel(); await asyncio.gather(task,return_exceptions=True)


async def test_account_signal_and_native_grant_writer_cannot_invert_owner_locks(client,admin,app):
    """Reproduce the production user-SHARE/grant-UPDATE lock cycle on real PG."""
    from alcor_api.account_signals import guard
    from account_sync_candidate.test_account_signals import hashes

    pair,_=await connect(client)
    db=app.state.db
    async with db.connection() as conn:
        who=identity_from_grant(await authenticate(conn,pair['access_token']),pair['access_token'])
    before=await hashes(db)
    writer_started=asyncio.Event()
    writer_pid=None

    async def write_proof():
        nonlocal writer_pid
        async with db.connection() as conn,conn.transaction():
            writer_pid=(await(await conn.execute('SELECT pg_backend_pid() AS pid')).fetchone())['pid']
            writer_started.set()
            return await authenticate(conn,pair['access_token'],lock=True)

    task=None
    try:
        async with db.connection() as reader,reader.transaction():
            # AccountSignals.guard holds the owner before requesting the grant.
            # Pause at that real boundary while a second authorization starts.
            await reader.execute('SELECT id FROM users WHERE id=%s FOR SHARE',(admin,))
            task=asyncio.create_task(write_proof())
            await asyncio.wait_for(writer_started.wait(),3)
            async with db.connection() as observer:
                async with asyncio.timeout(3):
                    while True:
                        state=await(await observer.execute(
                            'SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s',(writer_pid,),
                        )).fetchone()
                        if state and state['wait_event_type']=='Lock':break
                        await asyncio.sleep(.01)
            # A grant-first writer would own the grant while waiting for this
            # owner's SHARE lock, deadlocking this actual sync guard.
            await asyncio.wait_for(guard(reader,who),3)
            if task.done():assert task.exception() is None
            assert not task.done()
        grant=await asyncio.wait_for(task,3)
        assert grant['id']==pair['grant_id'] and grant['user_id']==admin
    finally:
        if task and not task.done():task.cancel()
        if task:await asyncio.gather(task,return_exceptions=True)
    assert await hashes(db)==before


@pytest.mark.parametrize(('path','code'),[('/api/v2/records',40102),('/api/v2/account-assets',40101),('/api/v2/overview',40101)])
async def test_revocation_between_initial_auth_and_snapshot_cannot_return_old_records(client,admin,app,monkeypatch,path,code):
    import alcor_api.native_app_auth as native
    pair,headers=await connect(client)
    entered,release=asyncio.Event(),asyncio.Event()
    original=native.lock_native_identity
    async def paused(conn,who,*,shared=False):
        if shared:
            entered.set();await release.wait()
        return await original(conn,who,shared=shared)
    monkeypatch.setattr(native,'lock_native_identity',paused)
    task=asyncio.create_task(client.get(path,headers=headers))
    try:
        await asyncio.wait_for(entered.wait(),3)
        async with app.state.db.connection() as conn,conn.transaction():
            await conn.execute('UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s',(pair['grant_id'],))
        release.set()
        result=await asyncio.wait_for(task,5)
        assert result.status_code==401 and result.json()['code']==code,result.text
        protocol(result,2)
    finally:
        release.set()
        if not task.done(): task.cancel()
        await asyncio.gather(task,return_exceptions=True)


async def test_scope_and_account_mismatch_do_not_masquerade_as_expired_credentials(client,admin,app):
    pair,headers=await connect(client)
    async with app.state.db.connection() as conn,conn.transaction():
        await conn.execute("UPDATE identity_app_grants SET scope='portfolio.read' WHERE id=%s",(pair['grant_id'],))
    denied=await client.post('/api/v2/records',headers=headers,json={})
    assert denied.status_code==403 and denied.json()['code']==40301,denied.text
    changed=await client.get('/api/v2/records',headers={**headers,'x-alcor-expected-account':'other-owner'})
    assert changed.status_code==403 and changed.headers['x-alcor-retire-context']=='true'
    assert (await client.get('/api/v2/auth/me',headers=headers)).status_code==200


async def test_identity_projects_permissions_from_the_final_current_proof(client,admin,app,monkeypatch):
    import alcor_api.native_app_auth as native
    pair,headers=await connect(client)
    entered,release=asyncio.Event(),asyncio.Event()
    original=native.lock_native_identity
    async def paused(conn,who,*,shared=False):
        if shared:
            entered.set();await release.wait()
        return await original(conn,who,shared=shared)
    monkeypatch.setattr(native,'lock_native_identity',paused)
    task=asyncio.create_task(client.get('/api/v2/auth/me',headers=headers))
    try:
        await asyncio.wait_for(entered.wait(),3)
        async with app.state.db.connection() as conn,conn.transaction():
            await conn.execute("UPDATE identity_app_grants SET scope='portfolio.read' WHERE id=%s",(pair['grant_id'],))
        release.set()
        result=await asyncio.wait_for(task,5)
        assert result.status_code==200 and result.json()['data']['scope']=='portfolio.read',result.text
    finally:
        release.set()
        if not task.done(): task.cancel()
        await asyncio.gather(task,return_exceptions=True)


async def test_bounded_quote_throttle_has_retry_hint_without_retiring_app_connection(client,admin,app,monkeypatch):
    _,headers=await connect(client)
    async def denied(*args,**kwargs): return False
    monkeypatch.setattr(app.state,'read_rate_limit',denied)
    monkeypatch.setattr(app.state,'read_rate_limits',denied)
    response=await client.post('/api/v2/quotes',headers=headers,json={'items':[{'market':'US','code':'AAPL'}]})
    assert response.status_code==429 and response.json()['code']==42901
    assert response.headers['retry-after']=='60'
    assert 'x-alcor-retire-context' not in response.headers
    protocol(response,2)
    assert (await client.get('/api/v2/auth/me',headers=headers)).status_code==200


@pytest.mark.parametrize('content,content_type',[
    (b'{"grant_type":"refresh_token","client_id":"fire-ios","refresh_token":42}','application/json'),
    (b'{"grant_type":"refresh_token","client_id":"fire-ios","refresh_token":{}}','application/json'),
    (b'{"grant_type":"refresh_token","client_id":"fire-ios","client_id":"other"}','application/json'),
    (b'grant_type=refresh_token&client_id=fire-ios&client_id=other','application/x-www-form-urlencoded'),
    (b'grant_type=refresh_token&unknown=ignored','application/x-www-form-urlencoded'),
    (b'\xff','application/x-www-form-urlencoded'),
])
async def test_invalid_token_input_is_a_client_error_not_connection_or_server_failure(client,content,content_type):
    result=await client.post('/api/v2/auth/token',content=content,headers={'content-type':content_type})
    assert result.status_code==400 and result.json()['code']==40002,result.text
    protocol(result,2)


async def test_login_throttle_communicates_the_existing_window(client):
    # The identity adapter deliberately keeps its original PG authentication budget.
    # Test the real shared login window through the ordinary public route.
    for _ in range(21):
        result=await client.post('/api/v2/auth/login',json={'client_id':'fire-ios','username':'SyntheticUnknownAccount','password':'Synthetic9Pass'})
    assert result.status_code==429 and result.headers['retry-after']=='900'
    assert result.json()['code']==42901


@pytest.mark.parametrize('kind',['pool','unexpected'])
async def test_transient_failure_stays_json_and_keeps_version_and_request_id(client,admin,app,monkeypatch,kind):
    _,headers=await connect(client)
    async def failed(*args,**kwargs):
        if kind=='pool':raise TooManyRequests('synthetic queue pressure')
        raise RuntimeError('synthetic private detail must not leak')
    monkeypatch.setattr(app.state.batch_quote_reads,'read',failed)
    result=await client.post('/api/v2/quotes',headers=headers,json={'items':[{'id':'synthetic-record','market':'US','code':'AAPL'}]})
    assert result.status_code==503 and result.json()['code']==50001,result.text
    assert result.headers['retry-after']=='3' and 'synthetic' not in result.text
    protocol(result,2)
