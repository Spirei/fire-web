"""Shared Redis admission for read traffic; never authentication or provider quota."""

import asyncio
import hashlib
from time import monotonic

from redis.exceptions import RedisError

from .request_timing import measure

SCRIPT = """
local n = redis.call('INCR', KEYS[1])
if n == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return n
"""

SCRIPT_MANY = """
local out = {}
for index = 1, #KEYS do
  local n = redis.call('INCR', KEYS[index])
  if n == 1 or redis.call('TTL', KEYS[index]) < 0 then
    redis.call('EXPIRE', KEYS[index], ARGV[1])
  end
  out[index] = n
end
return out
"""


class ReadBudgets:
    def __init__(self, cache, instance_id):
        self.cache, self.instance_id = cache, str(instance_id)
        self.failed_client, self.retry_at = None, 0

    async def allow(self, key, maximum, window_seconds, fallback):
        return await self.allow_many(((key, maximum),), window_seconds, fallback)

    async def allow_many(self, checks, window_seconds, fallback):
        checks = tuple(checks)
        if not checks:
            return True
        if (
            type(window_seconds) is not int
            or not 1 <= window_seconds <= 86400
            or any(type(maximum) is not int or maximum < 1 for _, maximum in checks)
        ):
            raise ValueError('Invalid read budget')
        client = self.cache.client
        if client is not None and (client is not self.failed_client or monotonic() >= self.retry_at):
            try:
                # No URL, security token, account name or financial data is cached.
                buckets = [
                    f'alcor:{self.instance_id}:read-budget:{hashlib.sha256(str(key).encode()).hexdigest()}'
                    for key, _ in checks
                ]
                with measure('read_admission_redis'):
                    async with asyncio.timeout(1):
                        values = await client.eval(SCRIPT_MANY, len(buckets), *buckets, window_seconds)
                # A single-key client may reply with a scalar; the shared script
                # always returns an array in Redis.
                if type(values) is int and len(checks) == 1:
                    values = [values]
                if (
                    not isinstance(values, (list, tuple))
                    or len(values) != len(checks)
                    or any(type(value) is not int or value < 1 for value in values)
                ):
                    raise ValueError('Invalid read counter')
                self.failed_client, self.retry_at = None, 0
                return all(
                    value <= maximum
                    for value, (_, maximum) in zip(values, checks)
                )
            except (RedisError, OSError, TimeoutError, ValueError):
                self.failed_client, self.retry_at = client, monotonic()+30
        with measure('read_admission_pg'):
            return await fallback()
