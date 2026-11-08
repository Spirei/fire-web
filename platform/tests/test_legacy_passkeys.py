"""Legacy Web contracts using real cryptographic vectors in private, identity-checked PG."""

import asyncio
import base64
import hashlib
import json
import struct
import time
from contextlib import asynccontextmanager

import cbor2
import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from psycopg.conninfo import conninfo_to_dict

from alcor_api.identity_import import import_trial_snapshot
from alcor_api.identity_passkeys import b64
from alcor_api.legacy_passkeys import CHALLENGE_COOKIE, CLIENT_COOKIE
from alcor_api.main import create_app
from alcor_api.native_identity import backup_hash, totp_code
from alcor_api.security import digest
from test_identity_import import snapshot
from test_identity_passkeys import assertion

P = "/api/auth/passkeys"
ORIGIN = "https://legacy.example.test"
KEY_ID = "c291cmNlLWNyZWRlbnRpYWw"
PASSWORD = "SyntheticSource9"
BACKUPS = ["ABCD-1234-5678-90EF", "ABCD-1234-5678-90AA", "ABCD-1234-5678-90BB"]


@asynccontextmanager
async def browser(app):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url=ORIGIN, headers={"origin": ORIGIN},
    ) as client:
        yield client


async def prepare(db, settings, *, factor=True):
    data, private = snapshot()
    if factor:
        key = hashlib.sha256(b"SyntheticIdentityKey9").digest()
        data["users"][0]["totp_backup_codes"] = [backup_hash(code, key) for code in BACKUPS]
    else:
        data["users"][0].update(
            totp_enabled=False, totp_secret="", totp_last_step=-1, totp_backup_codes=[]
        )
    await import_trial_snapshot(
        db, data, source_key=b"SyntheticIdentityKey9",
        expected_database=conninfo_to_dict(settings.database_url.get_secret_value())["dbname"],
    )
    settings.public_origin = ORIGIN
    return data, private


async def options(client):
    result = await client.post(P, json={"action": "login-options"})
    assert result.status_code == 200, result.text
    assert set(result.json()) == {"options", "requestId"}
    return result.json()


def login_body(issued, private, *, counter=8, **changes):
    return {
        "action": "login-verify", "requestId": issued["requestId"],
        "response": assertion(issued["options"], private, counter=counter, **changes),
    }


async def login(client, private, *, counter=8):
    issued = await options(client)
    response = await client.post(P, json=login_body(issued, private, counter=counter))
    assert response.status_code == 200 and response.json() == {"ok": True}, response.text
    assert "fire_session" in client.cookies and "alcor_session" not in client.cookies
    return response


def registration(issued, credential_id=b"synthetic-added-credential"):
    private = ec.generate_private_key(ec.SECP256R1())
    point = private.public_key().public_numbers()
    public = cbor2.dumps(
        {1: 2, 3: -7, -1: 1, -2: point.x.to_bytes(32, "big"), -3: point.y.to_bytes(32, "big")}
    )
    auth = (
        hashlib.sha256(b"legacy.example.test").digest() + bytes([0x45])
        + struct.pack(">I", 0) + bytes(16) + struct.pack(">H", len(credential_id))
        + credential_id + public
    )
    client_data = json.dumps(
        {"type": "webauthn.create", "challenge": issued["options"]["challenge"],
         "origin": ORIGIN, "crossOrigin": False}, separators=(",", ":"),
    ).encode()
    return {
        "id": b64(credential_id), "rawId": b64(credential_id), "type": "public-key",
        "clientExtensionResults": {"credProps": {"rk": True}},
        "response": {
            "attestationObject": b64(cbor2.dumps({"fmt": "none", "attStmt": {}, "authData": auth})),
            "clientDataJSON": b64(client_data), "transports": ["internal"],
        },
    }


async def register_options(client, *, factor=False):
    body = {"action": "register-options", "password": PASSWORD}
    if factor:
        body["code"] = totp_code("JBSWY3DPEHPK3PXP", int(time.time()))
    result = await client.post(P, json=body)
    assert result.status_code == 200, result.text
    return result.json()


async def test_six_legacy_methods_share_pg_lifecycle_and_keep_old_response_and_session_contracts(
    db, settings, app
):
    _, private = await prepare(db, settings)
    async with browser(app) as client:
        initial = (await client.get(P + "/config")).json()
        assert set(initial) == {"enabled", "origin", "name", "revision"}
        assert (await client.get(P)).status_code == 401
        issued = await options(client)
        headers = (await client.post(P, json={"action": "login-options"})).headers.get_list("set-cookie")
        challenge_cookie = next(value for value in headers if value.startswith(CHALLENGE_COOKIE + "="))
        assert "HttpOnly" in challenge_cookie and "Secure" in challenge_cookie
        assert "SameSite=strict" in challenge_cookie and "Path=/api/auth/passkeys" in challenge_cookie
        # New login options supersede the preceding request even if its nonce is retained.
        assert (await client.post(P, json=login_body(issued, private))).status_code == 400
        await login(client, private)
        listing = (await client.get(P)).json()
        assert listing["totpEnabled"] is True and len(listing["keys"]) == 1
        assert set(listing["keys"][0]) == {"id", "name", "rpID", "createdAt", "lastUsedAt", "backedUp"}
        assert (await client.get("/api/account/passkeys")).status_code == 401
        pending = await register_options(client, factor=True)
        assert pending["options"]["user"]["id"] == "c291cmNlLWhhbmRsZQ"
        credential = registration(pending)
        verified = await client.post(P, json={
            "action": "register-verify", "requestId": pending["requestId"],
            "response": credential, "name": " Added device ",
        })
        assert verified.status_code == 200 and verified.json() == {"ok": True}
        assert (await client.post(P, json={
            "action": "register-verify", "requestId": pending["requestId"], "response": credential,
        })).status_code == 400
        renamed = await client.patch(P, json={"id": credential["id"], "name": " Renamed device "})
        assert renamed.status_code == 200 and renamed.json() == {"ok": True, "signedOut": False}
        # This is the actual old frontend spread shape, including its informational revision field.
        configured = await client.put(P + "/config", json={
            **initial, "name": "Updated platform", "expectedRevision": initial["revision"],
            "currentPassword": PASSWORD, "code": BACKUPS[0],
        })
        assert configured.status_code == 200, configured.text
        assert set(configured.json()) == set(initial)
        assert configured.json()["revision"] != initial["revision"]
        restarted = create_app(settings)
        async with restarted.router.lifespan_context(restarted), browser(restarted) as peer:
            peer.cookies.update(client.cookies)
            assert (await peer.get(P + "/config")).json() == configured.json()
            keys = (await peer.get(P)).json()["keys"]
            assert any(k["id"] == credential["id"] and k["name"] == "Renamed device" for k in keys)
        removed = await client.request("DELETE", P, json={
            "id": KEY_ID, "password": PASSWORD, "code": BACKUPS[1],
        })
        assert removed.status_code == 200 and removed.json() == {"ok": True, "signedOut": True}
        assert (await client.get(P)).status_code == 401
    async with db.connection() as conn:
        keys = await (await conn.execute("SELECT id,name,user_handle FROM identity_passkeys")).fetchall()
        assert keys == [{"id": credential["id"], "name": "Renamed device", "user_handle": "c291cmNlLWhhbmRsZQ"}]


async def test_old_and_new_web_challenges_and_cookies_cannot_be_exchanged(db, settings, app):
    _, private = await prepare(db, settings, factor=False)
    async with browser(app) as old, browser(app) as new:
        issued = await options(old)
        new.cookies.set("alcor_passkey_challenge", old.cookies[CHALLENGE_COOKIE], domain="legacy.example.test", path="/")
        rejected = await new.post("/api/session/passkeys", json=login_body(issued, private))
        assert rejected.status_code == 403
        # A rejected cross-protocol attempt must not consume the real old-Web challenge.
        assert (await old.post(P, json=login_body(issued, private))).status_code == 200
        new_options = (await new.post("/api/session/passkeys", json={"action": "login-options"})).json()
        signed_in = await new.post("/api/session/passkeys", json=login_body(new_options, private, counter=9))
        assert signed_in.status_code == 200 and "csrf" in signed_in.json()
        assert (await new.get(P)).status_code == 401
        assert (await new.post(P, json={"action": "register-options", "password": PASSWORD})).status_code == 401
        assert (await new.patch(P, json={"id": KEY_ID, "name": "Crossed"})).status_code == 401
        assert (await new.get("/api/account/passkeys")).status_code == 200
        assert (await old.get(P, headers={"authorization": "Bearer synthetic-token"})).status_code == 403


async def test_latest_login_options_are_browser_bound_and_rejection_consumes_only_its_challenge(
    db, settings, app
):
    _, private = await prepare(db, settings, factor=False)
    async with browser(app) as owner, browser(app) as peer:
        issued = await options(owner)
        assert (await peer.post(P, json=login_body(issued, private))).status_code == 400
        replacement = await options(owner)
        assert (await owner.post(P, json=login_body(issued, private))).status_code == 400
        assert (await owner.post(P, json=login_body(replacement, private))).status_code == 200
        assert (await owner.post(P, json=login_body(replacement, private))).status_code == 400


@pytest.mark.parametrize("change", [
    {"origin": "https://foreign.example.test"}, {"rp": "foreign.example.test"},
    {"uv": False}, {"handle": "b3RoZXItdXNlcg"}, {"signature": "invalid"}, {"cross_origin": True},
])
async def test_legacy_assertion_rejects_invalid_origin_rp_uv_owner_signature_and_embedding(
    db, settings, app, change
):
    _, private = await prepare(db, settings, factor=False)
    async with browser(app) as client:
        issued = await options(client)
        kwargs = {key: value for key, value in change.items() if key not in {"signature", "cross_origin"}}
        body = login_body(issued, private, **kwargs)
        if "signature" in change:
            body["response"]["response"]["signature"] = "aW52YWxpZA"
        if "cross_origin" in change:
            raw = json.loads(base64.urlsafe_b64decode(body["response"]["response"]["clientDataJSON"] + "=="))
            raw["crossOrigin"] = True
            body["response"]["response"]["clientDataJSON"] = b64(json.dumps(raw).encode())
        bad = await client.post(P, json=body)
        assert bad.status_code == 400 and set(bad.json()) == {"error"}
        assert (await client.post(P, json=login_body(issued, private))).status_code == 400
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT counter FROM identity_passkeys")).fetchone())["counter"] == 7
        assert not await (await conn.execute("SELECT 1 FROM sessions")).fetchone()


@pytest.mark.parametrize("change", ["session", "expired", "password", "config"])
async def test_registration_checks_session_password_config_and_expiry_before_creating_a_key(
    db, settings, app, change
):
    _, private = await prepare(db, settings, factor=False)
    async with browser(app) as owner, browser(app) as peer:
        await login(owner, private)
        issued = await register_options(owner)
        claimant = owner
        if change == "session":
            await login(peer, private, counter=9)
            peer.cookies.set(CHALLENGE_COOKIE, owner.cookies[CHALLENGE_COOKIE], domain="legacy.example.test", path=P)
            claimant = peer
        else:
            async with db.connection() as conn:
                if change == "expired":
                    await conn.execute("UPDATE identity_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE id=%s", (digest(issued["requestId"]),))
                elif change == "password":
                    await conn.execute("UPDATE users SET password_hash=password_hash || 'changed' WHERE id='source-user-001'")
                else:
                    await conn.execute("UPDATE identity_passkey_config SET revision='changed-config'")
        result = await claimant.post(P, json={
            "action": "register-verify", "requestId": issued["requestId"], "response": registration(issued),
        })
        assert result.status_code == 400, result.text
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM identity_passkeys")).fetchone())["n"] == 1


async def test_config_cas_optional_revision_and_noop_preserve_existing_challenges(db, settings, app):
    _, private = await prepare(db, settings, factor=False)
    async with browser(app) as admin, browser(app) as anonymous:
        await login(admin, private)
        current = (await admin.get(P + "/config")).json()
        issued = await options(anonymous)
        wrong = await admin.put(P + "/config", json={
            **current, "name": "Different", "expectedRevision": "stale", "currentPassword": PASSWORD,
        })
        assert wrong.status_code == 409
        bad_password = await admin.put(P + "/config", json={**current, "currentPassword": "WrongSynthetic9"})
        assert bad_password.status_code == 403
        unchanged = await admin.put(P + "/config", json={**current, "currentPassword": PASSWORD})
        assert unchanged.status_code == 200 and unchanged.json() == current
        assert (await anonymous.post(P, json=login_body(issued, private, counter=9))).status_code == 200
        updated = await admin.put(P + "/config", json={**current, "name": "No CAS legacy request", "currentPassword": PASSWORD})
        assert updated.status_code == 200 and updated.json()["revision"] != current["revision"]
        assert (await admin.put(P + "/config", json={**current, "expectedRevision": None, "currentPassword": PASSWORD})).status_code == 400


async def test_config_change_invalidates_old_options_and_disabled_config_cannot_issue_new_challenge(
    db, settings, app
):
    _, private = await prepare(db, settings, factor=False)
    async with browser(app) as admin, browser(app) as anonymous:
        await login(admin, private)
        issued = await options(anonymous)
        current = (await admin.get(P + "/config")).json()
        changed = await admin.put(P + "/config", json={**current, "enabled": False, "currentPassword": PASSWORD})
        assert changed.status_code == 200
        assert (await anonymous.post(P, json=login_body(issued, private, counter=9))).status_code == 400
        assert (await anonymous.post(P, json={"action": "login-options"})).status_code == 400
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM identity_challenges WHERE id=%s", (digest(issued["requestId"]),))).fetchone()


async def test_config_origin_validation_preserves_explicit_ports_and_failed_changes_keep_challenges(
    db, settings, app
):
    _, private = await prepare(db, settings, factor=False)
    async with browser(app) as admin, browser(app) as anonymous:
        await login(admin, private)
        initial = (await admin.get(P + "/config")).json()
        issued = await options(anonymous)
        invalid = [
            (True, ORIGIN + ":0"),
            (False, "https://bad host"),
            (False, "https://bad\thost"),
            (False, ORIGIN + "\\extra"),
            (False, "https://bad[host"),
            (False, "https://bad^host"),
            (False, "https://bad\x00host"),
        ]
        for enabled, origin in invalid:
            result = await admin.put(P + "/config", json={
                **initial, "enabled": enabled, "origin": origin,
                "expectedRevision": initial["revision"], "currentPassword": PASSWORD,
            })
            assert result.status_code == 400, (origin, result.status_code)
            assert (await admin.get(P + "/config")).json() == initial
            async with db.connection() as conn:
                assert await (await conn.execute(
                    "SELECT 1 FROM identity_challenges WHERE id=%s", (digest(issued["requestId"]),),
                )).fetchone()
        # URL-equivalent spelling is a no-op, including default port and terminal slash.
        normalized = await admin.put(P + "/config", json={
            **initial, "origin": "HTTPS://LEGACY.EXAMPLE.TEST:443/",
            "expectedRevision": initial["revision"], "currentPassword": PASSWORD,
        })
        assert normalized.status_code == 200 and normalized.json() == initial
        async with db.connection() as conn:
            assert await (await conn.execute(
                "SELECT 1 FROM identity_challenges WHERE id=%s", (digest(issued["requestId"]),),
            )).fetchone()
        # Disabled configuration may retain a legal explicit zero port; it must not
        # silently become the live default-port origin.
        disabled = await admin.put(P + "/config", json={
            **initial, "enabled": False, "origin": ORIGIN + ":0",
            "expectedRevision": initial["revision"], "currentPassword": PASSWORD,
        })
        assert disabled.status_code == 200, disabled.text
        assert disabled.json()["origin"] == ORIGIN + ":0" and not disabled.json()["enabled"]
        assert disabled.json()["revision"] != initial["revision"]
        assert (await admin.get(P + "/config")).json() == disabled.json()
        async with db.connection() as conn:
            assert not await (await conn.execute(
                "SELECT 1 FROM identity_challenges WHERE id=%s", (digest(issued["requestId"]),),
            )).fetchone()


async def test_ordinary_user_cannot_read_modify_or_remove_another_users_key_or_config(db, settings, app):
    _, private = await prepare(db, settings, factor=False)
    async with browser(app) as ordinary:
        created = await ordinary.post("/api/auth/register", json={"username": "OtherUser", "password": "OtherSynthetic9Pass"})
        assert created.status_code == 201
        assert (await ordinary.get(P)).json() == {"keys": [], "totpEnabled": False}
        assert (await ordinary.patch(P, json={"id": KEY_ID, "name": "Wrong owner"})).status_code == 404
        assert (await ordinary.request("DELETE", P, json={"id": KEY_ID, "password": "OtherSynthetic9Pass"})).status_code == 404
        current = (await ordinary.get(P + "/config")).json()
        assert (await ordinary.put(P + "/config", json={**current, "name": "Not allowed", "currentPassword": "OtherSynthetic9Pass"})).status_code == 403
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT name FROM identity_passkeys WHERE id=%s", (KEY_ID,))).fetchone())["name"] == "Source key"


async def test_input_and_origin_failures_do_not_change_keys_or_expose_provider_errors(db, settings, app):
    _, private = await prepare(db, settings, factor=False)
    async with browser(app) as client:
        assert (await client.post(P, json={"action": "login-options"}, headers={"origin": "https://foreign.invalid"})).status_code == 403
        for data in ({"action": []}, {"action": "unknown"}, {"action": "login-verify", "response": []}, {"action": "login-options", "user_id": "someone-else"}):
            result = await client.post(P, json=data)
            assert result.status_code == 400 and set(result.json()) == {"error"}
        oversized = await client.post(P, json={"action": "login-verify", "response": {"padding": "x" * 32768}})
        assert oversized.status_code == 400
        await login(client, private)
        for name in ("", "bad\nlabel", "x" * 65):
            assert (await client.patch(P, json={"id": KEY_ID, "name": name})).status_code == 403
        assert (await client.request("DELETE", P, json={"id": KEY_ID, "password": "WrongSynthetic9"})).status_code == 403
        current = (await client.get(P + "/config")).json()
        for origin in ("https://foreign.invalid", "http://127.0.0.1", ORIGIN + "/path", ORIGIN + "?secret=synthetic"):
            result = await client.put(P + "/config", json={**current, "origin": origin, "currentPassword": PASSWORD})
            assert result.status_code == 400
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM identity_passkeys")).fetchone())["n"] == 1


async def test_anonymous_options_budget_is_persistent_per_browser_and_not_a_user_bucket(db, settings, app):
    await prepare(db, settings, factor=False)
    async with browser(app) as one, browser(app) as two:
        first = await options(one)
        token = one.cookies[CLIENT_COOKIE]
        for _ in range(29):
            await options(one)
        denied = await one.post(P, json={"action": "login-options"})
        assert denied.status_code == 429
        assert (await two.post(P, json={"action": "login-options"})).status_code == 200
        assert two.cookies[CLIENT_COOKIE] != token
        restarted = create_app(settings)
        async with restarted.router.lifespan_context(restarted), browser(restarted) as peer:
            peer.cookies.update(one.cookies)
            assert (await peer.post(P, json={"action": "login-options"})).status_code == 429
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM auth_rate_limits WHERE bucket=%s", (digest("identity-manage:source-user-001"),))).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM identity_challenges WHERE id=%s", (digest(first["requestId"]),))).fetchone()


async def test_anonymous_ip_budget_resets_after_one_minute_and_ignores_untrusted_forwarding_headers(
    db, settings, app
):
    await prepare(db, settings, factor=False)
    async with browser(app) as client:
        await options(client)
        bucket = digest("legacy-passkey-ip:127.0.0.1")
        async with db.connection() as conn:
            await conn.execute("UPDATE auth_rate_limits SET attempts=100,window_start=clock_timestamp()-interval '61 seconds' WHERE bucket=%s", (bucket,))
        assert (await client.post(P, json={"action": "login-options"})).status_code == 200
        async with db.connection() as conn:
            await conn.execute("UPDATE auth_rate_limits SET attempts=100,window_start=clock_timestamp() WHERE bucket=%s", (bucket,))
        denied = await client.post(P, json={"action": "login-options"}, headers={"x-forwarded-for": "203.0.113.25"})
        assert denied.status_code == 429


async def test_registration_rechecks_twenty_key_limit_after_options_and_rolls_back_new_credential(
    db, settings, app
):
    _, private = await prepare(db, settings, factor=False)
    async with browser(app) as client:
        await login(client, private)
        async with db.connection() as conn:
            for number in range(18):
                await conn.execute(
                    "INSERT INTO identity_passkeys(id,user_id,user_handle,rp_id,public_key,counter,transports,name,backed_up) SELECT %s,user_id,user_handle,rp_id,public_key,counter,transports,name,backed_up FROM identity_passkeys WHERE id=%s",
                    (b64(("existing-key-" + str(number)).encode()), KEY_ID),
                )
        issued = await register_options(client)
        credential = registration(issued)
        async with db.connection() as conn:
            await conn.execute(
                "INSERT INTO identity_passkeys(id,user_id,user_handle,rp_id,public_key,counter,transports,name,backed_up) SELECT %s,user_id,user_handle,rp_id,public_key,counter,transports,name,backed_up FROM identity_passkeys WHERE id=%s",
                (b64(b"racing-twentieth-key"), KEY_ID),
            )
        verified = await client.post(P, json={"action": "register-verify", "requestId": issued["requestId"], "response": credential})
        assert verified.status_code == 400
        assert (await client.post(P, json={"action": "register-options", "password": PASSWORD})).status_code == 400
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM identity_passkeys")).fetchone())["n"] == 20
        assert not await (await conn.execute("SELECT 1 FROM identity_passkeys WHERE id=%s", (credential["id"],))).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM identity_challenges WHERE id=%s", (digest(issued["requestId"]),))).fetchone()


async def test_concurrent_assertion_accepts_only_once_and_counter_is_committed_once(db, settings, app):
    _, private = await prepare(db, settings, factor=False)
    async with browser(app) as one, browser(app) as two:
        issued = await options(one)
        two.cookies.update(one.cookies)
        body = login_body(issued, private)
        result = await asyncio.gather(one.post(P, json=body), two.post(P, json=body))
        assert sorted(value.status_code for value in result) == [200, 400]
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT counter FROM identity_passkeys")).fetchone())["counter"] == 8
        assert (await (await conn.execute("SELECT count(*) AS n FROM sessions")).fetchone())["n"] == 1


async def test_login_locks_owner_before_key_and_rejects_revoked_owner_without_deadlock(
    db, settings, app
):
    _, private = await prepare(db, settings, factor=False)
    async with browser(app) as client, db.connection() as holder:
        issued = await options(client)
        async with holder.transaction():
            await holder.execute("SELECT id FROM users WHERE id='source-user-001' FOR UPDATE")
            operation = asyncio.create_task(client.post(P, json=login_body(issued, private)))
            async with db.connection() as monitor:
                async with asyncio.timeout(3):
                    while not await (await monitor.execute(
                        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%%FROM users WHERE id=%%FOR UPDATE'"
                    )).fetchone():
                        await asyncio.sleep(.01)
                async with monitor.transaction():
                    await monitor.execute("SELECT id FROM identity_passkeys WHERE id=%s FOR UPDATE NOWAIT", (KEY_ID,))
                await holder.execute("UPDATE users SET active=false WHERE id='source-user-001'")
        rejected = await asyncio.wait_for(operation, 3)
        assert rejected.status_code == 400
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM sessions")).fetchone()


async def test_registry_tracks_all_six_legacy_methods_and_four_post_actions_without_claiming_cutover(
    client, admin, app
):
    report = (await client.get("/api/system/migration")).json()
    batch = [op for op in report["operations"] if op.get("verification", {}).get("version") == "0.1.51"]
    assert {(op["method"], op["path"]) for op in batch} == {
        ("GET", P), ("POST", P), ("PATCH", P), ("DELETE", P),
        ("GET", P + "/config"), ("PUT", P + "/config"),
    }
    paths = app.openapi()["paths"]
    for op in batch:
        assert op["method"].lower() in paths[op["target"]]
        assert not op["accepted"] and op["client_ui"]["legacy_web"] == "pending_integration"
    dispatcher = next(op for op in batch if op["method"] == "POST")
    actions = dispatcher["verification"]["actions"]
    assert {action["action"] for action in actions} == {"login-options", "login-verify", "register-options", "register-verify"}
    for action in actions:
        assert action["method"].lower() in paths[action["new_web_path"]]
        assert action["new_web_path"] == ("/api/session/passkeys" if action["action"].startswith("login-") else "/api/account/passkeys")
    assert report["summary"]["local_verified_operations"] == sum(op["status"] == "local_verified" for op in report["operations"])
    assert report["capability_plan"]["summary"]["client_integrations_accepted"] == 0

async def test_strong_session_reuse_and_bound_passkey_reverification(db, settings, app):
    from alcor_api.session_verification import SESSION_PROOF
    _, private = await prepare(db, settings, factor=False)
    async with browser(app) as client:
        await login(client, private)
        token = client.cookies['fire_session']
        state = await client.get(P+'/verification')
        assert state.status_code == 200, state.text
        assert state.json()['verified'] is True
        # Reusing a real strong session does not require password or TOTP again.
        result = await client.post(P,json={'action':'register-options','password':SESSION_PROOF})
        assert result.status_code == 200, result.text
        async with db.connection() as conn, conn.transaction():
            await conn.execute("UPDATE sessions SET auth_method='password',passkey_id=NULL WHERE token_hash=%s",(digest(token),))
        assert (await client.get(P+'/verification')).json()['verified'] is False
        assert (await client.post(P,json={'action':'register-options','password':SESSION_PROOF})).status_code == 400
        issued = await client.post(P,json={'action':'verify-options'})
        assert issued.status_code == 200, issued.text
        issued = issued.json()
        data = {'action':'verify-session','requestId':issued['requestId'],'response':assertion(issued['options'],private,counter=9)}
        result = await client.post(P,json=data)
        assert result.status_code == 200, result.text
        assert client.cookies['fire_session'] == token, 'reverification must not rotate the active session'
        assert (await client.get(P+'/verification')).json()['verified'] is True
        assert (await client.post(P,json=data)).status_code == 400, 'a used WebAuthn assertion cannot be replayed'
        async with db.connection() as conn, conn.transaction():
            await conn.execute('DELETE FROM identity_passkeys WHERE id=%s',(KEY_ID,))
        assert (await client.get(P+'/verification')).status_code == 401

async def test_old_passkey_session_confirms_totp_without_repeating_password(db, settings, app):
    _, private = await prepare(db, settings, factor=False)
    async with browser(app) as client:
        await login(client, private)
        token = client.cookies['fire_session']
        async with db.connection() as conn, conn.transaction():
            await conn.execute("UPDATE sessions SET created_at=clock_timestamp()-interval '20 minutes' WHERE token_hash=%s", (digest(token),))
        setup = await client.post('/api/auth/totp')
        assert setup.status_code == 200, setup.text
        confirmed = await client.put('/api/auth/totp', json={
            'code': totp_code(setup.json()['secret'], int(time.time())), 'name': 'Synthetic verifier',
        })
        assert confirmed.status_code == 200, confirmed.text
        assert len(confirmed.json()['backupCodes']) == 8
        assert (await client.get('/api/auth/totp')).json()['enabled'] is True
