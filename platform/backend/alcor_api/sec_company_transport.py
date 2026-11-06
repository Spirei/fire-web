"""Explicit fixed SEC targets only; no redirect, retry, cookie or default install."""

import asyncio

import httpcore

from .fx_provider_parser import approved_target
from .fx_provider_transport import PinnedBackend, resolve
from .sec_company_protocol import LIMIT


class PageFailure(ValueError):
    def __init__(self, raw, status, complete):
        super().__init__("sec_http_or_page_budget")
        self.raw, self.status, self.complete = raw, status, complete


class Transport:
    async def read(self, target, cik=None):
        url, approval = target.request(cik)
        host = approval["target"][1]
        approved_target(url, approval, approval["addresses"])
        async with asyncio.timeout(15):
            pins = approved_target(url, approval, await resolve(host, 443))
            backend = PinnedBackend(host, 443, pins[0])
            async with (
                httpcore.AsyncConnectionPool(network_backend=backend, retries=0, max_connections=1) as pool,
                pool.stream("GET", url,
                            headers={"User-Agent": target.user_agent, "Accept": "application/json", "Accept-Encoding": "identity"},
                            extensions={"timeout": {"connect": 5, "read": 5, "write": 5, "pool": 5}}) as response,
            ):
                raw = bytearray()
                async for chunk in response.aiter_stream():
                    remaining = LIMIT - len(raw)
                    raw.extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        raise PageFailure(bytes(raw), response.status, False)
                body = bytes(raw)
                if response.status != 200:
                    raise PageFailure(body, response.status, True)
                return body
