"""Pinned outbound transport; DNS resolved once, every address must be approved."""

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

import httpcore
from httpcore._backends.auto import AutoBackend

from .fx_provider_parser import approved_target
from .fx_response_originals import ResponseBytes, ResponseRejected


class PinnedBackend:
    def __init__(self, host, port, address, delegate=None):
        self.host, self.port = host, port
        self.address = str(ipaddress.ip_address(address))
        self.delegate = delegate or AutoBackend()

    async def connect_tcp(self, host, port, **kwargs):
        if (host, port) != (self.host, self.port):
            raise ValueError("unapproved_connection")
        return await self.delegate.connect_tcp(self.address, port, **kwargs)

    async def connect_unix_socket(self, *args, **kwargs):
        raise ValueError("unix_socket_forbidden")

    async def sleep(self, seconds):
        await asyncio.sleep(seconds)


async def resolve(host, port):
    rows = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return sorted({row[4][0] for row in rows})


async def fetch(url, approval, headers=None, *, resolver=resolve, backend_factory=PinnedBackend):
    parsed = urlsplit(url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    # Validate static target before DNS, preventing arbitrary DNS probing.
    approved_target(url, approval, approval["addresses"])
    async with asyncio.timeout(15):
        addresses = await resolver(parsed.hostname, port)
        pins = approved_target(url, approval, addresses)
        backend = backend_factory(parsed.hostname, port, pins[0])
        # URL hostname is retained for certificate validation / TLS SNI / Host.
        async with (
            httpcore.AsyncConnectionPool(network_backend=backend, retries=0, max_connections=1) as pool,
            pool.stream(
                "GET",
                url,
                headers=headers or {},
                extensions={"timeout": {"connect": 5, "read": 5, "write": 5, "pool": 5}},
            ) as response,
        ):
            raw = bytearray()
            try:
                async for chunk in response.aiter_stream():
                    raw.extend(chunk)
                    if len(raw) > 131072:
                        raise ResponseRejected(raw,response.status,False,'response_too_large')
            except (httpcore.NetworkError,httpcore.ProtocolError,httpcore.TimeoutException,asyncio.CancelledError) as error:
                raise ResponseRejected(raw,response.status,False,'provider_response_interrupted') from error
            if response.status!=200:
                raise ResponseRejected(raw,response.status,True)
            return ResponseBytes(raw)
