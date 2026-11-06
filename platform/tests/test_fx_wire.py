import ssl

import pytest
from alcor_api.fx_provider_transport import PinnedBackend, fetch


class Stream:
    def __init__(self, response):
        self.response = response
        self.writes = []
        self.tls = []

    async def read(self, max_bytes, timeout=None):
        result = self.response[:max_bytes]
        self.response = self.response[max_bytes:]
        return result

    async def write(self, buffer, timeout=None):
        self.writes.append(bytes(buffer))

    async def aclose(self):
        pass

    async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        self.tls.append((ssl_context, server_hostname))
        return self

    def get_extra_info(self, info):
        return None


class Delegate:
    def __init__(self, stream):
        self.stream = stream
        self.connections = []

    async def connect_tcp(self, host, port, **kwargs):
        self.connections.append((host, port))
        return self.stream


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [200, 302])
async def test_real_httpcore_wire_exact_target_tls_host_and_no_redirect(status):
    stream = Stream(
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"
        if status == 200
        else b"HTTP/1.1 302 Found\r\nLocation: https://evil.example/steal\r\nContent-Length: 0\r\n\r\n"
    )
    delegate = Delegate(stream)
    factories = []

    def factory(host, port, address):
        factories.append((host, port, address))
        return PinnedBackend(host, port, address, delegate)

    resolutions = []

    async def resolver(host, port):
        resolutions.append((host, port))
        return ["192.0.2.20"]

    target = "/rates/%2fCase?sig=A%2fb%3D&x=1&x=2&empty=&bare&plus=+&space=%20&literal=%2B"
    approval = {"target": ["https", "provider.example", 8443, "/rates/%2fCase"], "addresses": ["192.0.2.20"]}
    call = fetch(
        "https://provider.example:8443" + target,
        approval,
        {"Authorization": "Bearer synthetic"},
        resolver=resolver,
        backend_factory=factory,
    )
    if status == 200:
        assert await call == b"{}"
    else:
        with pytest.raises(ValueError, match="provider_http_error"):
            await call
    raw = b"".join(stream.writes)
    assert raw.startswith(("GET " + target + " HTTP/1.1\r\n").encode())
    assert b"Host: provider.example:8443\r\n" in raw
    assert b"Authorization: Bearer synthetic\r\n" in raw
    assert len(stream.tls) == 1
    context, hostname = stream.tls[0]
    assert hostname == "provider.example"
    assert context.check_hostname and context.verify_mode == ssl.CERT_REQUIRED
    assert delegate.connections == [("192.0.2.20", 8443)]
    assert resolutions == [("provider.example", 8443)]
    assert factories == [("provider.example", 8443, "192.0.2.20")]
    assert raw.count(b"GET ") == 1


@pytest.mark.asyncio
async def test_unapproved_dns_or_pool_target_never_connects():
    stream = Stream(b"")
    delegate = Delegate(stream)
    backend = PinnedBackend("provider.example", 443, "192.0.2.20", delegate)
    for host, port in [("evil.example", 443), ("provider.example", 444)]:
        with pytest.raises(ValueError, match="unapproved_connection"):
            await backend.connect_tcp(host, port)

    async def resolver(*args):
        return ["192.0.2.20", "192.0.2.21"]

    with pytest.raises(ValueError, match="address_not_approved"):
        await fetch(
            "https://provider.example/rates",
            {"target": ["https", "provider.example", 443, "/rates"], "addresses": ["192.0.2.20"]},
            resolver=resolver,
            backend_factory=lambda *args: backend,
        )
    assert delegate.connections == []
