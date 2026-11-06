from uuid import uuid4

import httpx
import pytest_asyncio
from alcor_api.cli import create_user
from alcor_api.security import COOKIE
from test_account_admin import body_for

P = "/api/users"


@pytest_asyncio.fixture
async def legacy(app, admin):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as client:
        response = await client.post(
            "/api/auth/login", json={"username": "AdminOne", "password": "Synthetic9Pass"}
        )
        assert response.status_code == 200, response.text
        yield client


async def test_old_cookie_directory_projects_real_metadata_sessions_and_unknown_count_without_changing_native(
    legacy, client, admin, settings, db
):
    peer = await create_user(settings, "DirectoryPeer", "Synthetic9Pass", role="user")
    revision = uuid4()
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO user_profiles(user_id,display_name,avatar,revision) VALUES(%s,'Known nickname',%s,%s)",
            (peer, b"SyntheticAvatar", revision),
        )
        await conn.execute(
            "INSERT INTO identity_security(user_id,email_verified,totp_enabled) VALUES(%s,true,true)", (peer,)
        )
    from request_telemetry_tables import business_table_hashes

    async with db.connection() as conn, conn.transaction():
        before = await business_table_hashes(conn)
    response = await legacy.get(P)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["me"] == admin and result["migration"]["recordsCountKnown"] is False
    me = next(row for row in result["users"] if row["id"] == admin)
    row = next(row for row in result["users"] if row["id"] == peer)
    assert me["online"] is True and row["online"] is False
    assert row["nickname"] == "Known nickname" and row["emailVerified"] is True and row["totpEnabled"] is True
    assert row["recordsCount"] is None and row["isTest"] is False
    assert row["avatar"] == f"/api/users/{peer}/avatar?revision={revision}"
    image = await legacy.get(row["avatar"])
    assert image.status_code == 200 and image.content == b"SyntheticAvatar"
    native = await client.get(P)
    assert native.status_code == 200 and "items" in native.json() and "users" not in native.json()
    assert "Synthetic9Pass" not in response.text and "password_hash" not in response.text
    async with db.connection() as conn, conn.transaction():
        assert await business_table_hashes(conn) == before


async def test_legacy_put_requires_explicit_uuid_cas_actor_password_and_returns_original_snapshot(
    legacy, client, admin, settings, db
):
    target = await create_user(settings, "DirectoryPeer", "Synthetic9Pass", role="user")
    assert (await legacy.put(P + "/" + target, json={"username": "ChangedPeer"})).status_code == 422
    command = await body_for(client, target, username="ChangedPeer")
    command["currentPassword"] = command.pop("current_password")
    without = {k: v for k, v in command.items() if k != "currentPassword"}
    assert (await legacy.put(P + "/" + target, json=without)).status_code == 403
    response = await legacy.put(P + "/" + target, json=command)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["user"]["username"] == "ChangedPeer" and result["user"]["nickname"] == ""
    assert result["request_id"] == command["request_id"]
    # Subsequent target edits must not be substituted into an original UUID receipt.
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO user_profiles(user_id,display_name,revision) VALUES(%s,'Later nickname',%s) ON CONFLICT(user_id) DO UPDATE SET display_name='Later nickname'",
            (target, uuid4()),
        )
    changed = await body_for(client, target, username="ChangedAgain")
    assert (await client.patch(P + "/" + target, json=changed)).status_code == 200
    assert (await legacy.put(P + "/" + target, json=command)).json() == result
    original = await legacy.get(P + "/receipts/" + command["request_id"])
    assert original.status_code == 200 and original.json()["user"]["username"] == "ChangedPeer"
    assert (await client.put(P + "/" + target, json=command)).status_code == 405


async def test_legacy_delete_credentials_and_unknown_request_closure_use_same_durable_native_authority(
    legacy, client, admin, settings, db
):
    target = await create_user(settings, "DirectoryPeer", "Synthetic9Pass", role="user")
    original = await body_for(client, target)
    command = {k: original[k] for k in ("request_id", "revision")} | {
        "currentPassword": "Synthetic9Pass",
        "newPassword": "ChangedSynthetic9Pass",
    }
    path = P + "/" + target + "/reset-password"
    changed = await legacy.post(path, json=command)
    assert changed.status_code == 200, changed.text
    assert changed.json()["totpDisabled"] and changed.json()["passkeysRevoked"]
    assert (await legacy.post(path, json=command)).json() == changed.json()
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO identity_security(user_id,totp_enabled) VALUES(%s,true) ON CONFLICT(user_id) DO UPDATE SET totp_enabled=true",
            (target,),
        )
    row = await body_for(client, target)
    disable = {k: row[k] for k in ("request_id", "revision")} | {"currentPassword": "Synthetic9Pass"}
    disabled = await legacy.post(P + "/" + target + "/disable-totp", json=disable)
    assert disabled.status_code == 200 and disabled.json()["totpDisabled"], disabled.text
    delete = await body_for(client, target)
    delete = {k: delete[k] for k in ("request_id", "revision")} | {"currentPassword": "Synthetic9Pass"}
    closed = await legacy.post(
        P + "/receipts/" + delete["request_id"] + "/close", json={"expected_kind": "account-action"}
    )
    assert closed.status_code == 200 and closed.json()["executed"] is False, closed.text
    assert (await legacy.request("DELETE", P + "/" + target, json=delete)).status_code == 409
    delete["request_id"] = str(uuid4())
    removed = await legacy.request("DELETE", P + "/" + target, json=delete)
    assert removed.status_code == 200 and removed.json()["ok"], removed.text
    assert (await legacy.request("DELETE", P + "/" + target, json=delete)).json() == removed.json()
    history = await legacy.get(P + "/receipts")
    assert history.status_code == 200 and any(
        r["request_id"] == delete["request_id"] for r in history.json()["items"]
    )


async def test_explicit_native_binding_cookie_identity_and_scope_rejections_never_fallback(
    legacy, client, admin, app, settings
):
    await create_user(settings, "OrdinaryPeer", "Synthetic9Pass", role="user")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as peer:
        assert (
            await peer.post(
                "/api/auth/login", json={"username": "OrdinaryPeer", "password": "Synthetic9Pass"}
            )
        ).status_code == 200
        assert (await peer.get(P)).status_code == 403
        assert (await peer.put(P + "/" + admin, json={})).status_code == 403
    assert (await legacy.get(P, headers={"authorization": ""})).status_code == 403
    # Frozen old GET does not reject Origin; cookie mutations still enforce it.
    assert (await legacy.get(P, headers={"origin": "https://unapproved.example.invalid"})).status_code == 200
    assert (await client.get(P, headers={"authorization": "Bearer unsupported"})).status_code == 403
    assert (
        await client.patch(
            P + "/" + admin,
            json=await body_for(client, admin),
            headers={"authorization": "Bearer unsupported"},
        )
    ).status_code == 403
    assert (await legacy.get(P, headers={"x-csrf-token": "wrong-native-binding"})).status_code in (401, 403)
    legacy.cookies.set(COOKIE, client.cookies.get(COOKIE))
    explicit = await legacy.get(P, headers={"x-csrf-token": client.headers["x-csrf-token"]})
    assert explicit.status_code == 200 and "items" in explicit.json() and "users" not in explicit.json()
    legacy.cookies.set("stocklog_session", "different-old-session")
    assert (await legacy.get(P)).status_code == 403


async def test_legacy_actor_factor_is_consumed_once_inside_shared_atomic_mutation(
    legacy, client, admin, settings, db
):
    import time

    from alcor_api.connections import Vault
    from alcor_api.native_identity import totp_code

    target = await create_user(settings, "DirectoryPeer", "Synthetic9Pass", role="user")
    secret = "JBSWY3DPEHPK3PXP"
    cipher = Vault(settings.connection_secret_dir).encrypt(secret, "totp:" + admin, settings.instance_id)
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext) VALUES(%s,true,%s)",
            (admin, cipher),
        )
    command = await body_for(client, target, role="admin")
    command["currentPassword"] = command.pop("current_password")
    assert (await legacy.put(P + "/" + target, json=command | {"code": "wrong"})).status_code == 403
    command["code"] = totp_code(secret, int(time.time()))
    changed = await legacy.put(P + "/" + target, json=command)
    assert changed.status_code == 200, changed.text
    assert (await legacy.put(P + "/" + target, json=command | {"code": ""})).json() == changed.json()
    another = await body_for(client, target, role="user")
    another["currentPassword"] = another.pop("current_password")
    assert (await legacy.put(P + "/" + target, json=another | {"code": command["code"]})).status_code == 403
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT role FROM users WHERE id=%s", (target,))).fetchone())[
            "role"
        ] == "admin"


async def test_native_member_binding_does_not_fallback_to_lingering_old_admin_cookie(legacy, app, settings):
    from test_account_admin import login

    await create_user(settings, "OrdinaryPeer", "Synthetic9Pass", role="user")
    native = await login(app, "OrdinaryPeer")
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            headers={"origin": "http://testserver", "x-csrf-token": native.headers["x-csrf-token"]},
            cookies={COOKIE: native.cookies.get(COOKIE), "fire_session": legacy.cookies.get("fire_session")},
        ) as mixed:
            assert (await mixed.get(P)).status_code == 403
            assert (await mixed.put(P + "/anything", json={})).status_code == 403
    finally:
        await native.aclose()


async def test_legacy_put_response_loss_keeps_original_uuid_receipt_not_a_validation_error(
    legacy, client, admin, settings, monkeypatch
):
    from alcor_api import legacy_admin_route

    target = await create_user(settings, "DirectoryPeer", "Synthetic9Pass", role="user")
    command = await body_for(client, target, username="LostReplyPeer")
    command["currentPassword"] = command.pop("current_password")
    original = legacy_admin_route.response

    def fail_reply(value, *args, **kwargs):
        if "changed" in value and "user" in value:
            raise RuntimeError("Synthetic loss after original native commit")
        return original(value, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(legacy_admin_route, "response", fail_reply)
        lost = await legacy.put(P + "/" + target, json=command)
        assert lost.status_code == 503, lost.text
    receipt = await legacy.get(P + "/receipts/" + command["request_id"])
    assert receipt.status_code == 200 and receipt.json()["user"]["username"] == "LostReplyPeer"
    assert (await legacy.put(P + "/" + target, json=command)).status_code == 200


async def test_rejected_admin_factor_audit_survives_rollback_without_secret_or_target_mutation(
    legacy, client, admin, settings, db
):
    target = await create_user(settings, "DirectoryPeer", "Synthetic9Pass", role="user")
    command = await body_for(client, target, role="admin")
    command["currentPassword"] = "WrongSyntheticPassword9"
    command.pop("current_password")
    response = await legacy.put(P + "/" + target, json=command)
    assert response.status_code == 403, response.text
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT role FROM users WHERE id=%s", (target,))).fetchone()
        assert row["role"] == "user"
        assert not await (
            await conn.execute(
                "SELECT 1 FROM account_actions WHERE owner_id=%s AND request_id=%s",
                (admin, command["request_id"]),
            )
        ).fetchone()
        events = await (
            await conn.execute(
                "SELECT actor_id,action,target_id FROM audit_events WHERE action='admin.account_update_rejected'"
            )
        ).fetchall()
        assert events == [{"actor_id": admin, "action": "admin.account_update_rejected", "target_id": target}]
        assert "WrongSyntheticPassword9" not in str(events)


async def test_legacy_delete_keeps_old_four_kib_bound_and_never_deletes_before_validation(
    legacy, client, admin, settings, db
):
    import json

    target = await create_user(settings, "DirectoryPeer", "Synthetic9Pass", role="user")
    row = await body_for(client, target)
    command = {k: row[k] for k in ("request_id", "revision")} | {"currentPassword": "Synthetic9Pass"}
    oversized = json.dumps(command) + " " * 5000
    response = await legacy.request(
        "DELETE", P + "/" + target, content=oversized, headers={"content-type": "application/json"}
    )
    assert response.status_code == 413, response.text
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT deleted_at FROM users WHERE id=%s", (target,))).fetchone())[
            "deleted_at"
        ] is None
        assert not await (
            await conn.execute(
                "SELECT 1 FROM account_actions WHERE owner_id=%s AND request_id=%s",
                (admin, row["request_id"]),
            )
        ).fetchone()
