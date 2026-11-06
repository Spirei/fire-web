"""Device contracts exercised only against identity-checked private test PG."""

import time

import pytest
from alcor_api.identity_devices import web_device_id
from alcor_api.native_app_auth import issue_grant
from alcor_api.native_identity import totp_code
from alcor_api.security import digest

PASSWORD = "SyntheticDevicePassword9"


async def register(client, name="DeviceOwner"):
    response = await client.post("/api/auth/register", json={"username": name, "password": PASSWORD})
    assert response.status_code == 201
    return response.json()["user"]["id"]


async def grant(db, uid, scope="portfolio.read security.read security.write"):
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
        return await issue_grant(conn, user, scope, "Synthetic phone")


def bearer(pair):
    return {"authorization": "Bearer " + pair["access_token"]}


async def test_web_devices_cookie_only_idempotent_owner_revocation(client, db):
    uid = await register(client)
    pair = await grant(db, uid)
    path = "/api/v1/auth/devices"
    listed = await client.get(path)
    assert listed.status_code == 200, listed.text
    devices = listed.json()["data"]["devices"]
    assert len(devices) == 1
    assert set(devices[0]) == {"id", "name", "scope", "createdAt", "lastUsedAt", "expiresAt"}
    assert devices[0]["id"] == pair["grant_id"]
    assert isinstance(devices[0]["createdAt"], int)
    assert (await client.get(path, headers=bearer(pair))).status_code == 401
    assert (await client.get(path, headers={"authorization": ""})).status_code == 401
    assert (
        await client.request(
            "DELETE", path, json={"id": pair["grant_id"]}, headers={"origin": "https://untrusted.invalid"}
        )
    ).status_code == 403
    for _ in range(2):
        removed = await client.request("DELETE", path, json={"id": pair["grant_id"]})
        assert removed.status_code == 200 and removed.json()["data"] == {"revoked": True}
    assert (await client.get(path)).json()["data"]["devices"] == []
    assert (await client.get("/api/auth/me")).status_code == 200
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM audit_events WHERE action='identity.device.revoked' AND actor_id=%s",
                    (uid,),
                )
            ).fetchone()
        )["n"] == 1


@pytest.mark.parametrize("version", [1, 2])
async def test_native_device_scope_step_up_and_self_revocation(client, db, version):
    uid = await register(client)
    pair = await grant(db, uid)
    other = await grant(db, uid, "portfolio.read")
    path = f"/api/v{version}/auth/security-devices"
    assert (await client.get(path)).status_code == 401
    assert (await client.get(path, headers=bearer(other))).status_code == 403
    listed = await client.get(path, headers=bearer(pair))
    assert listed.status_code == 200, listed.text
    devices = listed.json()["data"]["devices"]
    current = next(row for row in devices if row["id"] == pair["grant_id"])
    assert current["kind"] == "app" and current["current"] is True
    web = next(row for row in devices if row["kind"] == "web")
    assert web["id"] == web_device_id(digest(client.cookies["fire_session"]))
    assert web["lastUsedAt"] is None and web["current"] is False
    assert client.cookies["fire_session"] not in str(devices)
    assert digest(client.cookies["fire_session"]) not in str(devices)
    bad = await client.request(
        "DELETE", path, headers=bearer(pair), json={"id": web["id"], "currentPassword": "wrong"}
    )
    assert bad.status_code == 403 and bad.json()["code"] == 40103
    removed = await client.request(
        "DELETE", path, headers=bearer(pair), json={"id": web["id"], "currentPassword": PASSWORD}
    )
    assert removed.status_code == 200, removed.text
    assert removed.json()["data"] == {"revoked": True, "reauthenticationRequired": False}
    assert (await client.get("/api/auth/me")).status_code == 401
    own = await client.request(
        "DELETE", path, headers=bearer(pair), json={"id": pair["grant_id"], "currentPassword": PASSWORD}
    )
    assert own.json()["data"] == {"revoked": True, "reauthenticationRequired": True}
    assert (await client.get(path, headers=bearer(pair))).status_code == 401
    assert (await client.get(f"/api/v{version}/auth/me", headers=bearer(other))).status_code == 200


async def test_cross_account_device_id_cannot_revoke_or_enumerate(client, db):
    first = await register(client)
    pair = await grant(db, first)
    await client.post("/api/auth/logout")
    second = await register(client, "OtherOwner")
    other = await grant(db, second)
    response = await client.request("DELETE", "/api/v1/auth/devices", json={"id": pair["grant_id"]})
    assert response.status_code == 200
    response = await client.request(
        "DELETE",
        "/api/v2/auth/security-devices",
        headers=bearer(other),
        json={"id": pair["grant_id"], "currentPassword": PASSWORD},
    )
    assert response.status_code == 404
    assert (await client.get("/api/v2/auth/me", headers=bearer(pair))).status_code == 200
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE identity_app_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=%s",
            (other["grant_id"],),
        )
    assert (await client.get("/api/v1/auth/devices")).json()["data"]["devices"] == []


async def test_device_revoke_factor_and_audit_failure_are_atomic(client, db):
    uid = await register(client)
    setup = (await client.post("/api/auth/totp")).json()
    confirmed = await client.put(
        "/api/auth/totp", json={"code": totp_code(setup["secret"], int(time.time()))}
    )
    backup = confirmed.json()["backupCodes"][0]
    pair = await grant(db, uid)
    other = await grant(db, uid)
    path = "/api/v2/auth/security-devices"
    payload = {"id": other["grant_id"], "currentPassword": PASSWORD, "code": backup}
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_device_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='identity.device.revoked' THEN RAISE EXCEPTION 'synthetic fault'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_device_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_device_audit()"
        )
    failed = await client.request("DELETE", path, headers=bearer(pair), json=payload)
    assert failed.status_code == 503
    assert (await client.get("/api/v2/auth/me", headers=bearer(other))).status_code == 200
    async with db.connection() as conn:
        await conn.execute("DROP TRIGGER reject_device_audit ON audit_events")
    assert (await client.request("DELETE", path, headers=bearer(pair), json=payload)).status_code == 200
    replay = await client.request(
        "DELETE", path, headers=bearer(pair), json={**payload, "id": pair["grant_id"]}
    )
    assert replay.status_code == 403 and replay.json()["code"] == 40104
    assert (await client.get(path, headers=bearer(pair))).status_code == 200
