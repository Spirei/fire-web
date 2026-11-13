"""Generated quote polling reuses real receipts without extending Worker intent."""

from uuid import uuid4

from alcor_api.market_observation_receipts import generated_observation_id
from test_f15_intent import token
from test_quote_reads import body, hashes
from test_quote_reads import quoted  # noqa: F401 -- real observed PG quote fixture


async def test_repeated_generated_posts_reuse_original_receipt_without_more_writes(market, monkeypatch):
    client, app, _authority, transport, _revision = market
    monkeypatch.setattr('alcor_api.market_observation_receipts.observation_bucket', lambda _at: 100)
    first = await client.post('/api/quotes', json=body())
    assert first.status_code == 200 and first.headers['x-alcor-quote-tracked'] == 'true', first.text
    before = await hashes(app)
    for _ in range(3):
        repeated = await client.post('/api/quotes', json=body())
        assert repeated.status_code == 200
        assert repeated.headers['x-alcor-request-id'] == first.headers['x-alcor-request-id']
        assert repeated.headers['x-alcor-operation-receipt'] == first.headers['x-alcor-operation-receipt']
        assert repeated.headers['x-alcor-legacy-client-idempotency'] == 'false'
        assert await hashes(app) == before
    receipt = await client.get(first.headers['x-alcor-operation-receipt'])
    assert receipt.status_code == 200 and receipt.json()['requestId'] == first.headers['x-alcor-request-id']
    assert transport.calls == 0
    async with app.state.db.connection() as conn, conn.transaction():
        owner = (await (await conn.execute("SELECT id FROM users WHERE username='MarketReader'")).fetchone())['id']
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('market-owner:'+owner,))
        import asyncio
        while_worker_is_committing = await asyncio.wait_for(client.post('/api/quotes', json=body()), timeout=2)
        assert while_worker_is_committing.status_code == 200
        assert while_worker_is_committing.headers['x-alcor-request-id'] == first.headers['x-alcor-request-id']
        monkeypatch.setattr('alcor_api.market_observation_receipts.observation_bucket', lambda _at: 101)
        new_bucket = await asyncio.wait_for(client.post('/api/quotes', json=body()), timeout=1)
        assert new_bucket.status_code == 200, new_bucket.text
        assert new_bucket.json()['quotes'] == first.json()['quotes']
        assert new_bucket.headers['x-alcor-quote-tracked'] == 'false'
        assert await hashes(app) == before
    renewed = await client.post('/api/quotes', json=body())
    assert renewed.headers['x-alcor-request-id'] != first.headers['x-alcor-request-id']
    assert await hashes(app) != before


async def test_explicit_uuids_and_different_native_connections_are_independent(market, monkeypatch):
    client, app, _authority, _transport, _revision = market
    monkeypatch.setattr('alcor_api.market_observation_receipts.observation_bucket', lambda _at: 100)
    one = await token(app, 'portfolio.read portfolio.write')
    two = await token(app, 'portfolio.read portfolio.write')
    first = await client.post('/api/v2/quotes', json=body(), headers=one)
    other = await client.post('/api/v2/quotes', json=body(), headers=two)
    assert first.headers['x-alcor-request-id'] != other.headers['x-alcor-request-id']
    for headers in (one, two):
        identifier = str(uuid4())
        response = await client.post('/api/v2/quotes', json=body(), headers={**headers, 'x-alcor-request-id': identifier})
        assert response.headers['x-alcor-request-id'] == identifier
        assert response.headers['x-alcor-legacy-client-idempotency'] == 'true'
        before = await hashes(app)
        replay = await client.post('/api/v2/quotes', json=body(), headers={**headers, 'x-alcor-request-id': identifier})
        assert replay.json() == response.json() and await hashes(app) == before


async def test_busy_collection_does_not_hide_observed_app_quote(quoted, monkeypatch):
    import asyncio

    client, app, _, transport, revision, _, _ = quoted
    monkeypatch.setattr('alcor_api.legacy_quote_api.requested_session', lambda: 'REGULAR')
    headers = {**await token(app, 'portfolio.read portfolio.write'), 'x-alcor-market-source': revision}
    async with app.state.db.connection() as conn, conn.transaction():
        owner = (await (await conn.execute("SELECT id FROM users WHERE username='MarketReader'")).fetchone())['id']
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('market-owner:' + owner,))
        reply = await asyncio.wait_for(client.post('/api/v2/quotes', json=body(), headers=headers), timeout=1)
        assert reply.status_code == 200, reply.text
        assert reply.headers['x-alcor-quote-tracked'] == 'false'
        quote = reply.json()['data']['quotes']['known']
        assert quote['price'] == 120 and quote['source'] == 'controlled_market'
    assert transport.calls == 1


async def test_source_security_and_cancellation_changes_do_not_reuse_old_generated_id(market, monkeypatch):
    from alcor_api.security import Identity
    client, app, authority, _transport, revision = market
    monkeypatch.setattr('alcor_api.market_observation_receipts.observation_bucket', lambda _at: 100)
    async with app.state.db.connection() as conn:
        row = await (await conn.execute("SELECT u.id,u.username,u.role,s.token_hash,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.username='MarketReader' ORDER BY s.expires_at DESC LIMIT 1")).fetchone()
    who = Identity(**row, csrf=''); who.legacy_client = True
    items = [{'market': 'US', 'code': 'AAPL'}]
    async def identifier(**kwargs):
        return await generated_observation_id(authority, who, items, source_preference='auto', **kwargs)
    original = await identifier()
    assert original == await identifier()
    assert original != await identifier(session='PRE')
    assert original != await identifier(selected=revision)
    app.state.db.settings._legacy_quote_order = ['yahoo', 'tencent']
    reordered = await identifier(); assert reordered != original
    first = await client.post('/api/quotes', json=body())
    assert first.headers['x-alcor-quote-tracked'] == 'true'
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE market_demands SET revoked_at=clock_timestamp() WHERE owner_id=%s", (who.id,))
    assert await identifier() != reordered
    # Real source revocation changes the generated intent; the old receipt is
    # not used to present a formerly licensed observation as current.
    async with app.state.db.connection() as conn:
        await conn.execute('INSERT INTO market_source_revocations(owner_id,revision,request_id) VALUES(%s,%s,%s)', (who.id, revision, uuid4()))
    revoked = await identifier()
    response = await client.post('/api/quotes', json=body())
    assert response.status_code == 403 and revoked != reordered


async def test_real_worker_failure_reopens_generated_intent_in_the_same_window(market, monkeypatch):
    from alcor_api.market_worker import claim, execute, schedule
    client, app, authority, transport, _revision = market
    monkeypatch.setattr('alcor_api.market_observation_receipts.observation_bucket', lambda _at: 100)
    first = await client.post('/api/quotes', json=body())
    await schedule(authority)
    task = await claim(app.state.db, uuid4())
    async def unavailable(*_args):
        raise TimeoutError('Synthetic provider timeout')
    monkeypatch.setattr(transport, 'read', unavailable)
    assert await execute(authority, task, transport) == 'source_outcome_unknown'
    next_read = await client.post('/api/quotes', json=body())
    assert next_read.status_code == 200
    assert next_read.headers['x-alcor-request-id'] != first.headers['x-alcor-request-id']


async def test_full_100_security_poll_does_not_rewrite_or_depend_on_display_ids(market, monkeypatch):
    client, app, _authority, transport, _revision = market
    app.state.db.settings._legacy_quote_source = 'auto'
    app.state.db.settings._legacy_quote_order = ['controlled_market']
    monkeypatch.setattr('alcor_api.market_observation_receipts.observation_bucket', lambda _at: 100)
    items = [{'id':str(i), 'market':'US', 'code':f'SYN{i:03d}'} for i in range(100)]
    first = await client.post('/api/quotes', json=body(*items))
    assert first.status_code == 200 and first.headers['x-alcor-quote-tracked'] == 'true', first.text
    before = await hashes(app)
    import asyncio
    repeats = await asyncio.gather(*[client.post('/api/quotes', json=body(*[{**item, 'id':'new-'+item['id']} for item in reversed(items)])) for _ in range(3)])
    assert all(response.status_code == 200 for response in repeats)
    assert all(response.headers['x-alcor-request-id'] == first.headers['x-alcor-request-id'] for response in repeats)
    assert await hashes(app) == before and transport.calls == 0
    import json, re
    def statements(response):
        return int(re.search(r'desc="(\d+) statements"', response.headers['server-timing'])[1])
    counts = [statements(response) for response in repeats]
    assert max(counts) < statements(first) / 4
    print(json.dumps({'scope':'isolated_100_security_http_intent_not_live_provider_latency',
        'initialSqlStatements':statements(first),'repeatedSqlStatements':counts,
        'repeatedBusinessAndSourceWrites':0,'sourceIO':False}))


async def test_source_grant_revocation_changes_generated_intent_immediately(market, monkeypatch):
    from alcor_api.native_app_auth import authenticate
    from alcor_api.security import Identity
    from fastapi import HTTPException
    import pytest
    _client, app, authority, _transport, _revision = market
    monkeypatch.setattr('alcor_api.market_observation_receipts.observation_bucket', lambda _at: 100)
    headers = await token(app, 'portfolio.read portfolio.write')
    async with app.state.db.connection() as conn:
        grant = await authenticate(conn, headers['authorization'].removeprefix('Bearer '))
        row = await (await conn.execute("SELECT u.id,u.username,u.role,s.token_hash,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.id=%s ORDER BY s.expires_at DESC LIMIT 1", (grant['user_id'],))).fetchone()
        revision = uuid4(); policy = authority.policies[0]
        await conn.execute('''INSERT INTO market_source_configs(owner_id,revision,request_id,policy_id,policy_fingerprint,origin_instance,session_version,native_grant_id)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s)''', (row['id'], revision, uuid4(), policy.id, policy.fingerprint,
                app.state.db.settings.instance_id, grant['session_version'], grant['id']))
    who = Identity(**row, csrf='')
    items = [{'market':'US', 'code':'AAPL'}]
    before = await generated_observation_id(authority, who, items, selected=revision)
    async with app.state.db.connection() as conn:
        await conn.execute('UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s', (grant['id'],))
    assert before != await generated_observation_id(authority, who, items, selected=revision)
    async with app.state.db.connection() as conn:
        with pytest.raises(HTTPException) as denied:
            await authority.config(conn, who.id, revision)
        assert denied.value.status_code == 409


async def test_source_revoked_after_id_generation_cannot_restore_original_quote(quoted, monkeypatch):
    client, app, _authority, _transport, revision, _headers, _source = quoted
    import alcor_api.market_observation_receipts as receipts
    monkeypatch.setattr(receipts, 'observation_bucket', lambda _at: 100)
    first = await client.post('/api/quotes', json=body())
    assert first.status_code == 200 and first.json()['quotes']['known']['price'] == 120
    original = receipts.generated_observation_id
    async def revoke_after_generation(*args, **kwargs):
        identifier = await original(*args, **kwargs)
        async with app.state.db.connection() as conn:
            owner = (await (await conn.execute("SELECT id FROM users WHERE username='MarketReader'")).fetchone())['id']
            await conn.execute('INSERT INTO market_source_revocations(owner_id,revision,request_id) VALUES(%s,%s,%s)', (owner, revision, uuid4()))
        return identifier
    monkeypatch.setattr(receipts, 'generated_observation_id', revoke_after_generation)
    retired = await client.post('/api/quotes', json=body())
    assert retired.status_code == 403 and retired.headers['x-alcor-retire-context'] == 'true'
    assert 'quotes' not in retired.json()

