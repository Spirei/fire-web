import httpx
import pytest
from fastapi import Request
from pydantic import ValidationError

from alcor_api.config import Settings
from alcor_api.legacy_identity import assert_native_origin
from alcor_api.main import create_app


@pytest.mark.parametrize("value", ["*", "10.0.0.0/8", "proxy.example.invalid", "127.0.0.1:8080"])
def test_proxy_configuration_requires_exact_addresses(value):
    with pytest.raises(ValidationError):
        Settings(trusted_proxy_ips=[value])


@pytest.mark.parametrize("peer, trusted, forwarded, origin, host, status", [
    ("192.0.2.10", ["192.0.2.10"], "https", None, "api.example.invalid", 200),
    ("192.0.2.11", ["192.0.2.10"], "https", None, "api.example.invalid", 403),
    ("192.0.2.10", [], "https", None, "api.example.invalid", 403),
    ("192.0.2.10", ["192.0.2.10"], "http", None, "api.example.invalid", 403),
    ("192.0.2.10", ["192.0.2.10"], "https", "https://other.example.invalid", "api.example.invalid", 403),
    ("192.0.2.10", ["192.0.2.10"], "https", None, "wrong.example.invalid", 403),
])
async def test_proxy_translation_preserves_exact_origin_and_untrusted_peer_rejection(peer, trusted, forwarded, origin, host, status):
    settings = Settings(environment="test", public_origin="https://api.example.invalid", trusted_proxy_ips=trusted)
    app = create_app(settings)

    @app.get("/api/origin-test")
    async def probe(request: Request):
        assert_native_origin(request, settings)
        return {"scheme": request.url.scheme}

    app.router.routes.insert(0, app.router.routes.pop())
    headers = {"host": host, "x-forwarded-proto": forwarded}
    if origin:
        headers["origin"] = origin
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(peer, 1234)), base_url="http://api.example.invalid") as client:
        result = await client.get("/api/origin-test", headers=headers)
        assert result.status_code == status, result.text
        if status == 200:
            assert result.json()["scheme"] == "https"
        cross = await client.get("/api/origin-test", headers={**headers, "sec-fetch-site": "cross-site"})
        assert cross.status_code == 403


def test_proxy_addresses_are_normalized_and_deduplicated():
    settings = Settings(trusted_proxy_ips=["192.0.2.10", "2001:0db8::1", "192.0.2.10"])
    assert settings.trusted_proxy_ips == ["192.0.2.10", "2001:db8::1"]


async def test_forwarded_https_port_preserves_session_origin_and_csrf(settings):
    """Synthetic TLS-terminating hop over the existing independent ledger and watch state."""
    from uuid import uuid4
    from alcor_api.cli import create_user

    settings.public_origin = "https://api.example.invalid:18520"
    settings.trusted_proxy_ips = ["192.0.2.10"]
    app = create_app(settings)

    async def physical_http_hop(scope, receive, send):
        forwarded = {**scope, "scheme": "http"}
        await app(forwarded, receive, send)

    async with app.router.lifespan_context(app):
        await create_user(settings, "ProxySynthetic", "Synthetic9Pass", is_test=True)
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=physical_http_hop, client=("192.0.2.10", 1234)),
            base_url=settings.public_origin,
            headers={"origin": settings.public_origin, "x-forwarded-proto": "https"},
        ) as client:
            login = await client.post("/api/session/login", json={"login": "ProxySynthetic", "password": "Synthetic9Pass"})
            assert login.status_code == 200, login.text
            csrf = login.json()["csrf"]
            client.headers["x-csrf-token"] = csrf
            state = await client.get("/api/account/state?namespace=watch")
            assert state.status_code == 200, state.text
            assert (await client.get("/api/account/state?namespace=watch", headers={"origin": "https://other.example.invalid"})).status_code == 403
            assert (await client.get("/api/account/state?namespace=watch", headers={"x-forwarded-proto": "http"})).status_code == 403
            assert (await client.get("/api/account/state?namespace=watch", headers={"sec-fetch-site": "cross-site"})).status_code == 403
            body = {"requestId": str(uuid4()), "expectedRevision": 0, "ledger": {"logs": [{"note": "synthetic only"}]}}
            assert (await client.put("/api/account/simple-ledger", json=body, headers={"x-csrf-token": "wrong"})).status_code == 403
            assert (await client.get("/api/account/simple-ledger")).json()["revision"] == 0
            saved = await client.put("/api/account/simple-ledger", json=body)
            assert saved.status_code == 200, saved.text
            assert saved.json()["revision"] == 1
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=physical_http_hop, client=("192.0.2.11", 1234)),
                base_url=settings.public_origin, cookies=client.cookies,
                headers={"origin": settings.public_origin, "x-forwarded-proto": "https", "x-csrf-token": csrf},
            ) as untrusted:
                denied = await untrusted.get("/api/account/state?namespace=watch")
                assert denied.status_code == 403, denied.text


def test_proxy_list_uses_json_environment_values_and_rejects_wildcards(monkeypatch):
    monkeypatch.setenv("ALCOR_TRUSTED_PROXY_IPS", '["192.0.2.10", "2001:db8::1"]')
    assert Settings().trusted_proxy_ips == ["192.0.2.10", "2001:db8::1"]
    monkeypatch.setenv("ALCOR_TRUSTED_PROXY_IPS", '["*"]')
    with pytest.raises(ValidationError):
        Settings()
