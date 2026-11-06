"""Password compatibility against isolated PostgreSQL, never a live account."""

import asyncio
import json
import time

import httpx
import pytest
from alcor_api.main import create_app
from alcor_api.native_app_auth import issue_grant
from alcor_api.native_identity import totp_code
from alcor_api.security import digest

PATH = "/api/auth/password"
OLD = "SyntheticOldPassword9"
NEW = "SyntheticNewPassword7"


def browser(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    )


async def register(client):
    result = await client.post("/api/auth/register", json={"username": "PasswordOwner", "password": OLD})
    assert result.status_code == 201, result.text
    return result.json()["user"]["id"]


@pytest.mark.parametrize("preserve", [False, True])
async def test_password_session_policy_and_durable_revocation(client, app, db, settings, preserve):
    uid = await register(client)
    token = client.cookies["fire_session"]
    async with browser(app) as peer:
        assert (
            await peer.post("/api/auth/login", json={"username": "PasswordOwner", "password": OLD})
        ).status_code == 200
        async with db.connection() as conn:
            user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
            grant = await issue_grant(conn, user, "portfolio.read", "Synthetic device")
            before = await (
                await conn.execute(
                    "SELECT created_at,expires_at FROM sessions WHERE token_hash=%s", (digest(token),)
                )
            ).fetchone()
        response = await client.post(
            PATH, json={"oldPassword": OLD, "newPassword": NEW, "signOutOthers": not preserve}
        )
        assert response.status_code == 200, response.text
        assert response.json() == {"ok": True, "signedOutOthers": not preserve}
        assert response.headers["cache-control"] == "no-store"
        assert client.cookies["fire_session"] == token
        assert (await client.get("/api/auth/me")).status_code == 200
        assert (await peer.get("/api/auth/me")).status_code == (200 if preserve else 401)
        assert (
            await peer.get("/api/v2/auth/me", headers={"authorization": "Bearer " + grant["access_token"]})
        ).status_code == 401
        async with db.connection() as conn:
            assert (
                await (
                    await conn.execute(
                        "SELECT created_at,expires_at FROM sessions WHERE token_hash=%s", (digest(token),)
                    )
                ).fetchone()
                == before
            )
            assert (
                await (
                    await conn.execute(
                        "SELECT count(*) AS n FROM audit_events WHERE actor_id=%s AND action='account.password.changed'",
                        (uid,),
                    )
                ).fetchone()
            )["n"] == 1
        restarted = create_app(settings)
        async with restarted.router.lifespan_context(restarted), browser(restarted) as fresh:
            assert (
                await fresh.post("/api/auth/login", json={"username": "PasswordOwner", "password": OLD})
            ).status_code == 401
            assert (
                await fresh.post("/api/auth/login", json={"username": "PasswordOwner", "password": NEW})
            ).status_code == 200


@pytest.mark.parametrize(
    "payload",
    [
        {"oldPassword": OLD, "newPassword": NEW, "signOutOthers": "false"},
        {"oldPassword": OLD, "newPassword": NEW, "code": 42},
        {"oldPassword": OLD, "newPassword": NEW, "code": "a" * 65},
        {"oldPassword": OLD, "newPassword": "short"},
        {"oldPassword": "wrong", "newPassword": NEW},
        {"oldPassword": OLD, "newPassword": NEW, "role": "admin"},
        {"oldPassword": OLD, "newPassword": "\ud800"},
    ],
)
async def test_rejected_input_does_not_mutate_credentials(client, db, payload):
    uid = await register(client)
    async with db.connection() as conn:
        before = await (
            await conn.execute("SELECT password_hash,session_version,revision FROM users WHERE id=%s", (uid,))
        ).fetchone()
    response = await client.post(
        PATH, content=json.dumps(payload), headers={"content-type": "application/json"}
    )
    assert response.status_code == 400, response.text
    assert isinstance(response.json()["error"], str)
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT password_hash,session_version,revision FROM users WHERE id=%s", (uid,)
                )
            ).fetchone()
            == before
        )


async def test_origin_and_client_sessions_are_not_interchangeable(client, app):
    await register(client)
    payload = {"oldPassword": OLD, "newPassword": NEW}
    assert (
        await client.post(PATH, json=payload, headers={"origin": "https://untrusted.invalid"})
    ).status_code == 403
    assert (
        await client.post(
            PATH, json=payload, headers={"authorization": "Bearer " + client.cookies["fire_session"]}
        )
    ).status_code == 403
    async with browser(app) as other:
        login = await other.post("/api/session/login", json={"login": "PasswordOwner", "password": OLD})
        assert login.status_code == 200
        assert (
            await other.post(PATH, json=payload, headers={"x-csrf-token": login.json()["csrf"]})
        ).status_code == 401


async def test_factor_consumption_and_password_change_rollback_together(client, db):
    await register(client)
    setup = (await client.post("/api/auth/totp")).json()
    enabled = await client.put("/api/auth/totp", json={"code": totp_code(setup["secret"], int(time.time()))})
    assert enabled.status_code == 200
    backup = enabled.json()["backupCodes"][0]
    assert (await client.post(PATH, json={"oldPassword": OLD, "newPassword": NEW})).status_code == 400
    # A synthetic database failure occurs after factor consumption; the full
    # transaction must restore the proof and all credential/session state.
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_password_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='account.password.changed' THEN RAISE EXCEPTION 'synthetic fault'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_password_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_password_audit()"
        )
    payload = {"oldPassword": OLD, "newPassword": NEW, "code": backup}
    assert (await client.post(PATH, json=payload)).status_code == 503
    async with db.connection() as conn:
        await conn.execute("DROP TRIGGER reject_password_audit ON audit_events")
    assert (await client.post(PATH, json=payload)).status_code == 200
    assert (
        await client.post(PATH, json={"oldPassword": NEW, "newPassword": OLD, "code": backup})
    ).status_code == 400


async def test_password_waits_for_identity_lock_before_user_lock(client, db):
    uid = await register(client)
    async with db.connection() as held, held.transaction():
        await held.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + uid,)
        )
        task = asyncio.create_task(client.post(PATH, json={"oldPassword": OLD, "newPassword": NEW}))
        try:
            for _ in range(100):
                async with db.connection() as inspect:
                    row = await (
                        await inspect.execute(
                            "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid()"
                        )
                    ).fetchone()
                if row["n"]:
                    break
                await asyncio.sleep(0.02)
            assert row["n"]
            # Would fail if the waiter already held SHARE and intended to upgrade.
            await held.execute("SELECT id FROM users WHERE id=%s FOR UPDATE NOWAIT", (uid,))
        except BaseException:
            task.cancel()
            raise
    assert (await asyncio.wait_for(task, 5)).status_code == 200


async def test_password_account_budget_shared_with_new_web(client, db):
    uid = await register(client)
    for _ in range(10):
        assert (
            await client.post(PATH, json={"oldPassword": "incorrect", "newPassword": NEW})
        ).status_code == 400
    assert (await client.post(PATH, json={"oldPassword": OLD, "newPassword": NEW})).status_code == 429
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT session_version FROM users WHERE id=%s", (uid,))).fetchone()
    assert row["session_version"] == 1


@pytest.mark.parametrize("version", [1, 2])
async def test_native_password_contract_revokes_every_session_and_grant(client, db, version):
    uid = await register(client)
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
        grant = await issue_grant(conn, user, "portfolio.read", "Synthetic phone")
    headers = {"authorization": "Bearer " + grant["access_token"]}
    path = f"/api/v{version}/auth/password"
    rejected = await client.post(path, headers=headers, json={"currentPassword": "wrong", "newPassword": NEW})
    assert rejected.status_code == 403 and rejected.json()["code"] == 40103
    result = await client.post(path, headers=headers, json={"currentPassword": OLD, "newPassword": NEW})
    assert result.status_code == 200, result.text
    assert result.headers["x-alcor-api-version"] == str(version)
    assert set(result.json()) == {"code", "message", "data"}
    payload = result.json()["data"]
    assert payload["ok"] and payload["signedOutOthers"] and payload["reauthenticationRequired"]
    assert set(payload["user"]) == {
        "id",
        "username",
        "nickname",
        "uid",
        "email",
        "emailVerified",
        "avatar",
        "role",
        "isTest",
    }
    assert payload["user"]["role"] == "user"  # No admin capability leaks to App.
    assert (await client.get("/api/auth/me")).status_code == 401
    assert (await client.get(f"/api/v{version}/auth/me", headers=headers)).status_code == 401
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM sessions WHERE user_id=%s", (uid,))).fetchone()
        assert not await (
            await conn.execute(
                "SELECT 1 FROM identity_app_grants WHERE user_id=%s AND revoked_at IS NULL", (uid,)
            )
        ).fetchone()


async def test_native_v1_cookie_fallback_and_v2_cookie_rejection(client):
    await register(client)
    payload = {"currentPassword": OLD, "newPassword": NEW}
    assert (await client.post("/api/v2/auth/password", json=payload)).status_code == 401
    result = await client.post("/api/v1/auth/password", json=payload)
    assert result.status_code == 200, result.text
    assert result.json()["data"]["user"]["role"] == "admin"
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_native_factor_error_preserves_grant_and_requires_one_time_factor(client, db):
    uid = await register(client)
    setup = (await client.post("/api/auth/totp")).json()
    confirmed = await client.put(
        "/api/auth/totp", json={"code": totp_code(setup["secret"], int(time.time()))}
    )
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
        grant = await issue_grant(conn, user, "portfolio.read", "Synthetic phone")
    headers = {"authorization": "Bearer " + grant["access_token"]}
    payload = {"currentPassword": OLD, "newPassword": NEW}
    result = await client.post("/api/v2/auth/password", headers=headers, json=payload)
    assert result.status_code == 403 and result.json()["code"] == 40104
    assert (await client.get("/api/v2/auth/me", headers=headers)).status_code == 200
    result = await client.post(
        "/api/v2/auth/password", headers=headers, json={**payload, "code": confirmed.json()["backupCodes"][0]}
    )
    assert result.status_code == 200, result.text
