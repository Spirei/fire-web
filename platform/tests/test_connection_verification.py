import time

from alcor_api.connections import Vault
from alcor_api.native_identity import totp_code
from alcor_api.security import COOKIE
from test_connections import P, request_data


async def age(db):
    async with db.connection() as conn:
        await conn.execute("UPDATE sessions SET created_at=clock_timestamp()-interval '16 minutes'")


async def test_stale_admin_can_read_and_verify_without_replacing_or_extending_session(
    client, admin, db, settings
):
    data = await request_data(client, settings)
    token = client.cookies[COOKIE]
    await age(db)
    async with db.connection() as conn:
        before = await (await conn.execute("SELECT created_at,expires_at FROM sessions")).fetchone()
    denied = await client.put(P + "postgresql", json=data)
    assert denied.status_code == 403 and denied.headers["x-alcor-reauthentication"] == "required"
    assert (await client.get(P + "postgresql")).status_code == 200
    wrong = await client.post(P + "reauthenticate", json={"password": "WrongSynthetic9"})
    assert wrong.status_code == 403 and "x-alcor-reauthentication" not in wrong.headers
    verified = await client.post(P + "reauthenticate", json={"password": "Synthetic9Pass"})
    assert verified.status_code == 204 and client.cookies[COOKIE] == token
    result = await client.put(P + "postgresql", json=data)
    assert result.status_code == 200 and result.json()["status"] in {"saved", "pending"}
    async with db.connection() as conn:
        assert await (await conn.execute("SELECT created_at,expires_at FROM sessions")).fetchone() == before


async def test_connection_verification_requires_existing_totp_and_rejects_replay(client, admin, db, settings):
    secret = "JBSWY3DPEHPK3PXP"
    cipher = Vault(settings.connection_secret_dir).encrypt(secret, "totp:" + admin, settings.instance_id)
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext) VALUES(%s,true,%s)",
            (admin, cipher),
        )
    await age(db)
    assert (await client.post(P + "reauthenticate", json={"password": "Synthetic9Pass"})).status_code == 403
    code = totp_code(secret, int(time.time()))
    assert (
        await client.post(P + "reauthenticate", json={"password": "Synthetic9Pass", "code": code})
    ).status_code == 204
    assert (
        await client.post(P + "reauthenticate", json={"password": "Synthetic9Pass", "code": code})
    ).status_code == 403


async def test_connection_verification_is_session_bound_expires_and_cannot_override_role(
    client, admin, db, settings
):
    await age(db)
    assert (await client.post(P + "reauthenticate", json={"password": "Synthetic9Pass"})).status_code == 204
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE identity_challenges SET expires_at=clock_timestamp()-interval '1 second' WHERE purpose='connection-reauth'"
        )
    data = await request_data(client, settings)
    assert (await client.put(P + "postgresql", json=data)).headers["x-alcor-reauthentication"] == "required"
    assert (
        await client.post(
            P + "reauthenticate", json={"password": "Synthetic9Pass"}, headers={"x-csrf-token": "wrong"}
        )
    ).status_code == 403
    assert (await client.post(P + "reauthenticate", json={"password": "Synthetic9Pass"})).status_code == 204
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET role='user' WHERE id=%s", (admin,))
    assert (await client.put(P + "postgresql", json=data)).status_code == 403
    assert (await client.post(P + "reauthenticate", json={"password": "Synthetic9Pass"})).status_code == 403
