import time
from uuid import uuid4

from alcor_api.cli import create_user
from alcor_api.connections import Vault
from alcor_api.native_identity import totp_code
from psycopg import AsyncConnection
from test_account_admin import body_for, login


async def test_privilege_changes_require_current_password_but_completed_receipts_do_not_reauthenticate(
    client, admin, settings, db
):
    target = await create_user(settings, "PeerOne", "Synthetic9Pass", role="user")
    data = await body_for(client, target, role="admin")
    path = "/api/users/" + target
    without = {k: v for k, v in data.items() if k != "current_password"}
    assert (await client.patch(path, json=without)).status_code == 403
    assert (
        await client.patch(path, json=data | {"current_password": "WrongSynthetic9Pass"})
    ).status_code == 403
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT role FROM users WHERE id=%s", (target,))).fetchone())[
            "role"
        ] == "user"
        assert not await (
            await conn.execute(
                "SELECT 1 FROM account_actions WHERE owner_id=%s AND request_id=%s",
                (admin, data["request_id"]),
            )
        ).fetchone()
    response = await client.patch(path, json=data)
    assert response.status_code == 200, response.text
    assert (await client.patch(path, json=without)).json() == response.json()


async def test_actor_factor_target_change_and_audit_are_one_transaction(
    client, admin, settings, db, monkeypatch
):
    target = await create_user(settings, "PeerOne", "Synthetic9Pass", role="user")
    secret = "JBSWY3DPEHPK3PXP"
    cipher = Vault(settings.connection_secret_dir).encrypt(secret, "totp:" + admin, settings.instance_id)
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext) VALUES(%s,true,%s)",
            (admin, cipher),
        )
    data = await body_for(client, target, active=False)
    path = "/api/users/" + target
    assert (await client.patch(path, json=data | {"code": "wrong"})).status_code == 403
    data["code"] = totp_code(secret, int(time.time()))
    original = AsyncConnection.execute

    async def fail_audit(conn, query, *args, **kwargs):
        if isinstance(query, str) and "'account.updated'" in query and "INSERT INTO audit_events" in query:
            raise RuntimeError("Synthetic interruption after target update")
        return await original(conn, query, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(AsyncConnection, "execute", fail_audit)
        assert (await client.patch(path, json=data)).status_code == 503
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT active FROM users WHERE id=%s", (target,))).fetchone())[
            "active"
        ]
        assert (
            await (
                await conn.execute("SELECT totp_last_step FROM identity_security WHERE user_id=%s", (admin,))
            ).fetchone()
        )["totp_last_step"] == -1
        assert not await (
            await conn.execute(
                "SELECT 1 FROM account_actions WHERE owner_id=%s AND request_id=%s",
                (admin, data["request_id"]),
            )
        ).fetchone()
    success = await client.patch(path, json=data)
    assert success.status_code == 200, success.text
    assert (await client.patch(path, json=data)).json() == success.json()


async def test_other_administrator_can_be_removed_only_after_step_up_and_self_remains_protected(
    client, admin, settings, app, db
):
    target = await create_user(settings, "PeerOne", "Synthetic9Pass", role="admin")
    peer = await login(app)
    row = await body_for(client, target)
    data = {k: row[k] for k in ("request_id", "revision", "current_password")}
    path = "/api/users/" + target
    assert (
        await client.request("DELETE", path, json={k: v for k, v in data.items() if k != "current_password"})
    ).status_code == 403
    result = await client.request("DELETE", path, json=data)
    assert result.status_code == 200, result.text
    assert (await client.request("DELETE", path, json=data)).json() == result.json()
    assert (await peer.get("/api/account")).status_code == 401
    own = await body_for(client, admin)
    assert (
        await client.request(
            "DELETE",
            "/api/users/" + admin,
            json={**data, "request_id": str(uuid4()), "revision": own["revision"]},
        )
    ).status_code == 403
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM users WHERE active AND role='admin' AND deleted_at IS NULL"
                )
            ).fetchone()
        )["n"] == 1
    await peer.aclose()
