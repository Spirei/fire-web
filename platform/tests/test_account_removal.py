from uuid import uuid4

from alcor_api.cli import create_user
from test_account_admin import body_for, login

P = "/api"


async def test_uid_is_immutable_unique_and_searchable(client, admin, settings):
    other = await create_user(settings, "UniqueUser", "Synthetic9Pass", role="user")
    rows = (await client.get(P + "/users")).json()["items"]
    assert len({r["uid"] for r in rows}) == len(rows)
    assert next(r for r in rows if r["id"] == other)["uid"] == "2"
    assert (await client.get(P + "/users", params={"q": "2"})).json()["items"][0]["uid"] == "2"
    assert (await client.get(P + "/account")).json()["uid"] == "1"


async def test_delete_user_is_versioned_idempotent_revokes_and_keeps_audit(client, admin, settings, app, db):
    uid = await create_user(settings, "PeerOne", "Synthetic9Pass", role="user")
    peer = await login(app)
    body = await body_for(client, uid)
    body = {k: body[k] for k in ("request_id", "revision", "current_password")}
    first = await client.request("DELETE", P + "/users/" + uid, json=body)
    assert first.status_code == 200, first.text
    assert (await client.request("DELETE", P + "/users/" + uid, json=body)).json() == first.json()
    assert (await client.get(P + "/users/receipts/" + body["request_id"])).json() == first.json()
    assert uid not in [r["id"] for r in (await client.get(P + "/users")).json()["items"]]
    assert (await peer.get(P + "/account")).status_code == 401
    assert (
        await client.patch(
            P + "/users/" + uid, json=body | {"request_id": str(uuid4()), "role": "user", "active": True}
        )
    ).status_code == 409
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT active,deleted_at FROM users WHERE id=%s", (uid,))).fetchone()
        assert not row["active"] and row["deleted_at"]
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM audit_events WHERE target_id=%s AND action='account.deleted'",
                    (uid,),
                )
            ).fetchone()
        )["n"] == 1
    await peer.aclose()


async def test_admin_cannot_be_deleted_in_list_and_last_admin_cannot_close(client, admin):
    raw = await body_for(client, admin)
    body = {k: raw[k] for k in ("request_id", "revision", "current_password")}
    assert (await client.request("DELETE", P + "/users/" + admin, json=body)).status_code == 403
    close = await client.post(P + "/account/close", json=body | {"current_password": "Synthetic9Pass"})
    assert close.status_code == 409, close.text
    assert (await client.get(P + "/session")).status_code == 200


async def test_admin_self_closure_requires_password_and_keeps_other_admin(client, admin, settings, app):
    await create_user(settings, "PeerOne", "Synthetic9Pass", role="admin")
    peer = await login(app)
    raw = await body_for(client, admin)
    body = {k: raw[k] for k in ("request_id", "revision", "current_password")}
    assert (
        await client.post(P + "/account/close", json=body | {"current_password": "wrong"})
    ).status_code == 422
    result = await client.post(P + "/account/close", json=body | {"current_password": "Synthetic9Pass"})
    assert result.status_code == 200, result.text
    assert (await client.get(P + "/session")).status_code == 401
    assert (await peer.get(P + "/users")).status_code == 200
    await peer.aclose()


async def test_delete_denies_nonadmin_and_stale_revision(client, admin, settings, app):
    uid = await create_user(settings, "PeerOne", "Synthetic9Pass", role="user")
    peer = await login(app)
    body = {"request_id": str(uuid4()), "revision": str(uuid4())}
    assert (await peer.request("DELETE", P + "/users/" + admin, json=body)).status_code == 403
    assert (await client.request("DELETE", P + "/users/" + uid, json=body)).status_code == 409
    await peer.aclose()


async def test_numeric_uid_ignores_source_metadata_and_cannot_be_reassigned(client, admin, settings, db):
    import psycopg
    from psycopg.types.json import Jsonb

    await create_user(settings, "UidPeer", "Synthetic9Pass", role="user")
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO identity_source_profiles(user_id,metadata) VALUES(%s,%s)",
            (admin, Jsonb({"uid": "source-17"})),
        )
    assert (await client.get(P + "/account")).json()["uid"] == "1"
    try:
        async with db.connection() as conn, conn.transaction():
            await conn.execute("UPDATE users SET uid='99' WHERE id=%s", (admin,))
    except psycopg.Error:
        pass
    else:
        raise AssertionError("UID reassignment was accepted")
    assert (await client.get(P + "/account")).json()["uid"] == "1"


async def test_self_closure_requires_enabled_factor(client, admin, settings, db):
    import time

    from alcor_api.connections import Vault
    from alcor_api.native_identity import totp_code

    await create_user(settings, "BackupAdmin", "Synthetic9Pass", role="admin")
    secret = "JBSWY3DPEHPK3PXP"
    cipher = Vault(settings.connection_secret_dir).encrypt(secret, "totp:" + admin, settings.instance_id)
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext) VALUES(%s,true,%s)",
            (admin, cipher),
        )
    raw = await body_for(client, admin)
    body = {k: raw[k] for k in ("request_id", "revision", "current_password")} | {"current_password": "Synthetic9Pass"}
    assert (await client.post(P + "/account/close", json=body | {"code": "wrong"})).status_code == 403
    result = await client.post(
        P + "/account/close", json=body | {"code": totp_code(secret, int(time.time()))}
    )
    assert result.status_code == 200, result.text


async def test_concurrent_admin_closure_keeps_one_active_admin(client, admin, settings, app, db):
    import asyncio

    other = await create_user(settings, "PeerOne", "Synthetic9Pass", role="admin")
    peer = await login(app)
    requests = []
    for actor, uid in [(client, admin), (peer, other)]:
        raw = await body_for(actor, uid)
        body = {k: raw[k] for k in ("request_id", "revision", "current_password")} | {"current_password": "Synthetic9Pass"}
        requests.append(actor.post(P + "/account/close", json=body))
    results = await asyncio.gather(*requests)
    assert sorted(r.status_code for r in results) == [200, 409]
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM users WHERE active AND role='admin' AND deleted_at IS NULL"
                )
            ).fetchone()
        )["n"] == 1
    await peer.aclose()
