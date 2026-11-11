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
