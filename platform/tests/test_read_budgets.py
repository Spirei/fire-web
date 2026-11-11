import asyncio
from types import SimpleNamespace
from uuid import uuid4

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
