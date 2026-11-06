"""Native security lifecycle verifies shared PG effects and protocol boundaries."""

import time

import pytest
from alcor_api.native_app_auth import CLIENT, issue_grant
from alcor_api.native_identity import totp_code

PASSWORD = "SyntheticNativeFactor9"


async def register(client, db):
    response = await client.post(
        "/api/auth/register", json={"username": "NativeFactorOwner", "password": PASSWORD}
    )
    assert response.status_code == 201
    uid = response.json()["user"]["id"]
    assert (await client.get("/api/auth/me")).json()["user"]["uid"]
    return uid


async def grant(db, uid, scope="portfolio.read security.read security.write", passkey=None):
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
        return await issue_grant(conn, user, scope, "Synthetic phone", passkey)


def headers(pair):
    return {"authorization": "Bearer " + pair["access_token"]}


@pytest.mark.parametrize("version", [1, 2])
async def test_native_totp_grant_binding_rotation_enable_regenerate_disable(client, db, version):
    uid = await register(client, db)
    pair = await grant(db, uid)
    peer = await grant(db, uid)
    base = f"/api/v{version}/auth/totp"
    assert (await client.get(base)).status_code == 401
    assert (await client.get(base, headers=headers(pair))).json()["data"] == {
        "enabled": False,
        "name": "",
        "backupCodesRemaining": 0,
    }
    setup = await client.post(base + "/setup", headers=headers(pair), json={"currentPassword": PASSWORD})
    assert setup.status_code == 200, setup.text
    stage = setup.json()["data"]
    assert set(stage) == {"challengeId", "secret", "otpauthUrl", "qrPng", "expiresAt"}
    payload = {
        "currentPassword": PASSWORD,
        "challengeId": stage["challengeId"],
        "code": totp_code(stage["secret"], int(time.time())),
        "name": "Phone factor",
    }
    wrong_grant = await client.post(base + "/confirm", headers=headers(peer), json=payload)
    assert wrong_grant.status_code == 409 and wrong_grant.json()["code"] == 40902
    refreshed = await client.post(
        f"/api/v{version}/auth/token",
        json={"grant_type": "refresh_token", "client_id": CLIENT, "refresh_token": pair["refresh_token"]},
    )
    assert refreshed.status_code == 200
    rotated = refreshed.json()["data"]
    confirmed = await client.post(base + "/confirm", headers=headers(rotated), json=payload)
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["data"]["reauthenticationRequired"] is True
    codes = confirmed.json()["data"]["backupCodes"]
    assert (await client.get("/api/auth/me")).status_code == 401
    assert (await client.get(base, headers=headers(peer))).status_code == 401
    after = await grant(db, uid)
    state = (await client.get(base, headers=headers(after))).json()["data"]
    assert state == {"enabled": True, "name": "Phone factor", "backupCodesRemaining": 8}
    regenerated = await client.post(
        base + "/backup-codes", headers=headers(after), json={"currentPassword": PASSWORD, "code": codes[0]}
    )
    assert regenerated.status_code == 200, regenerated.text
    assert regenerated.json()["data"]["reauthenticationRequired"] is False
    rejected = await client.post(
        base + "/disable", headers=headers(after), json={"currentPassword": PASSWORD, "code": codes[1]}
    )
    assert rejected.status_code == 403 and rejected.json()["code"] == 40104
    disabled = await client.post(
        base + "/disable",
        headers=headers(after),
        json={"currentPassword": PASSWORD, "code": regenerated.json()["data"]["backupCodes"][0]},
    )
    assert disabled.json()["data"] == {"ok": True, "enabled": False, "reauthenticationRequired": True}
    async with db.connection() as conn:
        state = await (
            await conn.execute("SELECT * FROM identity_security WHERE user_id=%s", (uid,))
        ).fetchone()
        assert (
            not state["totp_enabled"]
            and state["totp_secret_ciphertext"] is None
            and state["backup_codes"] == []
        )


async def test_native_security_scope_origin_and_expired_challenge(client, db):
    uid = await register(client, db)
    reader = await grant(db, uid, "portfolio.read security.read")
    full = await grant(db, uid)
    base = "/api/v2/auth/totp"
    assert (
        await client.post(base + "/setup", headers=headers(reader), json={"currentPassword": PASSWORD})
    ).status_code == 403
    assert (
        await client.get(base, headers={**headers(full), "origin": "https://untrusted.invalid"})
    ).status_code == 403
    setup = (
        await client.post(base + "/setup", headers=headers(full), json={"currentPassword": PASSWORD})
    ).json()["data"]
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE identity_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE purpose='totp-setup'"
        )
    rejected = await client.post(
        base + "/confirm",
        headers=headers(full),
        json={
            "currentPassword": PASSWORD,
            "challengeId": setup["challengeId"],
            "code": totp_code(setup["secret"], int(time.time())),
        },
    )
    assert rejected.status_code == 409 and rejected.json()["code"] == 40902
    assert (await client.get(base, headers=headers(full))).json()["data"]["enabled"] is False


@pytest.mark.parametrize("version", [1, 2])
async def test_native_passkey_list_remove_and_registration_remains_honestly_unavailable(client, db, version):
    uid = await register(client, db)
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO identity_passkeys(id,user_id,user_handle,rp_id,public_key,counter,transports,name,backed_up) VALUES('synthetic-key',%s,'synthetic-handle','example.invalid',%s,0,'[]'::jsonb,'Synthetic key',false)",
            (uid, b"synthetic-key-bytes"),
        )
    full = await grant(db, uid)
    derived = await grant(db, uid, passkey="synthetic-key")
    base = f"/api/v{version}/auth/passkeys"
    listed = await client.get(base, headers=headers(full))
    assert listed.status_code == 200, listed.text
    assert set(listed.json()["data"]) == {"keys", "registration"}
    assert listed.json()["data"]["keys"][0]["id"] == "synthetic-key"
    assert listed.json()["data"]["registration"]["supported"] is False
    for action in ("register-options", "register-verify"):
        rejected = await client.post(base + "/" + action, headers=headers(full), json={})
        assert rejected.status_code == 404
    removed = await client.request(
        "DELETE", base, headers=headers(full), json={"id": "synthetic-key", "currentPassword": PASSWORD}
    )
    assert removed.status_code == 200, removed.text
    assert removed.json()["data"] == {"ok": True, "reauthenticationRequired": False}
    assert (await client.get(base, headers=headers(derived))).status_code == 401
    assert (await client.get(base, headers=headers(full))).json()["data"]["keys"] == []






@pytest.mark.parametrize("version", [1, 2])
async def test_password_proof_is_grant_bound_rotatable_and_replaced(client, db, version):
    uid = await register(client, db)
    pair = await grant(db, uid)
    peer = await grant(db, uid)
    base = f"/api/v{version}/auth/password-change"
    wrong = await client.post(base + "/verify", headers=headers(pair), json={"currentPassword": "wrong"})
    assert wrong.status_code == 403 and wrong.json()["code"] == 40103
    first = (
        await client.post(base + "/verify", headers=headers(pair), json={"currentPassword": PASSWORD})
    ).json()["data"]
    second = (
        await client.post(base + "/verify", headers=headers(pair), json={"currentPassword": PASSWORD})
    ).json()["data"]
    assert set(second) == {"ok", "proof", "expiresAt"}
    payload = {"proof": second["proof"], "newPassword": "SyntheticUpdatedPassword7"}
    wrong_grant = await client.post(base + "/confirm", headers=headers(peer), json=payload)
    assert wrong_grant.status_code == 400 and wrong_grant.json()["code"] == 40003
    replaced = await client.post(
        base + "/confirm", headers=headers(pair), json={**payload, "proof": first["proof"]}
    )
    assert replaced.status_code == 400 and replaced.json()["code"] == 40003
    rotated = (
        await client.post(
            f"/api/v{version}/auth/token",
            json={"grant_type": "refresh_token", "client_id": CLIENT, "refresh_token": pair["refresh_token"]},
        )
    ).json()["data"]
    confirmed = await client.post(base + "/confirm", headers=headers(rotated), json=payload)
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["data"] == {"ok": True, "reauthenticationRequired": True}
    assert (await client.post(base + "/confirm", headers=headers(rotated), json=payload)).status_code == 401
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM identity_challenges WHERE user_id=%s", (uid,))
        ).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM sessions WHERE user_id=%s", (uid,))).fetchone()
    assert (
        await client.post(
            "/api/auth/login", json={"username": "NativeFactorOwner", "password": payload["newPassword"]}
        )
    ).status_code == 200


async def test_password_proof_expiry_state_and_atomic_failure(client, db):
    uid = await register(client, db)
    pair = await grant(db, uid)
    base = "/api/v2/auth/password-change"

    async def proof():
        response = await client.post(
            base + "/verify", headers=headers(pair), json={"currentPassword": PASSWORD}
        )
        assert response.status_code == 200, response.text
        return response.json()["data"]["proof"]

    expired = await proof()
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE identity_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE purpose='password-proof'"
        )
    payload = {"proof": expired, "newPassword": "SyntheticUpdatedPassword7"}
    assert (await client.post(base + "/confirm", headers=headers(pair), json=payload)).status_code == 400
    changed = await proof()
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET email='synthetic@example.invalid' WHERE id=%s", (uid,))
    assert (
        await client.post(base + "/confirm", headers=headers(pair), json={**payload, "proof": changed})
    ).status_code == 400
    valid = await proof()
    async with db.connection() as conn:
        stored = await (
            await conn.execute("SELECT id,payload FROM identity_challenges WHERE purpose='password-proof'")
        ).fetchone()
        assert valid not in str(stored) and PASSWORD not in str(stored)
        await conn.execute(
            "CREATE FUNCTION reject_proof_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='account.password.changed' THEN RAISE EXCEPTION 'synthetic fault'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_proof_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_proof_audit()"
        )
    payload["proof"] = valid
    assert (await client.post(base + "/confirm", headers=headers(pair), json=payload)).status_code == 503
    async with db.connection() as conn:
        await conn.execute("DROP TRIGGER reject_proof_audit ON audit_events")
    assert (await client.post(base + "/confirm", headers=headers(pair), json=payload)).status_code == 200


@pytest.mark.parametrize("version", [1, 2])
@pytest.mark.parametrize("action", ["register-options", "register-verify"])
async def test_removed_native_passkey_registration_never_creates_a_credential(client, db, version, action):
    path = f"/api/v{version}/auth/passkeys/{action}"
    for headers_ in ({}, {"authorization":"Bearer fat_"+"a"*43}, {"origin":"https://untrusted.invalid"}):
        assert (await client.post(path,headers=headers_,json={})).status_code == 404
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM identity_passkeys')).fetchone())['n'] == 0
