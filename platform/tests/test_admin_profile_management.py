import asyncio
import hashlib

from alcor_api.accounts import LoginConflict
from alcor_api.cli import create_user
from alcor_api.connections import canonical
from alcor_api.native_app_auth import authenticate, issue_grant
from fastapi import HTTPException
from psycopg.types.json import Jsonb
from test_account_admin import body_for, login


async def test_admin_username_email_change_revokes_target_sessions_and_preserves_original_receipt(
    client, admin, settings, app, db
):
    uid = await create_user(settings, "PeerOne", "Synthetic9Pass", role="user", email="peer@example.invalid")
    peer = await login(app)
    async with db.connection() as conn:
        await conn.execute("INSERT INTO identity_security(user_id,email_verified) VALUES(%s,true)", (uid,))
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
        native = await issue_grant(conn, user, "portfolio.read", "Synthetic managed profile")
    data = await body_for(client, uid, username="PeerRenamed", email="new-peer@example.invalid")
    changed = await client.patch("/api/users/" + uid, json=data)
    assert changed.status_code == 200, changed.text
    result = changed.json()
    assert (
        result["changed"]
        and result["user"]["username"] == "PeerRenamed"
        and result["user"]["email"] == "new-peer@example.invalid"
    )
    assert (await peer.get("/api/account")).status_code == 401
    assert (await client.patch("/api/users/" + uid, json=data)).json() == result
    assert (await client.get("/api/users/receipts/" + data["request_id"])).json() == result
    async with db.connection() as conn:
        assert not (
            await (
                await conn.execute("SELECT email_verified FROM identity_security WHERE user_id=%s", (uid,))
            ).fetchone()
        )["email_verified"]
        try:
            await authenticate(conn, native["access_token"])
        except HTTPException as error:
            assert error.status_code == 401
        else:
            raise AssertionError("Old native token remained active")
        events = await (
            await conn.execute(
                "SELECT actor_id,target_id FROM audit_events WHERE action='account.email.changed' AND request_id=%s",
                (data["request_id"],),
            )
        ).fetchall()
        assert events == [{"actor_id": admin, "target_id": uid}]
    restored = await login(app, "PeerRenamed")
    assert (await restored.get("/api/account")).json()["email"] == "new-peer@example.invalid"
    await restored.aclose()
    await peer.aclose()


async def test_admin_profile_unique_namespace_validation_and_registration_race(client, admin, settings, db):
    uid = await create_user(settings, "PeerOne", "Synthetic9Pass", role="user")
    await create_user(settings, "PeerTaken", "Synthetic9Pass", role="user")
    await create_user(settings, "claimed@example.invalid", "Synthetic9Pass", role="user")
    for patch in ({"username": "peertaken"}, {"email": "CLAIMED@example.invalid"}):
        response = await client.patch("/api/users/" + uid, json=await body_for(client, uid, **patch))
        assert response.status_code == 409, response.text
    for patch in ({"username": None}, {"email": None}, {"username": "x"}, {"email": "bad"}):
        assert (
            await client.patch("/api/users/" + uid, json=await body_for(client, uid, **patch))
        ).status_code == 422
    data = await body_for(client, uid, username="RaceName")

    async def registration():
        try:
            await create_user(settings, "RaceName", "Synthetic9Pass", role="user")
            return True
        except LoginConflict:
            return False

    update, registered = await asyncio.gather(client.patch("/api/users/" + uid, json=data), registration())
    assert (update.status_code == 200) != registered
    assert update.status_code in (200, 409)
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT count(*) n FROM users WHERE lower(username)='racename'")
            ).fetchone()
        )["n"] == 1


async def test_admin_profile_failure_rolls_back_all_fields_and_old_role_only_receipt_still_replays(
    client, admin, settings, db
):
    uid = await create_user(settings, "PeerOne", "Synthetic9Pass", role="user", email="peer@example.invalid")
    body = await body_for(client, uid)
    old_result = {"request_id": body["request_id"], "user": {"id": uid}, "changed": False}
    async with db.connection() as conn:
        old_fingerprint = hashlib.sha256(
            canonical(
                {key: value for key, value in body.items() if key not in {"request_id", "current_password", "code"}} | {"user_id": uid}
            ).encode()
        ).hexdigest()
        await conn.execute(
            "INSERT INTO account_actions(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
            (admin, body["request_id"], old_fingerprint, Jsonb(old_result)),
        )
    assert (await client.patch("/api/users/" + uid, json=body)).json() == old_result
    data = await body_for(client, uid, username="PeerChanged", email="changed@example.invalid")
    async with db.connection() as conn:
        before = await (
            await conn.execute(
                "SELECT username,email,revision,session_version FROM users WHERE id=%s", (uid,)
            )
        ).fetchone()
        await conn.execute(
            "CREATE FUNCTION synthetic_admin_profile_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='account.updated' THEN RAISE EXCEPTION 'synthetic audit interruption'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_admin_profile_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_admin_profile_failure()",
            prepare=False,
        )
    failed = await client.patch("/api/users/" + uid, json=data)
    assert failed.status_code == 503, failed.text
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT username,email,revision,session_version FROM users WHERE id=%s", (uid,)
                )
            ).fetchone()
            == before
        )
        assert not await (
            await conn.execute("SELECT 1 FROM account_actions WHERE request_id=%s", (data["request_id"],))
        ).fetchone()
        assert not await (
            await conn.execute("SELECT 1 FROM audit_events WHERE request_id=%s", (data["request_id"],))
        ).fetchone()
