"""Operator-configured Yahoo egress; original public IP, TLS name and HTTP identity stay pinned."""
import asyncio
import ipaddress
import os
from urllib.parse import urlsplit

import httpcore

from .fx_provider_transport import PinnedBackend, resolve
from .market_public_dns import public_addresses


def proxy_address(value):
    if value.strip().lower() in ('', 'off', '0', 'false'):
        return None
    try:
        parsed = urlsplit(value)
        port = 8080 if parsed.port is None else parsed.port
        if (any(ord(c) <= 32 for c in value) or parsed.scheme != 'http' or not parsed.hostname
                or parsed.username or parsed.password or parsed.path not in ('', '/')
                or parsed.query or parsed.fragment or not 1 <= port <= 65535):
            raise ValueError()
        return parsed.hostname, port
    except ValueError:
        raise ValueError('quote_proxy_configuration_invalid') from None


class TunnelBackend:
    def __init__(self, host, port, addresses, proxy_host, proxy_port, proxy_addresses, delegate=None):
        self.host, self.port = host, port
        # CONNECT is to one verified public IP. The proxy never resolves the source host.
        self.address = sorted(public_addresses(addresses), key=lambda a: (ipaddress.ip_address(a).version, a))[0]
        self.proxy = PinnedBackend(proxy_host, proxy_port, proxy_addresses, delegate)

    async def connect_tcp(self, host, port, **kwargs):
        if (host, port) != (self.host, self.port):
            raise ValueError('unapproved_connection')
        budget = kwargs.get('timeout')
        budget = 5.0 if budget is None else budget
        stream = None
        try:
            async with asyncio.timeout(budget):
                stream = await self.proxy.connect_tcp(self.proxy.host, self.proxy.port, **kwargs)
                authority = (f'[{self.address}]' if ':' in self.address else self.address) + ':' + str(port)
                await stream.write(f'CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n'.encode('ascii'), timeout=budget)
                reply = bytearray()
                while b'\r\n\r\n' not in reply:
                    chunk = await stream.read(1024, timeout=budget)
                    if not chunk or len(reply) + len(chunk) > 16384:
                        raise httpcore.ProxyError('quote_proxy_tunnel_invalid')
                    reply.extend(chunk)
                head, extra = bytes(reply).split(b'\r\n\r\n', 1)
                first = head.split(b'\r\n', 1)[0].split(b' ', 2)
                if extra or len(first) < 2 or first[0] not in (b'HTTP/1.0', b'HTTP/1.1') or first[1] != b'200':
                    raise httpcore.ProxyError('quote_proxy_tunnel_refused')
                # httpcore starts TLS on this same stream with the original URL's
                # hostname and default certificate verification, then sends HTTP once.
                return stream
        except BaseException as error:
            if stream is not None:
                await stream.aclose()
            if isinstance(error, TimeoutError):
                raise httpcore.ConnectTimeout() from None
            raise

    async def connect_unix_socket(self, *args, **kwargs):
        raise ValueError('unix_socket_forbidden')

    async def sleep(self, seconds):
        await asyncio.sleep(seconds)


async def quote_backend(url, pins, *, resolver=resolve, value=None):
    parsed = urlsplit(url)
    host, port = parsed.hostname, parsed.port or 443
    if (parsed.scheme != 'https' or port != 443 or host not in ('query1.finance.yahoo.com', 'query2.finance.yahoo.com')
            or not parsed.path.startswith('/v8/finance/chart/')):
        return PinnedBackend(host, port, pins)
    address = proxy_address(os.environ.get('STOCKLOG_PROXY', '') if value is None else value)
    if address is None:
        return PinnedBackend(host, port, pins)
    proxy_host, proxy_port = address
    proxy_ips = await resolver(proxy_host, proxy_port)
    if not 1 <= len(proxy_ips) <= 32:
        raise ValueError('quote_proxy_configuration_invalid')
    try:
        if any(ipaddress.ip_address(a).is_multicast or ipaddress.ip_address(a).is_unspecified
               or ipaddress.ip_address(a).is_link_local for a in proxy_ips):
            raise ValueError()
    except ValueError:
        raise ValueError('quote_proxy_configuration_invalid') from None
    return TunnelBackend(host, port, pins, proxy_host, proxy_port, proxy_ips)
