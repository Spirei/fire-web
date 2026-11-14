import asyncio
from types import SimpleNamespace
from uuid import uuid4

import pytest
from redis.asyncio import Redis
from redis.exceptions import ConnectionError

from alcor_api.read_budgets import ReadBudgets
from test_connections import PASSWORD, private_redis  # noqa: F401 -- isolated owned fixture


async def test_redis_shares_atomic_read_budget_without_pg_writes(private_redis):
    client = Redis(unix_socket_path=str(private_redis), password=PASSWORD)
    calls = []
    async def fallback():
        calls.append(True)
        return True
    try:
        handle = SimpleNamespace(client=client)
        instance = uuid4()
        first, second = ReadBudgets(handle, instance), ReadBudgets(handle, instance)
        results = await asyncio.gather(*(api.allow('synthetic-private-owner', 12, 60, fallback) for api in [first,second]*20))
        assert sum(results) == 12 and not calls
        keys = await client.keys('alcor:*:read-budget:*')
        assert len(keys) == 1 and b'synthetic-private-owner' not in keys[0]
        assert 0 < await client.ttl(keys[0]) <= 60
        assert await ReadBudgets(handle, uuid4()).allow('synthetic-private-owner', 12, 60, fallback)
        # Authentication's durable limiter remains a separate authority.
        assert first.cache is handle
    finally:
        await client.aclose()


async def test_failed_cache_backs_off_and_connection_replacement_rechecks():
    class Broken:
        calls = 0
        async def eval(self, *args):
            self.calls += 1
            raise ConnectionError('synthetic unavailable')
    class Ready:
        async def eval(self, *args): return 1
    fallback_calls = []
    async def fallback():
        fallback_calls.append(True)
        return False
    handle = SimpleNamespace(client=Broken())
    limits = ReadBudgets(handle, uuid4())
    assert not await limits.allow('read', 2, 60, fallback)
    assert not await limits.allow('read', 2, 60, fallback)
    assert handle.client.calls == 1 and len(fallback_calls) == 2
    handle.client = Ready()
    assert await limits.allow('read', 2, 60, fallback)


async def test_ping_only_acl_falls_back_and_instance_counter_acl_avoids_pg(private_redis):
    from redis.exceptions import NoPermissionError
    from alcor_api.request_timing import begin, finish

    control = Redis(unix_socket_path=str(private_redis), password=PASSWORD)
    client = Redis(unix_socket_path=str(private_redis), username='cache-user', password=PASSWORD)
    instance = uuid4()
    handle, calls = SimpleNamespace(client=client), []
    async def fallback():
        calls.append(True)
        return True
    try:
        assert await client.ping()
        timing, token = begin()
        try:
            assert await ReadBudgets(handle, instance).allow('synthetic-read', 2, 60, fallback)
            assert b'read_admission_pg;' in timing.header()
        finally:
            finish(timing, token)
        assert calls == [True]
        await control.execute_command('ACL', 'SETUSER', 'cache-user', 'resetkeys',
            f'~alcor:{instance}:read-budget:*', '+eval', '+incr', '+ttl', '+expire')
        timing, token = begin()
        try:
            assert await ReadBudgets(handle, instance).allow('synthetic-read', 2, 60, fallback)
            header = timing.header()
            assert b'read_admission_redis;' in header and b'read_admission_pg;' not in header
            assert b'synthetic-read' not in header and str(instance).encode() not in header
        finally:
            finish(timing, token)
        assert calls == [True]
        try:
            await client.incr('unrelated-application:key')
        except NoPermissionError:
            pass
        else:
            raise AssertionError('Counter credentials escaped their instance namespace')
    finally:
        await client.aclose()
        await control.aclose()


async def test_chart_pool_portfolio_and_asset_reads_share_redis_but_login_keeps_pg(client, admin, app, private_redis):
    cache = Redis(unix_socket_path=str(private_redis), password=PASSWORD)
    database = app.state.db

    async def attempts():
        async with database.connection() as conn:
            return (await (await conn.execute('SELECT coalesce(sum(attempts),0) AS n FROM auth_rate_limits')).fetchone())['n']

    app.state.cache.client = cache
    try:
        before = await attempts()
        # Real route authentication, source lookup and catalogue reads still run.
        # A missing historical licence is expected in this empty isolated account.
        requests = [
            ('/api/kline/full?market=US&code=AAPL', 503),
            ('/api/market/pool', 200),
            ('/api/market/subscriptions', 200),
            ('/api/portfolio/series', 200),
            ('/api/asset-catalog/lookup?keys=%5B%5D', 200),
            ('/api/assets/search?type=metal&q=gold', 200),
        ]
        for path, status in requests:
            response = await client.get(path)
            assert response.status_code == status, (path, response.text)
        assert await attempts() == before
        assert len(await cache.keys('alcor:*:read-budget:*')) == 10
        # The same counter is enforced at the HTTP boundary, across readers.
        for _ in range(39):
            assert await app.state.read_rate_limit(database, 'portfolio-series:'+admin, 40, window_seconds=60)
        assert (await client.get('/api/portfolio/series')).status_code == 429
        assert await attempts() == before
        denied = await client.post('/api/session/login', json={'login':'SyntheticMissing','password':'Synthetic9Pass'})
        assert denied.status_code == 401 and await attempts() == before+2
        # Redis absence preserves the original database budget and its denial.
        app.state.cache.client = None
        denied_fallback = []
        async def unavailable(*args, **kwargs):
            denied_fallback.append(True)
            return False
        app.state.rate_limit = unavailable
        assert (await client.get('/api/portfolio/series')).status_code == 429
        assert denied_fallback == [True]
    finally:
        app.state.cache.client = None
        await cache.aclose()


async def test_native_history_uses_shared_read_budget_and_backoff_without_count_writes(client,admin,app,private_redis):
    from alcor_api.native_app_auth import issue_grant

    database=app.state.db
    async with database.connection() as conn,conn.transaction():
        user=await(await conn.execute('SELECT * FROM users WHERE id=%s',(admin,))).fetchone()
        pair=await issue_grant(conn,user,'portfolio.read','Synthetic history budget')
    headers={'authorization':'Bearer '+pair['access_token']}
    cache=Redis(unix_socket_path=str(private_redis),password=PASSWORD)

    async def attempts():
        async with database.connection() as conn:
            return (await(await conn.execute('SELECT coalesce(sum(attempts),0) AS n FROM auth_rate_limits')).fetchone())['n']

    app.state.cache.client=cache
    try:
        before=await attempts()
        for version in (1,2):
            response=await client.get(f'/api/v{version}/stock-detail?market=US&code=AAPL&view=history',headers=headers)
            assert response.status_code==503 and response.json()['code']==50002,response.text
            assert response.headers['retry-after']=='30'
            assert response.headers['x-alcor-api-version']==str(version)
        assert await attempts()==before
        # Both compatibility paths enforce the original same-owner/global limits.
        assert len(await cache.keys('alcor:*:read-budget:*'))==2
        for _ in range(58):
            assert await app.state.read_rate_limit(database,'stock-detail:'+admin,60,window_seconds=60)
        denied=await client.get('/api/v2/stock-detail?market=US&code=AAPL&view=history',headers=headers)
        assert denied.status_code==429 and denied.json()['code']==42901
        assert denied.headers['retry-after']=='60' and await attempts()==before
        # A real Redis failure reuses the existing database admission path.
        app.state.cache.client=None
        fallback=await client.get('/api/v2/stock-detail?market=US&code=AAPL&view=history',headers=headers)
        assert fallback.status_code==503 and fallback.headers['retry-after']=='30'
        assert await attempts()==before+2
        invalid=await client.get('/api/v2/stock-detail?market=US&code=AAPL',headers={'authorization':'Bearer fat_invalid'})
        assert invalid.status_code==401 and invalid.headers['x-alcor-retire-context']=='true'
        assert await attempts()==before+2
    finally:
        app.state.cache.client=None
        await cache.aclose()


async def test_native_alert_list_uses_redis_and_keeps_database_fallback(client, admin, app, private_redis):
    from alcor_api.native_app_auth import issue_grant

    db = app.state.db
    async with db.connection() as conn, conn.transaction():
        user = await (await conn.execute('SELECT * FROM users WHERE id=%s', (admin,))).fetchone()
        pair = await issue_grant(conn, user, 'portfolio.read', 'Synthetic alert budget')
    headers = {'authorization': 'Bearer ' + pair['access_token']}
    cache = Redis(unix_socket_path=str(private_redis), password=PASSWORD)

    async def attempts():
        async with db.connection() as conn:
            return (await (await conn.execute('SELECT coalesce(sum(attempts),0) AS n FROM auth_rate_limits')).fetchone())['n']

    app.state.cache.client = cache
    try:
        before = await attempts()
        for version in (1, 2):
            response = await client.get(f'/api/v{version}/price-alerts', headers=headers)
            assert response.status_code == 200, response.text
        assert await attempts() == before
        assert len(await cache.keys('alcor:*:read-budget:*')) == 1
        app.state.cache.client = None
        response = await client.get('/api/v2/price-alerts', headers=headers)
        assert response.status_code == 200, response.text
        assert await attempts() == before + 1
    finally:
        app.state.cache.client = None
        await cache.aclose()


@pytest.mark.parametrize('version', [1, 2])
async def test_native_intraday_reads_keep_shared_limits_without_pg_counter_writes(client, admin, app, private_redis, version):
    from alcor_api.native_app_auth import authenticate, issue_grant

    database = app.state.db
    async with database.connection() as conn, conn.transaction():
        user = await (await conn.execute('SELECT * FROM users WHERE id=%s', (admin,))).fetchone()
        pair = await issue_grant(conn, user, 'portfolio.read', 'Synthetic intraday budget')
        grant = await authenticate(conn, pair['access_token'])
    headers = {'authorization': 'Bearer ' + pair['access_token']}
    cache = Redis(unix_socket_path=str(private_redis), password=PASSWORD)

    async def attempts():
        async with database.connection() as conn:
            return (await (await conn.execute('SELECT coalesce(sum(attempts),0) AS n FROM auth_rate_limits')).fetchone())['n']

    app.state.cache.client = cache
    try:
        before = await attempts()
        for path in ('chart-series?market=US&code=AAPL&days=1', 'kline-sessions?market=US&code=AAPL'):
            response = await client.get(f'/api/v{version}/' + path, headers=headers)
            assert response.status_code == 503 and response.json()['code'] == 50002, response.text
            assert response.headers['x-alcor-api-version'] == str(version)
        web = await client.get('/api/kline/session-day?market=US&code=AAPL')
        assert web.status_code == 503, web.text
        charts = f'/api/v{version}/charts'
        body = {'items': [{'id': 'synthetic-row', 'market': 'US', 'code': 'AAPL'}]}
        response = await client.post(charts, json=body, headers=headers)
        assert response.status_code == 200 and response.json()['data']['charts'] == {}, response.text
        assert response.headers['x-alcor-chart-state'] == 'partial'
        assert await attempts() == before
        assert len(await cache.keys('alcor:*:read-budget:*')) == 5

        # The two GET aliases use one owner counter; POST keeps its own IP,
        # global and owner limits. A cache hit never bypasses admission.
        for _ in range(87):
            assert await app.state.read_rate_limit(database, 'chart-series:' + admin, 90, window_seconds=60)
        denied = await client.get(f'/api/v{version}/chart-series?market=US&code=AAPL&days=1', headers=headers)
        assert denied.status_code == 429 and denied.json()['code'] == 42901
        for _ in range(119):
            assert await app.state.read_rate_limit(database, 'charts:' + admin, 120, window_seconds=60)
        denied = await client.post(charts, json=body, headers=headers)
        assert denied.status_code == 429 and denied.json()['code'] == 42901
        assert await attempts() == before

        # Redis absence returns to the same durable budget rather than allowing
        # unlimited reads. No history or current price is fabricated.
        app.state.cache.client = None
        fallback = await client.get(f'/api/v{version}/chart-series?market=US&code=AAPL&days=1', headers=headers)
        assert fallback.status_code == 503 and await attempts() == before + 2
        async with database.connection() as conn:
            await conn.execute('UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s', (grant['id'],))
        revoked = await client.get(f'/api/v{version}/kline-sessions?market=US&code=AAPL', headers=headers)
        assert revoked.status_code == 401 and revoked.headers['x-alcor-retire-context'] == 'true'
        assert await attempts() == before + 2
    finally:
        app.state.cache.client = None
        await cache.aclose()
