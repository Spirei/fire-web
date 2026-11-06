import asyncio
import importlib

import httpx

from alcor_api.accounts import insert_account
from alcor_api.cli import create_user
from alcor_api.main import create_app
from alcor_api.passwords import verify_password
from alcor_api.security import COOKIE, digest

P = "/api"
PASSWORD = "SyntheticRegister9"


async def signup(client, username="OwnerOne", **extra):
    return await client.post(P + "/session/register", json={"username": username, "password": PASSWORD, **extra})


async def test_first_signup_admin_session_and_subsequent_user(client, db):
    assert (await client.get(P + "/auth/registration")).json() == {"first_user": True, "requires_setup_token": False}
    first = await signup(client)
    assert first.status_code == 201, first.text
    assert first.json()["user"]["role"] == "admin"
    assert "httponly" in first.headers["set-cookie"].lower()
    assert "samesite=strict" in first.headers["set-cookie"].lower()
    assert first.headers["cache-control"] == "no-store"
    assert (await client.get(P + "/session")).json()["user"] == first.json()["user"]
    assert (await client.get(P + "/system/overview")).status_code == 200
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT password_hash FROM users")).fetchone()
        assert user["password_hash"] != PASSWORD and verify_password(PASSWORD, user["password_hash"])
        session = await (await conn.execute("SELECT token_hash FROM sessions")).fetchone()
        assert session["token_hash"] == digest(client.cookies[COOKIE])
    assert (await client.get(P + "/auth/registration")).json() == {"first_user": False, "requires_setup_token": False}
    second = await signup(client, "NextUser")
    assert second.status_code == 201 and second.json()["user"]["role"] == "user"
    assert (await client.get(P + "/system/overview")).status_code == 403
    login = await client.post(P + "/session/login", json={"login": "ownerone", "password": PASSWORD})
    assert login.status_code == 200 and login.json()["user"]["role"] == "admin"


async def test_concurrent_first_signups_across_app_instances_have_only_one_admin(settings, client, db):
    other = create_app(settings)
    async with other.router.lifespan_context(other):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=other, raise_app_exceptions=False),
            base_url="http://testserver", headers={"origin": "http://testserver"},
        ) as peer:
            results = await asyncio.gather(*(signup(client if i % 2 else peer, f"parallel-{i}") for i in range(8)))
    assert [r.status_code for r in results] == [201] * 8
    assert sum(r.json()["user"]["role"] == "admin" for r in results) == 1
    async with db.connection() as conn:
        rows = await (await conn.execute("SELECT role,count(*) AS n FROM users GROUP BY role")).fetchall()
        assert {r["role"]: r["n"] for r in rows} == {"admin": 1, "user": 7}
        assert (await (await conn.execute("SELECT count(*) AS n FROM sessions")).fetchone())["n"] == 8
        assert (await (await conn.execute("SELECT count(*) AS n FROM audit_events WHERE action='user.registered'")).fetchone())["n"] == 8


async def test_duplicate_identifier_cannot_create_another_account_or_claim(client, db):
    results = await asyncio.gather(signup(client, "SameOwner"), signup(client, " SAMEOWNER "))
    assert sorted(r.status_code for r in results) == [201, 409]
    assert (await signup(client, "sameowner")).status_code == 409
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM users")).fetchone())["n"] == 1
        assert (await (await conn.execute("SELECT count(*) AS n FROM sessions")).fetchone())["n"] == 1


async def test_origin_and_role_injection_never_claim_first_admin(client):
    for extra in ({"role": "admin"}, {"role": "user"}, {"id": "u-injected"}):
        assert (await signup(client, **extra)).status_code == 422
    assert (await client.post(P + "/session/register", json={"username": "bad", "password": PASSWORD}, headers={"origin": "https://foreign.invalid"})).status_code == 403
    assert (await client.post(P + "/session/register", json={"username": "bad", "password": PASSWORD}, headers={"sec-fetch-site": "cross-site"})).status_code == 403
    assert (await client.get(P + "/auth/registration")).json()["first_user"] is True


async def test_registration_input_validation_and_redaction(client):
    for password in ("short1", "abcdefgh", "12345678"):
        r = await signup(client, password=password)
        assert r.status_code == 400
        assert password not in r.text
    for username in (" ", "a@b.invalid", "hidden\u200bname", "a" * 81):
        r = await signup(client, username)
        assert r.status_code == 422
        assert PASSWORD not in r.text
    assert (await client.get(P + "/auth/registration")).json()["first_user"] is True
    good = await signup(client, "中文用户名")
    assert good.status_code == 201 and good.json()["user"]["role"] == "admin"


async def test_disabled_or_removed_accounts_do_not_reopen_admin_registration(client, db):
    assert (await signup(client)).status_code == 201
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET active=false")
    assert (await client.get(P + "/auth/registration")).json()["first_user"] is False
    async with db.connection() as conn, conn.transaction():
        await conn.execute("DELETE FROM sessions")
        await conn.execute("DELETE FROM audit_events")
        await conn.execute("DELETE FROM users")
    assert (await client.get(P + "/auth/registration")).json()["first_user"] is False
    result = await signup(client, "AfterRemoval")
    assert result.status_code == 201 and result.json()["user"]["role"] == "user"


async def test_existing_cli_user_is_preserved_and_next_signup_not_promoted(settings, client):
    await create_user(settings, "ExistingOwner", PASSWORD)
    assert (await client.get(P + "/auth/registration")).json()["first_user"] is False
    result = await signup(client)
    assert result.status_code == 201 and result.json()["user"]["role"] == "user"


async def test_failed_registration_rolls_back_account_claim_session_and_audit(client, db, monkeypatch):
    async def interrupted(conn, *args, **kwargs):
        await insert_account(conn, *args, **kwargs)
        raise RuntimeError("synthetic interrupted registration")
    with monkeypatch.context() as patch:
        patch.setattr(importlib.import_module("alcor_api.registration"), "insert_account", interrupted)
        assert (await signup(client)).status_code == 503
    async with db.connection() as conn:
        for table in ("users", "sessions", "audit_events"):
            assert (await (await conn.execute("SELECT count(*) AS n FROM " + table)).fetchone())["n"] == 0
    assert (await client.get(P + "/auth/registration")).json()["first_user"] is True
    result = await signup(client)
    assert result.status_code == 201 and result.json()["user"]["role"] == "admin"


async def test_registration_rate_limit_does_not_create_account(client):
    for _ in range(6):
        assert (await signup(client, password="weak")).status_code == 400
    assert (await signup(client)).status_code == 429
    assert (await client.get(P + "/auth/registration")).json()["first_user"] is True
