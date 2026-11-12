import asyncio

import httpcore
import pytest

from alcor_api.fx_provider_transport import PinnedBackend
from alcor_api.market_quote_proxy import TunnelBackend, proxy_address, quote_backend

YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d'


@pytest.mark.parametrize('value', ['', 'off', '0', 'false', ' OFF '])
def test_explicit_off(value):
    assert proxy_address(value) is None


@pytest.mark.parametrize('value', [
    'https://proxy:1088', 'socks5://proxy:1088', 'http://user:secret@proxy:1088',
    'http://proxy:0', 'http://proxy:65536', 'http://proxy:bad', 'http://proxy/path',
    'http://proxy?secret=x', 'http://proxy#fragment', 'http://proxy\n', '//proxy',
])
def test_invalid_operator_configuration_does_not_leak(value):
    with pytest.raises(ValueError, match='^quote_proxy_configuration_invalid$'):
        proxy_address(value)


async def test_scope_never_changes_fx_private_futu_or_other_public_sources():
    async def no_dns(*_):
        raise AssertionError('unrelated source must never resolve proxy')
    for url in ['https://rates.example.test/latest', 'http://192.0.2.1:11111/',
                'https://push2delay.eastmoney.com/api/qt/ulist.np/get',
                'https://query1.finance.yahoo.com/unrelated']:
        assert isinstance(await quote_backend(url, ['8.8.8.8'], resolver=no_dns, value='invalid'), PinnedBackend)
    assert isinstance(await quote_backend(YAHOO, ['8.8.8.8'], resolver=no_dns, value='off'), PinnedBackend)


async def test_current_operator_proxy_is_resolved_and_connected_only_to_its_checked_addresses(monkeypatch):
    calls = []
    async def resolver(host, port):
        calls.append((host, port))
        return ['192.0.2.7']
    monkeypatch.setenv('STOCKLOG_PROXY', 'http://operator-proxy:1088')
    backend = await quote_backend(YAHOO, ['8.8.8.8'], resolver=resolver)
    assert isinstance(backend, TunnelBackend)
    assert calls == [('operator-proxy', 1088)]
    assert backend.proxy.addresses == ('192.0.2.7',)
    for answers in [[], ['0.0.0.0'], ['224.0.0.1'], ['169.254.169.254'], ['192.0.2.7', 'fe80::1']]:
        async def invalid(*_): return answers
        with pytest.raises(ValueError, match='quote_proxy_configuration_invalid'):
            await quote_backend(YAHOO, ['8.8.8.8'], resolver=invalid)


class Stream:
    def __init__(self, chunks):
        self.chunks, self.writes, self.closed = list(chunks), [], False
    async def write(self, value, **_): self.writes.append(value)
    async def read(self, *_args, **_kwargs): return self.chunks.pop(0) if self.chunks else b''
    async def aclose(self): self.closed = True


class Delegate:
    def __init__(self, stream): self.stream, self.calls = stream, []
    async def connect_tcp(self, host, port, **kwargs):
        self.calls.append((host, port))
        return self.stream


async def test_one_ip_tunnel_returns_original_stream_for_verified_hostname_tls():
    stream = Stream([b'HTTP/1.1 200 Connection established\r\n', b'\r\n'])
    delegate = Delegate(stream)
    backend = TunnelBackend('query1.finance.yahoo.com', 443, ['8.8.8.8'], 'proxy', 1088, ['192.0.2.7'], delegate)
    assert await backend.connect_tcp('query1.finance.yahoo.com', 443, timeout=1) is stream
    assert delegate.calls == [('192.0.2.7', 1088)]
    assert stream.writes == [b'CONNECT 8.8.8.8:443 HTTP/1.1\r\nHost: 8.8.8.8:443\r\n\r\n']
    assert not stream.closed
    with pytest.raises(ValueError, match='unapproved_connection'):
        await backend.connect_tcp('unapproved.example', 443)
    assert len(delegate.calls) == 1


@pytest.mark.parametrize('chunks', [
    [b'HTTP/1.1 407 Authentication Required\r\n\r\n'],
    [b'HTTP/1.1 302 Redirect\r\nLocation: http://private/\r\n\r\n'],
    [b'HTTP/1.1 200 OK\r\n\r\nunexpected'], [b'not-http\r\n\r\n'],
    [b'A' * 17000], [b'HTTP/1.1 200 OK\r\n'],
])
async def test_refused_malformed_or_unbounded_tunnel_closes_without_retry(chunks):
    stream = Stream(chunks)
    delegate = Delegate(stream)
    backend = TunnelBackend('query1.finance.yahoo.com', 443, ['8.8.8.8'], 'proxy', 1088, ['192.0.2.7'], delegate)
    with pytest.raises(httpcore.ProxyError):
        await backend.connect_tcp('query1.finance.yahoo.com', 443, timeout=1)
    assert stream.closed and len(stream.writes) == len(delegate.calls) == 1


async def test_timeout_closes_tunnel_and_never_replays_http():
    class Slow(Stream):
        async def read(self, *_args, **_kwargs): await asyncio.sleep(1)
    stream = Slow([])
    backend = TunnelBackend('query1.finance.yahoo.com', 443, ['8.8.8.8'], 'proxy', 1088, ['192.0.2.7'], Delegate(stream))
    with pytest.raises(httpcore.ConnectTimeout):
        await backend.connect_tcp('query1.finance.yahoo.com', 443, timeout=.01)
    assert stream.closed and len(stream.writes) == 1


@pytest.mark.parametrize('pins', [['127.0.0.1'], ['8.8.8.8', '10.0.0.1'], ['::ffff:127.0.0.1']])
def test_proxy_cannot_resolve_or_connect_a_private_source(pins):
    with pytest.raises(ValueError, match='address_not_approved'):
        TunnelBackend('query1.finance.yahoo.com', 443, pins, 'proxy', 1088, ['192.0.2.7'])
