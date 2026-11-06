"""Five unversioned legacy Web methods against a real, identity-checked isolated PG."""

import asyncio
import importlib

import httpx
from alcor_api.accounts import insert_account
from alcor_api.main import create_app
from alcor_api.security import digest

PASSWORD = "SyntheticRegister9"


async def register(client, name="WebOwner", **extra):
    return await client.post("/api/auth/register", json={"username": name, "password": PASSWORD, **extra})


async def test_five_methods_preserve_web_contract_and_persist_across_api_restart(client, db, settings):
    assert (await client.get("/api/auth/setup-status")).json() == {"needsSetup": True}
    result = await register(client)
    assert result.status_code == 201, result.text
    user = result.json()["user"]
    assert user["role"] == "admin" and user["username"] == "WebOwner"
    assert "token" not in result.text and PASSWORD not in result.text
    assert "httponly" in result.headers["set-cookie"].lower()
    assert "samesite=lax" in result.headers["set-cookie"].lower()
    assert "fire_session" in client.cookies and "alcor_session" not in client.cookies
    assert (await client.get("/api/auth/setup-status")).json() == {"needsSetup": False}
    assert (await client.get("/api/auth/me")).json() == {"user": user}
    assert (await client.get("/api/session")).status_code == 401
    token = client.cookies["fire_session"]
    async with db.connection() as conn:
        before = await (await conn.execute("SELECT expires_at FROM sessions WHERE token_hash=%s", (digest(token),))).fetchone()
    restarted = create_app(settings)
    async with restarted.router.lifespan_context(restarted), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=restarted, raise_app_exceptions=False),
        base_url="http://testserver", headers={"origin": "http://testserver"}, cookies=client.cookies,
    ) as peer:
        response = await peer.get("/api/auth/me")
        assert response.json() == {"user": user} and "set-cookie" not in response.headers
    async with db.connection() as conn:
        assert await (await conn.execute("SELECT expires_at FROM sessions WHERE token_hash=%s", (digest(token),))).fetchone() == before
    # Cross-origin logout must not revoke the valid session.
    assert (await client.post("/api/auth/logout", headers={"origin": "https://foreign.invalid"})).status_code == 403
    assert (await client.get("/api/auth/me")).status_code == 200
    assert (await client.post("/api/auth/logout")).json() == {"ok": True}
    assert (await client.get("/api/auth/me")).status_code == 401
    assert (await client.post("/api/auth/logout")).json() == {"ok": True}
    login = await client.post("/api/auth/login", json={"username": "webowner", "password": PASSWORD})
    assert login.json()["user"] == {"id": user["id"], "username": user["username"]}
    assert login.json()["expiresIn"] == 604800
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM audit_events WHERE action='session.revoked'")).fetchone())["n"] == 1


async def test_first_admin_claim_is_atomic_across_legacy_and_new_web(client, db):
    responses = await asyncio.gather(*(
        register(client, f"WebUser{i}") if i % 2 else client.post(
            "/api/session/register", json={"username": f"NewUser{i}", "password": PASSWORD}
        ) for i in range(8)
    ))
    assert [r.status_code for r in responses] == [201] * 8
    assert sum(r.json()["user"]["role"] == "admin" for r in responses) == 1
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM sessions")).fetchone())["n"] == 8
        assert (await (await conn.execute("SELECT count(*) AS n FROM audit_events WHERE action='user.registered'")).fetchone())["n"] == 8
    # Disabled and removed accounts cannot re-open the persistent first-admin claim.
    async with db.connection() as conn, conn.transaction():
        await conn.execute("DELETE FROM sessions")
        await conn.execute("DELETE FROM audit_events")
        await conn.execute("DELETE FROM users")
    assert (await client.get("/api/auth/setup-status")).json() == {"needsSetup": False}
    assert (await register(client, "AfterRemoval")).json()["user"]["role"] == "user"


async def test_legacy_registration_validation_duplicate_and_shared_budget(client, db):
    for extra in ({"role": "admin"}, {"isTest": True}, {"setupToken": 123}):
        result = await register(client, **extra)
        assert result.status_code in (400, 403)
        assert isinstance(result.json()["error"], str) and PASSWORD not in result.text
    assert (await client.get("/api/auth/setup-status")).json()["needsSetup"]
    assert (await client.post("/api/auth/register", json={"username": "WebOwner", "password": PASSWORD}, headers={"origin": "https://foreign.invalid"})).status_code == 403
    assert (await register(client)).status_code == 201
    assert (await register(client, "WEBOWNER")).status_code == 409
    for _ in range(5):
        assert (await client.post("/api/auth/register", json={"username": "BudgetUser", "password": "short"})).status_code == 400
    assert (await client.post("/api/session/register", json={"username": "BudgetUser", "password": "short"})).status_code == 400
    assert (await register(client, "BudgetUser")).status_code == 429
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM users")).fetchone())["n"] == 1


async def test_legacy_registration_failure_rolls_back_claim_account_session_and_audit(client, db, monkeypatch):
    async def interrupted(conn, *args, **kwargs):
        await insert_account(conn, *args, **kwargs)
        raise RuntimeError("synthetic interrupted signup")
    with monkeypatch.context() as patch:
        patch.setattr(importlib.import_module("alcor_api.registration"), "insert_account", interrupted)
        result = await register(client)
    assert result.status_code == 503 and PASSWORD not in result.text
    assert isinstance(result.json()["error"], str)
    async with db.connection() as conn:
        for table in ("users", "sessions", "audit_events"):
            assert (await (await conn.execute("SELECT count(*) AS n FROM " + table)).fetchone())["n"] == 0
    assert (await client.get("/api/auth/setup-status")).json() == {"needsSetup": True}


async def test_api_root_keeps_web_protocols_distinct_without_a_version_layer(client, app):
    paths = app.openapi()["paths"]
    assert not any(p.startswith("/api/platform/") for p in paths)
    operations = [paths[path]["post"]["operationId"] for path in ("/api/auth/login", "/api/session/login")]
    assert len(set(operations)) == 2
    assert (await client.get("/api/platform/v1/meta")).status_code == 404
    assert (await client.get("/api/meta")).status_code == 200
    assert (await client.get("/api/v3/auth/config")).status_code == 404
    # Historical App compatibility remains explicit, and does not authorize platform management.
    assert (await client.get("/api/v2/auth/config")).status_code == 200
    assert (await client.get("/api/users", headers={"authorization": "Bearer synthetic-untrusted"})).status_code == 401


async def test_migration_register_counts_verified_methods_without_claiming_client_cutover(client, app, admin):
    register = (await client.get("/api/system/migration")).json()
    verified = [op for op in register["operations"] if op["status"] == "local_verified"]
    assert register["summary"]["local_verified_operations"] == len(verified)
    batch = [op for op in verified if op["verification"]["version"] == "0.1.45"]
    assert {(op["method"], op["path"]) for op in batch} == {
        ("GET", "/api/auth/setup-status"), ("POST", "/api/auth/register"),
        ("POST", "/api/auth/login"), ("GET", "/api/auth/me"), ("POST", "/api/auth/logout"),
    }
    paths = app.openapi()["paths"]
    for op in batch:
        assert op["method"].lower() in paths[op["target"]]
        assert not op["accepted"]
        assert op["client_ui"]["legacy_web"] == "pending_integration"
        assert op["verification"]["data_migration"] == "not_executed"
