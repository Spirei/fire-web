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


class ReadBudgets:
    def __init__(self, cache, instance_id):
        self.cache, self.instance_id = cache, str(instance_id)
        self.failed_client, self.retry_at = None, 0

    async def allow(self, key, maximum, window_seconds, fallback):
        if type(maximum) is not int or maximum < 1 or type(window_seconds) is not int or not 1 <= window_seconds <= 86400:
            raise ValueError('Invalid read budget')
        client = self.cache.client
        if client is not None and (client is not self.failed_client or monotonic() >= self.retry_at):
            try:
                # No URL, security token, account name or financial data is cached.
                bucket = hashlib.sha256(str(key).encode()).hexdigest()
                with measure('read_admission_redis'):
                    async with asyncio.timeout(1):
                        value = await client.eval(SCRIPT, 1, f'alcor:{self.instance_id}:read-budget:{bucket}', window_seconds)
                if type(value) is not int or value < 1:
                    raise ValueError('Invalid read counter')
                self.failed_client, self.retry_at = None, 0
                return value <= maximum
            except (RedisError, OSError, TimeoutError, ValueError):
                self.failed_client, self.retry_at = client, monotonic()+30
        with measure('read_admission_pg'):
            return await fallback()
