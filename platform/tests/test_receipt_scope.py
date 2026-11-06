import httpx
import pytest


@pytest.mark.asyncio
async def test_receipt_scope_is_noncredential_stable_per_session_and_changes_on_login(client, app, admin):
    first = (await client.get("/api/session")).json()
    second = (await client.get("/api/session")).json()
    assert first["receipt_scope"] == second["receipt_scope"]
    assert len(first["receipt_scope"]) == 64
    assert first["receipt_scope"] != first["csrf"]
    assert first["receipt_scope"] not in client.cookies.values()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as other:
        login = await other.post(
            "/api/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"}
        )
        assert login.status_code == 200
        assert login.json()["receipt_scope"] != first["receipt_scope"]
        other.cookies.clear()
        other.cookies.set("alcor_session", first["receipt_scope"])
        assert (await other.get("/api/session")).status_code == 401
