"""Deployment uses the signed-in administrator, CSRF and durable receipts, without password prompts."""

import time
from uuid import uuid4

import httpx
from alcor_api import deployment_watchtower as bridge
from alcor_api.connections import Vault
from alcor_api.native_identity import totp_code
from alcor_api.security import COOKIE
from pydantic import SecretStr
from test_deployment_config import P, save
from test_deployment_requests import configure


async def age(db):
    async with db.connection() as conn:
        await conn.execute("UPDATE sessions SET created_at=clock_timestamp()-interval '16 minutes'")


async def test_signed_in_admin_saves_without_password_and_keeps_cookie_expiry_and_receipt(client, admin, db):
    await age(db)
    cookie = client.cookies[COOKIE]
    async with db.connection() as conn:
        before = await (await conn.execute("SELECT created_at,expires_at FROM sessions")).fetchone()
    request_id = str(uuid4())
    accepted = await save(client, request_id=request_id)
    assert accepted.status_code == 200 and accepted.json()["hasToken"], accepted.text
    assert "x-alcor-reauthentication" not in accepted.headers
    assert client.cookies[COOKIE] == cookie
    assert (await save(client, request_id=request_id)).json() == accepted.json()
    assert (await client.get(P + "/config/receipts/" + request_id)).json() == accepted.json()
    assert "SyntheticGithubCredential9" not in accepted.text
    async with db.connection() as conn:
        assert await (await conn.execute("SELECT created_at,expires_at FROM sessions")).fetchone() == before
        assert (await (await conn.execute("SELECT count(*) AS n FROM deployment_config_actions")).fetchone())["n"] == 1
        assert (await (await conn.execute("SELECT count(*) AS n FROM identity_challenges WHERE purpose='deployment-reauth'")).fetchone())["n"] == 0


async def test_optional_legacy_verification_still_requires_totp_and_rejects_replay(client, admin, db, settings):
    secret = "JBSWY3DPEHPK3PXP"
    cipher = Vault(settings.connection_secret_dir).encrypt(secret, "totp:" + admin, settings.instance_id)
    async with db.connection() as conn:
        await conn.execute("INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext) VALUES(%s,true,%s)", (admin, cipher))
    await age(db)
    assert (await client.post(P + "/reauthenticate", json={"password": "Synthetic9Pass"})).status_code == 403
    data = {"password": "Synthetic9Pass", "code": totp_code(secret, int(time.time()))}
    assert (await client.post(P + "/reauthenticate", json=data)).status_code == 204
    assert (await client.post(P + "/reauthenticate", json=data)).status_code == 403


async def test_deployment_keeps_csrf_revocation_and_expiry_and_connection_policy(client, admin, db, app, monkeypatch):
    _release, calls, _headers = configure(app, monkeypatch)
    await age(db)
    rejected = await client.post(P + "/builds", json={"request_id": str(uuid4())}, headers={"x-csrf-token": "invalid"})
    assert rejected.status_code == 403
    assert not any(path.endswith("/dispatches") for path, _ in calls)
    # Deployment policy does not relax connection configuration's separate verification.
    from test_connections import request_data
    connection = await request_data(client, app.state.settings)
    assert (await client.put("/api/connections/postgresql", json=connection)).headers["x-alcor-reauthentication"] == "required"
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET role='user' WHERE id=%s", (admin,))
    assert (await client.get(P)).status_code == 403
    assert (await save(client)).status_code == 403
    assert (await client.post(P + "/builds", json={"request_id": str(uuid4())})).status_code == 403
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET role='admin' WHERE id=%s", (admin,))
        await conn.execute("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second'")
    assert (await client.get(P)).status_code == 401
    assert (await client.post(P + "/builds", json={"request_id": str(uuid4())})).status_code == 401
    assert not any(path.endswith("/dispatches") for path, _ in calls)


async def test_normal_and_unauthenticated_accounts_cannot_read_or_mutate_git_page(client, admin, app, monkeypatch):
    release, calls, _headers = configure(app, monkeypatch)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver", headers={"origin":"http://testserver"}) as other:
        assert (await other.get(P)).status_code == 401
        assert (await other.post(P + "/builds", json={"request_id":str(uuid4())})).status_code == 401
        registered = await other.post("/api/session/register", json={"username":"OrdinaryUser", "password":"Synthetic9Pass"})
        assert registered.status_code == 201
        login = await other.post("/api/session/login", json={"login":"OrdinaryUser", "password":"Synthetic9Pass"})
        other.headers["x-csrf-token"] = login.json()["csrf"]
        for path in (P, P + "/config", P + "/history", P + "/activity"):
            assert (await other.get(path)).status_code == 403
        assert (await save(other)).status_code == 403
        assert (await other.post(P + "/builds", json={"request_id":str(uuid4())})).status_code == 403
        assert (await other.post(P + "/requests", json={"request_id":str(uuid4()),"release":release.model_dump()})).status_code == 403
    assert not any(path.endswith("/dispatches") for path, _ in calls)


async def test_stale_admin_oauth_starts_directly_and_keeps_session_bound_state(client, admin, app, db):
    app.state.settings.public_origin = "https://testserver"
    app.state.settings.deployment_github_client_id = "SyntheticClient"
    app.state.settings.deployment_github_client_secret = SecretStr("SyntheticClientSecret")
    client.base_url = "https://testserver"
    client.headers["origin"] = "https://testserver"
    await age(db)
    response = await client.get(P + "/github/start")
    assert response.status_code == 303 and response.headers["location"].startswith("https://github.com/login/oauth/authorize?")
    assert "Secure" in response.headers["set-cookie"]
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM deployment_oauth_states")).fetchone())["n"] == 1


async def test_admin_deployment_without_password_keeps_original_uuid_and_does_not_redispatch(client, admin, app, db, monkeypatch):
    release, calls, _headers = configure(app, monkeypatch)
    app.state.settings.deployment_updater_url = "http://alcor-watchtower:8080/v1/update"
    monkeypatch.setattr(bridge, "probe", lambda _settings: {"configured": True, "online": True, "kind": "watchtower", "observed_at": None, "reason": "synthetic port"})
    notifications = []
    monkeypatch.setattr(bridge, "notify", lambda _settings: notifications.append(True) or {"status": "running", "message": "notified"})
    await age(db)
    build_id, update_id = str(uuid4()), str(uuid4())
    update = {"request_id": update_id, "release": release.model_dump()}
    first = await client.post(P + "/builds", json={"request_id": build_id})
    assert first.status_code == 202 and "x-alcor-reauthentication" not in first.headers
    assert (await client.post(P + "/builds", json={"request_id": build_id})).json() == first.json()
    assert sum(path.endswith("/dispatches") for path, _ in calls) == 1
    first = await client.post(P + "/requests", json=update)
    assert first.status_code == 202 and "x-alcor-reauthentication" not in first.headers, first.text
    assert first.json()["status"] == "running"
    assert (await client.post(P + "/requests", json=update)).json()["id"] == first.json()["id"]
    assert len(notifications) == 1
