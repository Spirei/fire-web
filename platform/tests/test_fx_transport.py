import pytest
from alcor_api.fx_provider_transport import PinnedBackend, fetch


@pytest.mark.asyncio
async def test_transport_pins_connect_and_preserves_origin():
    calls = []

    class Delegate:
        async def connect_tcp(self, host, port, **kwargs):
            calls.append((host, port))
            return "stream"

    backend = PinnedBackend("provider.example", 443, "192.0.2.20", Delegate())
    assert await backend.connect_tcp("provider.example", 443) == "stream"
    assert calls == [("192.0.2.20", 443)]
    with pytest.raises(ValueError):
        await backend.connect_tcp("attacker.example", 443)


@pytest.mark.asyncio
async def test_transport_http_bytes_without_network():
    writes = []

    class Stream:
        sent = False

        async def read(self, max_bytes, timeout=None):
            if self.sent:
                return b""
            self.sent = True
            return b'HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{"ok":true}'

        async def write(self, buffer, timeout=None):
            writes.append(buffer)

        async def aclose(self):
            pass

        def get_extra_info(self, info):
            return None

    class Backend:
        async def connect_tcp(self, host, port, **kwargs):
            return Stream()

    approval = {
        "target": ["http", "provider.example", 80, "/rates"],
        "addresses": ["192.0.2.20"],
        "allow_plaintext": True,
    }

    async def resolver(host, port):
        return ["192.0.2.20"]

    raw = await fetch(
        "http://provider.example/rates", approval, resolver=resolver, backend_factory=lambda *args: Backend()
    )
    assert raw == b'{"ok":true}'
    assert b"Host: provider.example" in b"".join(writes)


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [200, 302])
async def test_https_sni_and_redirect_refusal(status):
    tls = []
    connections = []

    class Stream:
        sent = False

        async def read(self, max_bytes, timeout=None):
            if self.sent:
                return b""
            self.sent = True
            return f"HTTP/1.1 {status} Test\r\nContent-Length: 2\r\nLocation: http://unapproved.example/\r\n\r\n{{}}".encode()

        async def write(self, buffer, timeout=None):
            pass

        async def aclose(self):
            pass

        def get_extra_info(self, info):
            return None

        async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
            tls.append((server_hostname, ssl_context.check_hostname))
            return self

    class Delegate:
        async def connect_tcp(self, host, port, **kwargs):
            connections.append((host, port))
            return Stream()

    approval = {"target": ["https", "provider.example", 443, "/rates"], "addresses": ["192.0.2.20"]}

    async def resolver(host, port):
        return ["192.0.2.20"]

    call = fetch(
        "https://provider.example/rates",
        approval,
        resolver=resolver,
        backend_factory=lambda host, port, ip: PinnedBackend(host, port, ip, Delegate()),
    )
    if status == 200:
        assert await call == b"{}"
    else:
        with pytest.raises(ValueError, match="provider_http_error"):
            await call
    assert connections == [("192.0.2.20", 443)]
    assert tls == [("provider.example", True)]
