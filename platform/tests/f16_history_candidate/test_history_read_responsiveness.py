"""Actual PG/HTTP reads keep shared capacity while retained originals are proved."""
import asyncio
import threading
import time
from dataclasses import replace
from uuid import uuid4

import pytest
from f16_history_candidate.test_history_protocols import seeded
from market_latest_candidate.test_market_authority import market, market_settings  # noqa: F401


async def wait_started(event):
    began = time.monotonic()
    async with asyncio.timeout(.25):
        while not event.is_set():
            await asyncio.sleep(.005)
    assert time.monotonic() - began < .25, 'Original decoding blocked the HTTP event loop'


async def test_web_and_app_reads_survive_busy_automatic_collection_lock(market):  # noqa: F811
    client, app, _, _, transport, _ = await seeded(market)
    from alcor_api.native_app_auth import issue_grant

    async with app.state.db.connection() as conn, conn.transaction():
        user = await (await conn.execute("SELECT * FROM users WHERE username='MarketReader'")).fetchone()
        grant = await issue_grant(conn, user, 'portfolio.read portfolio.write', 'Synthetic quote contention')
    headers = {'authorization': 'Bearer ' + grant['access_token']}
    body = {'items': [{'id': 'same-security', 'market': 'US', 'code': 'AAPL'}]}
    async with app.state.db.connection() as conn, conn.transaction():
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('market-owner:' + user['id'],))
        before = await (await conn.execute('SELECT count(*) AS n FROM market_data_operations')).fetchone()
        async with asyncio.timeout(1.5):
            for prefix, auth in [('/api', {}), ('/api/v2', headers)]:
                charts = await client.post(prefix + '/charts', json=body, headers=auth)
                assert charts.status_code == 200, charts.text
                payload = charts.json()['data'] if auth else charts.json()
                assert [point['price'] for point in payload['charts']['same-security']['points']] == [10, 11]
                quotes = await client.post(prefix + '/quotes', json=body, headers=auth)
                assert quotes.status_code == 200, quotes.text
                assert quotes.headers['x-alcor-quote-tracked'] == 'false'
        assert await (await conn.execute('SELECT count(*) AS n FROM market_data_operations')).fetchone() == before
    assert transport.calls == 4


@pytest.mark.parametrize('entry', ['native', 'canonical'])
async def test_native_history_proof_releases_connection_and_does_not_block_ready(market, monkeypatch, entry):  # noqa: F811 -- imported pytest fixtures
    client, app, _authority, _revision, source, headers = await seeded(market)
    import alcor_api.market_history_evidence as evidence
    original = evidence.decode
    entered, release = threading.Event(), threading.Event()
    def slow_decode(*args, **kwargs):
        entered.set()
        assert release.wait(1), 'Owned proof was not released'
        return original(*args, **kwargs)
    monkeypatch.setattr(evidence, 'decode', slow_decode)
    await app.state.db.pool.resize(1, 1)
    # A safety timer also releases the old synchronous implementation, so the
    # before-fix test fails instead of leaving an occupied worker behind.
    timer = threading.Timer(.7, release.set)
    timer.start()
    url = ('/api/v2/stock-detail?market=US&code=AAPL&view=history' if entry == 'native' else
           '/api/market/history?market=US&code=AAPL&frame=day&adjust=qfq&source_revision=' + _revision)
    pending = asyncio.create_task(client.get(url, headers=headers if entry == 'native' else {}))
    try:
        await wait_started(entered)
        ready = await asyncio.wait_for(client.get('/health/ready'), .25)
        assert ready.status_code == 200, ready.text
        assert not pending.done(), 'Proof must still be paused while readiness completes'
    finally:
        release.set()
        timer.cancel()
        result = await pending
    assert result.status_code == 200, result.text
    if entry == 'native':
        assert [row['c'] for row in result.json()['data']['kline']] == [10, 11]
    else:
        assert [row['c'] for row in result.json()['facts']] == ['10', '11']
    assert source.calls == 4


@pytest.mark.parametrize('change', ['source', 'grant', 'policy', 'session', 'ambiguous'])
@pytest.mark.parametrize('entry', ['native', 'canonical'])
async def test_native_proof_cannot_publish_after_authority_changes(market, monkeypatch, change, entry):  # noqa: F811 -- imported pytest fixtures
    client, app, authority, revision, source, headers = await seeded(market)
    import alcor_api.market_history_evidence as evidence
    original = evidence.decode
    entered, release = threading.Event(), threading.Event()
    def paused(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return original(*args, **kwargs)
    monkeypatch.setattr(evidence, 'decode', paused)
    url = ('/api/v2/stock-detail?market=US&code=AAPL&view=history' if entry == 'native' else
           '/api/market/history?market=US&code=AAPL&frame=day&adjust=qfq&source_revision=' + revision)
    if change == 'ambiguous':
        headers = {key:value for key,value in headers.items() if key != 'x-alcor-market-source'}
        url = url.split('&source_revision=')[0]
    pending = asyncio.create_task(client.get(url, headers=headers))
    try:
        await wait_started(entered)
        if change == 'source':
            revoked = await asyncio.wait_for(client.request('DELETE', '/api/market/sources/' + revision,
                json={'request_id': str(uuid4())}), .5)
            assert revoked.status_code == 200 and revoked.json()['revoked'], revoked.text
        elif change == 'policy':
            authority.policies = (replace(authority.policies[0], license_revision='different-license'),)
        elif change == 'ambiguous':
            from alcor_api.market_contract import Query
            from market_latest_candidate.test_market_authority import demand
            authority.policies += (replace(authority.policies[0], id='second-fixture'),)
            second = await client.post('/api/market/sources',
                json={'request_id':str(uuid4()),'policy_id':'second-fixture'})
            assert second.status_code == 200, second.text
            await demand(client, second.json()['revision'],
                Query('bars','US','AAPL','day','qfq',start='2026-10-20',through='2026-10-21'))
        else:
            async with app.state.db.connection() as conn:
                if change == 'grant':
                    await conn.execute('UPDATE identity_app_grants SET revoked_at=clock_timestamp()')
                else:
                    await conn.execute('UPDATE users SET session_version=session_version+1')
    finally:
        release.set()
        result = await pending
    if change == 'ambiguous':
        assert result.status_code == 409, result.text
        assert 'x-alcor-retire-context' not in result.headers
    else:
        assert result.status_code in (401, 403), result.text
        assert result.headers['x-alcor-retire-context'] == 'true'
    assert 'kline' not in result.json().get('data', {})
    assert source.calls == 4


async def test_cancelled_proofs_keep_actual_cpu_work_bounded(monkeypatch):
    import alcor_api.market_history_evidence as evidence
    entered = [threading.Event() for _ in range(3)]
    release = [threading.Event() for _ in range(3)]
    running = maximum = 0
    lock = threading.Lock()
    def owned(index, *_):
        nonlocal running, maximum
        with lock:
            running += 1
            maximum = max(maximum, running)
        try:
            entered[index].set()
            assert release[index].wait(3)
        finally:
            with lock:
                running -= 1
    monkeypatch.setattr(evidence, 'prove_history_evidence', owned)
    jobs = [asyncio.create_task(evidence.verify_history_evidence(i, None, [], None)) for i in range(3)]
    try:
        await wait_started(entered[0])
        await wait_started(entered[1])
        jobs[0].cancel()
        with pytest.raises(asyncio.CancelledError):
            await jobs[0]
        await asyncio.sleep(.03)
        assert not entered[2].is_set(), 'Cancellation released a still-running CPU slot'
        release[0].set()
        await wait_started(entered[2])
    finally:
        for event in release:
            event.set()
        await asyncio.gather(*jobs, return_exceptions=True)
    assert maximum == 2


async def test_cancelled_reader_does_not_admit_more_retained_bodies_before_worker_finishes(monkeypatch):
    import alcor_api.market_history_evidence as evidence
    entered, release = threading.Event(), threading.Event()
    loaded = []
    def owned(*_):
        entered.set()
        assert release.wait(3)
    monkeypatch.setattr(evidence, 'prove_history_evidence', owned)
    @evidence.bounded_history_read
    async def retained_reader(index):
        loaded.append(index)
        await evidence.verify_history_evidence(index, None, [], None)
    jobs = [asyncio.create_task(retained_reader(i)) for i in range(4)]
    try:
        await wait_started(entered)
        while len(loaded) < 4:
            await asyncio.sleep(.005)
        jobs[0].cancel()
        with pytest.raises(asyncio.CancelledError):
            await jobs[0]
        jobs.append(asyncio.create_task(retained_reader(4)))
        await asyncio.sleep(.03)
        assert len(loaded) == 4, 'Cancellation admitted a fifth retained-body allocation'
    finally:
        release.set()
        await asyncio.gather(*jobs, return_exceptions=True)
    assert loaded == [0, 1, 2, 3, 4]


@pytest.mark.parametrize('path', [
    '/api/v2/stock-detail?market=US&code=AAPL&view=history',
    '/api/v2/chart-series?market=US&code=AAPL&days=1',
    '/api/market/history?market=US&code=AAPL&frame=day&adjust=qfq',
])
async def test_full_history_admission_returns_original_retry_header_without_loading_bodies(market, monkeypatch, path):  # noqa: F811
    client, _app, _authority, revision, _source, headers = await seeded(market)
    import alcor_api.market_history_evidence as evidence
    gate = evidence._gate('_alcor_history_read_gate', 4)
    for _ in range(4):
        await gate.acquire()
    async def unexpected(*_):
        pytest.fail('A queued reader loaded original bodies before admission')
    monkeypatch.setattr(evidence, 'load_history_evidence', unexpected)
    try:
        response = await asyncio.wait_for(client.get(path+'&source_revision='+revision if path.startswith('/api/market') else path,
            headers=headers), 4)
        assert response.status_code == 503, response.text
        assert response.headers['retry-after'] == '1'
    finally:
        for _ in range(4):
            gate.release()
