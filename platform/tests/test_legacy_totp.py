"""Old Web factor lifecycle using synthetic accounts in identity-checked private PostgreSQL."""

import asyncio
import time
from contextlib import asynccontextmanager

import httpx
from alcor_api.legacy_totp import SETUP_COOKIE
from alcor_api.main import create_app
from alcor_api.native_app_auth import issue_grant
from alcor_api.native_identity import totp_code
from alcor_api.security import digest

P = "/api/auth/totp"
PASSWORD = "SyntheticWebFactor9"


@asynccontextmanager
async def browser(app):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as client:
        yield client


async def owner(client):
    result = await client.post("/api/auth/register", json={"username": "FactorOwner", "password": PASSWORD})
    assert result.status_code == 201, result.text
    return result.json()["user"]["id"]


async def stage(client):
    result = await client.post(P)
    assert result.status_code == 200, result.text
    assert set(result.json()) == {"secret", "otpauthUrl", "qrPng"}
    return result.json()


async def enable(client, setup, **fields):
    return await client.put(P, json={"code": totp_code(setup["secret"], int(time.time())), **fields})


async def test_five_method_lifecycle_uses_one_factor_service_and_revokes_other_clients(
    client, app, db, settings
):
    user = await owner(client)
    assert (await client.get(P)).json() == {"enabled": False, "name": ""}
    assert (await client.get("/api/account/totp")).status_code == 401
    setup = await stage(client)
    assert "httponly" in (await client.post(P)).headers["set-cookie"].lower()
    setup = await stage(client)
    token = client.cookies["fire_session"]
    async with db.connection() as conn:
        pending = await (
            await conn.execute("SELECT payload FROM identity_challenges WHERE purpose='totp-setup'")
        ).fetchone()
        assert setup["secret"] not in str(pending)
        source = await (await conn.execute("SELECT * FROM users WHERE id=%s", (user,))).fetchone()
        grant = await issue_grant(conn, source, "portfolio.read portfolio.write", "Synthetic peer")
        expiry = await (
            await conn.execute("SELECT expires_at FROM sessions WHERE token_hash=%s", (digest(token),))
        ).fetchone()
    async with browser(app) as peer:
        login = await peer.post("/api/session/login", json={"login": "FactorOwner", "password": PASSWORD})
        assert login.status_code == 200
        assert (await peer.get("/api/account/totp")).json()["enabled"] is False
        assert (await peer.get(P)).status_code == 401
        confirmed_code = totp_code(setup["secret"], int(time.time()))
        confirmed = await enable(client, setup, code=confirmed_code, name=" 手机验证器 ")
        assert confirmed.status_code == 200, confirmed.text
        assert set(confirmed.json()) == {"ok", "backupCodes"}
        codes = confirmed.json()["backupCodes"]
        assert len(codes) == 8 and len(set(codes)) == 8
        assert (await peer.get("/api/session")).status_code == 401
        assert (
            await peer.get("/api/v2/auth/me", headers={"authorization": "Bearer " + grant["access_token"]})
        ).status_code == 401
    assert (await client.get(P)).json() == {"enabled": True, "name": "手机验证器"}
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT expires_at FROM sessions WHERE token_hash=%s", (digest(token),))
            ).fetchone()
            == expiry
        )
        assert not await (
            await conn.execute("SELECT 1 FROM identity_challenges WHERE purpose='totp-setup'")
        ).fetchone()
    # Rebuilding the API preserves the PG factor; no Redis authority is needed.
    restarted = create_app(settings)
    async with restarted.router.lifespan_context(restarted), browser(restarted) as peer:
        peer.cookies.update(client.cookies)
        assert (await peer.get(P)).json()["enabled"] is True
    await client.post("/api/auth/logout")
    login = await client.post("/api/auth/login", json={"username": "FactorOwner", "password": PASSWORD})
    challenge = login.json()["ticket"]
    assert login.json()["requires2fa"] is True and "fire_session" not in client.cookies
    bad = await client.post(
        "/api/auth/login/totp",
        json={"ticket": challenge, "code": confirmed_code},
    )
    assert bad.status_code == 401
    good = await client.post("/api/auth/login/totp", json={"ticket": challenge, "code": codes[0]})
    assert good.status_code == 200 and "fire_session" in client.cookies
    assert (
        await client.post("/api/auth/login/totp", json={"ticket": challenge, "code": codes[0]})
    ).status_code == 401
    assert (await client.request("DELETE", P, json={"password": PASSWORD, "code": codes[1]})).json() == {
        "ok": True
    }
    assert (await client.get(P)).json() == {"enabled": False, "name": ""}
    async with db.connection() as conn:
        factor = await (
            await conn.execute("SELECT * FROM identity_security WHERE user_id=%s", (user,))
        ).fetchone()
        assert (
            not factor["totp_enabled"]
            and factor["totp_secret_ciphertext"] is None
            and factor["backup_codes"] == []
        )


async def test_older_session_needs_explicit_password_without_extending_its_lifetime(client, db):
    await owner(client)
    setup = await stage(client)
    async with db.connection() as conn:
        await conn.execute("UPDATE sessions SET created_at=clock_timestamp()-interval '16 minutes'")
        before = await (await conn.execute("SELECT created_at,expires_at FROM sessions")).fetchone()
    stale = await enable(client, setup)
    assert stale.status_code == 403 and stale.json()["requiresReauthentication"] is True
    assert (await client.get(P)).json()["enabled"] is False
    assert (await enable(client, setup, password="WrongSynthetic9")).status_code == 403
    good = await enable(client, setup, password=PASSWORD)
    assert good.status_code == 200, good.text
    async with db.connection() as conn:
        assert await (await conn.execute("SELECT created_at,expires_at FROM sessions")).fetchone() == before


async def test_setup_is_session_bound_and_replaced_or_expired_challenges_cannot_activate(client, app, db):
    await owner(client)
    original = await stage(client)
    cookie = client.cookies[SETUP_COOKIE]
    async with browser(app) as peer:
        assert (
            await peer.post("/api/auth/login", json={"username": "FactorOwner", "password": PASSWORD})
        ).status_code == 200
        peer.cookies.set(SETUP_COOKIE, cookie, domain="testserver.local", path=P)
        assert (await enable(peer, original)).status_code == 400
    replacement = await stage(client)
    assert (await enable(client, original)).status_code == 400
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE identity_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE purpose='totp-setup'"
        )
    assert (await enable(client, replacement)).status_code == 400
    assert (await client.get(P)).json()["enabled"] is False


async def test_attempt_budget_persists_and_rejects_the_correct_code_after_exhaustion(client, db):
    await owner(client)
    setup = await stage(client)
    for _ in range(8):
        assert (await client.put(P, json={"code": "invalid-code"})).status_code == 400
    assert (await enable(client, setup)).status_code == 400
    async with db.connection() as conn:
        pending = await (
            await conn.execute("SELECT attempts FROM identity_challenges WHERE purpose='totp-setup'")
        ).fetchone()
        assert pending["attempts"] == 8
    assert (await client.get(P)).json()["enabled"] is False


async def test_concurrent_confirmation_commits_only_one_factor_and_one_backup_set(client, app, db):
    await owner(client)
    setup = await stage(client)
    cookies = client.cookies
    async with browser(app) as peer:
        peer.cookies.update(cookies)
        results = await asyncio.gather(enable(client, setup), enable(peer, setup))
    assert sorted(response.status_code for response in results) == [200, 409]
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM audit_events WHERE action='identity.totp.enabled'"
                )
            ).fetchone()
        )["n"] == 1
        row = await (await conn.execute("SELECT backup_codes FROM identity_security")).fetchone()
        assert len(row["backup_codes"]) == 8


async def test_failed_confirmation_rolls_back_activation_session_revocation_and_audit(
    client, app, db, monkeypatch
):
    await owner(client)
    setup = await stage(client)

    async def interrupted(*args):
        raise RuntimeError("Synthetic interrupted factor transaction")

    with monkeypatch.context() as patch:
        patch.setattr(app.state.identity_management, "invalidate_others", interrupted)
        assert (await enable(client, setup)).status_code == 503
    assert (await client.get(P)).json()["enabled"] is False
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM audit_events WHERE action='identity.totp.enabled'")
        ).fetchone()
        pending = await (
            await conn.execute("SELECT attempts FROM identity_challenges WHERE purpose='totp-setup'")
        ).fetchone()
        assert pending["attempts"] == 0
    assert (await enable(client, setup)).status_code == 200


async def test_owner_origin_and_input_boundaries_do_not_create_factors_for_another_user(client, db):
    assert (await client.get(P)).status_code == 401
    await owner(client)
    assert (await client.post(P, headers={"origin": "https://foreign.invalid"})).status_code == 403
    assert (await client.get(P, headers={"authorization": "Bearer synthetic-token"})).status_code == 403
    setup = await stage(client)
    for invalid in (
        {"code": "123456", "user_id": "someone-else"},
        {"code": "123456", "name": "bad\nname"},
        {"code": None},
    ):
        assert (await client.put(P, json=invalid)).status_code == 400
    assert (await enable(client, setup)).status_code == 200
    assert (
        await client.request("DELETE", P, json={"password": "WrongSynthetic9", "code": "123456"})
    ).status_code == 400
    assert (await client.get(P)).json()["enabled"] is True


async def test_revoked_session_between_http_check_and_mutation_cannot_stage_a_factor(
    client, app, db, monkeypatch
):
    user = await owner(client)
    original = app.state.identity_management.serialize

    async def revoke_then_lock(conn, who):
        async with db.connection() as other:
            await other.execute("DELETE FROM sessions WHERE user_id=%s", (user,))
        await original(conn, who)

    monkeypatch.setattr(app.state.identity_management, "serialize", revoke_then_lock)
    assert (await client.post(P)).status_code == 401
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM identity_challenges WHERE purpose='totp-setup'")
        ).fetchone()


async def test_factor_login_waits_for_user_before_locking_a_challenge_that_management_may_revoke(
    client, app, db
):
    user = await owner(client)
    setup = await stage(client)
    enabled = await enable(client, setup)
    codes = enabled.json()["backupCodes"]
    async with browser(app) as peer:
        pending = await peer.post("/api/auth/login", json={"username": "FactorOwner", "password": PASSWORD})
        ticket = pending.json()["ticket"]
        async with db.connection() as holder:
            async with holder.transaction():
                await holder.execute("SELECT id FROM users WHERE id=%s FOR UPDATE", (user,))
                operation = asyncio.create_task(
                    peer.post("/api/auth/login/totp", json={"ticket": ticket, "code": codes[0]})
                )
                # Wait for the real HTTP login transaction to block on the held user row.
                async with db.connection() as monitor:
                    async with asyncio.timeout(3):
                        while not await (
                            await monitor.execute(
                                "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM users WHERE id=%%FOR UPDATE'"
                            )
                        ).fetchone():
                            await asyncio.sleep(0.01)
                    # Management must still be able to lock/remove this challenge without a cycle.
                    async with monitor.transaction():
                        await monitor.execute(
                            "SELECT id FROM identity_challenges WHERE id=%s FOR UPDATE NOWAIT",
                            (digest(ticket),),
                        )
                        await monitor.execute(
                            "DELETE FROM identity_challenges WHERE id=%s", (digest(ticket),)
                        )
            result = await asyncio.wait_for(operation, 3)
        assert result.status_code == 401
    async with db.connection() as conn:
        remaining = await (
            await conn.execute("SELECT backup_codes FROM identity_security WHERE user_id=%s", (user,))
        ).fetchone()
        assert len(remaining["backup_codes"]) == 8


async def test_new_web_cannot_request_legacy_staging_or_bypass_its_password_policy(client, admin):
    assert (
        await client.post("/api/auth/totp/setup", json={"password": "WrongSynthetic9"})
    ).status_code == 403
    assert (
        await client.post("/api/auth/totp/setup", json={"password": PASSWORD, "stage_only": True})
    ).status_code == 422
    assert (await client.get("/api/account/totp")).json()["enabled"] is False
    assert (await client.post(P)).status_code == 401


async def test_second_batch_register_has_five_implemented_adapters_and_no_cutover_claim(client, admin, app):
    data = (await client.get("/api/system/migration")).json()
    batch = [op for op in data["operations"] if op.get("verification", {}).get("version") == "0.1.48"]
    assert {(op["method"], op["path"]) for op in batch} == {
        ("POST", "/api/auth/login/totp"),
        ("GET", P),
        ("POST", P),
        ("PUT", P),
        ("DELETE", P),
    }
    for op in batch:
        assert not op["accepted"] and op["client_ui"]["legacy_web"] == "pending_integration"
        assert op["method"].lower() in app.openapi()["paths"][op["target"]]
    assert data["summary"]["local_verified_operations"] == sum(op["status"] == "local_verified" for op in data["operations"])
    assert data["capability_plan"]["summary"]["client_integrations_accepted"] == 0
