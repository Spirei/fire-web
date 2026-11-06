from uuid import uuid4

from alcor_api.cli import create_user
from alcor_api.native_app_auth import authenticate, issue_grant
from alcor_api.passwords import verify_password
from fastapi import HTTPException
from test_account_admin import login


async def draft(db, target, **extra):
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT revision FROM users WHERE id=%s", (target,))).fetchone()
    return {
        "request_id": str(uuid4()),
        "revision": str(row["revision"]),
        "current_password": "Synthetic9Pass",
        **extra,
    }


async def test_admin_password_reset_atomically_revokes_all_credentials_and_preserves_receipt(
    client,
    admin,
    db,
    settings,
    app,
):
    target = await create_user(settings, "PeerOne", "Synthetic9Pass", role="user")
    peer = await login(app)
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext,backup_codes) VALUES(%s,true,'synthetic-cipher','[\"synthetic-code\"]')",
            (target,),
        )
        await conn.execute(
            "INSERT INTO identity_passkeys(id,user_id,user_handle,rp_id,public_key,counter,name) VALUES('synthetic-key',%s,'synthetic-handle','localhost',%s,0,'synthetic')",
            (target, b"synthetic-key"),
        )
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (target,))).fetchone()
        native = await issue_grant(conn, user, "portfolio.read", "Synthetic administrator recovery")
    data = await draft(db, target, new_password="DifferentSynthetic9Pass")
    response = await client.post(f"/api/users/{target}/reset-password", json=data)
    assert response.status_code == 200, response.text
    assert response.json()["totpDisabled"] and response.json()["passkeysRevoked"]
    assert (await peer.get("/api/account")).status_code == 401
    assert (await client.post(f"/api/users/{target}/reset-password", json=data)).json() == response.json()
    assert (await client.get("/api/users/receipts/" + data["request_id"])).json() == response.json()
    changed = await client.post(
        f"/api/users/{target}/reset-password", json=data | {"new_password": "OtherSynthetic9Pass"}
    )
    assert changed.status_code == 409
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT password_hash FROM users WHERE id=%s", (target,))).fetchone()
        assert verify_password("DifferentSynthetic9Pass", user["password_hash"])
        factor = await (
            await conn.execute("SELECT * FROM identity_security WHERE user_id=%s", (target,))
        ).fetchone()
        assert (
            not factor["totp_enabled"]
            and factor["totp_secret_ciphertext"] is None
            and factor["backup_codes"] == []
        )
        assert (
            await (
                await conn.execute("SELECT count(*) n FROM identity_passkeys WHERE user_id=%s", (target,))
            ).fetchone()
        )["n"] == 0
        try:
            await authenticate(conn, native["access_token"])
        except HTTPException as error:
            assert error.status_code == 401
        else:
            raise AssertionError("Administrator recovery left the old native grant active")
        receipt = await (
            await conn.execute(
                "SELECT result::text,fingerprint FROM account_actions WHERE owner_id=%s AND request_id=%s",
                (admin, data["request_id"]),
            )
        ).fetchone()
        assert "DifferentSynthetic9Pass" not in receipt["result"] and len(receipt["fingerprint"]) == 64
        event = await (
            await conn.execute(
                "SELECT actor_id,target_id FROM audit_events WHERE action='admin.reset-password' AND request_id=%s",
                (data["request_id"],),
            )
        ).fetchone()
        assert event == {"actor_id": admin, "target_id": target}
    await peer.aclose()


async def test_admin_factor_recovery_requires_current_actor_password_and_target_revision(
    client, admin, db, settings
):
    target = await create_user(settings, "PeerOne", "Synthetic9Pass", role="user")
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext) VALUES(%s,true,'synthetic-cipher')",
            (target,),
        )
    data = await draft(db, target)
    path = f"/api/users/{target}/disable-totp"
    assert (
        await client.post(path, json=data | {"current_password": "WrongSynthetic9Pass"})
    ).status_code == 403
    assert (await client.post(path, json=data | {"revision": str(uuid4())})).status_code == 409
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT totp_enabled FROM identity_security WHERE user_id=%s", (target,))
            ).fetchone()
        )["totp_enabled"]
        assert not await (
            await conn.execute(
                "SELECT 1 FROM account_actions WHERE owner_id=%s AND request_id=%s",
                (admin, data["request_id"]),
            )
        ).fetchone()
    response = await client.post(path, json=data)
    assert response.status_code == 200 and response.json()["totpDisabled"]
    assert not response.json()["passkeysRevoked"]
    assert (await client.post(path, json=data)).json() == response.json()
    assert (await client.post(path, json=await draft(db, target))).status_code == 409


async def test_admin_factor_is_consumed_atomically_with_target_and_receipt(
    client, admin, db, settings, monkeypatch
):
    import time

    from alcor_api.native_identity import totp_code
    from psycopg import AsyncConnection

    setup = (await client.post("/api/auth/totp/setup", json={"password": "Synthetic9Pass"})).json()
    enabled = await client.post(
        "/api/auth/totp/confirm",
        json={
            "password": "Synthetic9Pass",
            "challengeId": setup["challengeId"],
            "code": totp_code(setup["secret"], int(time.time())),
            "name": "Synthetic recovery actor",
        },
    )
    assert enabled.status_code == 200, enabled.text
    code = enabled.json()["backupCodes"][0]
    target = await create_user(settings, "PeerOne", "Synthetic9Pass", role="user")
    data = await draft(db, target, new_password="DifferentSynthetic9Pass", code=code)
    path = f"/api/users/{target}/reset-password"
    assert (await client.post(path, json=data | {"code": "wrong"})).status_code == 403
    execute = AsyncConnection.execute

    async def interrupt(conn, query, *args, **kwargs):
        if (
            isinstance(query, str)
            and "INSERT INTO audit_events(actor_id,action,target_id,request_id)" in query
            and args
            and args[0][1] == "admin.reset-password"
        ):
            raise RuntimeError("synthetic failure after credential changes")
        return await execute(conn, query, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(AsyncConnection, "execute", interrupt)
        assert (await client.post(path, json=data)).status_code == 503
    async with db.connection() as conn:
        user = await (
            await conn.execute("SELECT revision,password_hash FROM users WHERE id=%s", (target,))
        ).fetchone()
        assert str(user["revision"]) == data["revision"] and verify_password(
            "Synthetic9Pass", user["password_hash"]
        )
        assert (
            len(
                (
                    await (
                        await conn.execute(
                            "SELECT backup_codes FROM identity_security WHERE user_id=%s", (admin,)
                        )
                    ).fetchone()
                )["backup_codes"]
            )
            == 8
        )
        assert not await (
            await conn.execute(
                "SELECT 1 FROM account_actions WHERE owner_id=%s AND request_id=%s",
                (admin, data["request_id"]),
            )
        ).fetchone()
    result = await client.post(path, json=data)
    assert result.status_code == 200, result.text
    assert (await client.post(path, json=data)).json() == result.json()
    async with db.connection() as conn:
        assert (
            len(
                (
                    await (
                        await conn.execute(
                            "SELECT backup_codes FROM identity_security WHERE user_id=%s", (admin,)
                        )
                    ).fetchone()
                )["backup_codes"]
            )
            == 7
        )
