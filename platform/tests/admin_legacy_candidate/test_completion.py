"""F32 completion boundaries, using frozen old contracts and isolated native authority."""

from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alcor_api import account_admin, legacy_admin_route
from alcor_api.cli import create_user
from alcor_api.security import digest
from test_account_admin import body_for

P = "/api/users"


@pytest_asyncio.fixture
async def legacy(app, admin):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as client:
        assert (
            await client.post("/api/auth/login", json={"username": "AdminOne", "password": "Synthetic9Pass"})
        ).status_code == 200
        yield client


@pytest.mark.parametrize("native", [False, True])
async def test_aged_actor_requires_actual_stepup_then_replays_original_without_renewing_session(
    legacy, client, admin, settings, db, native
):
    target = await create_user(settings, "AgedTarget", "Synthetic9Pass", role="user")
    actor = client if native else legacy
    token = actor.cookies["alcor_session" if native else "fire_session"]
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE sessions SET created_at=clock_timestamp()-interval '16 minutes' WHERE token_hash=%s",
            (digest(token),),
        )
        before = await (
            await conn.execute(
                "SELECT created_at,expires_at FROM sessions WHERE token_hash=%s", (digest(token),)
            )
        ).fetchone()
    command = await body_for(client, target, username="VerifiedAgedTarget")
    without = {key: value for key, value in command.items() if key != "current_password"}
    method = "PATCH" if native else "PUT"
    denied = await actor.request(method, P + "/" + target, json=without)
    assert denied.status_code == 403
    changed = await actor.request(method, P + "/" + target, json=command)
    assert changed.status_code == 200, changed.text
    assert (await actor.request(method, P + "/" + target, json=without)).json() == changed.json()
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT created_at,expires_at FROM sessions WHERE token_hash=%s", (digest(token),)
                )
            ).fetchone()
        ) == before
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM account_actions WHERE owner_id=%s AND request_id=%s",
                    (admin, command["request_id"]),
                )
            ).fetchone()
        )["n"] == 1


async def test_aged_delete_checks_password_in_original_transaction_and_preserves_session_expiry(
    legacy, client, admin, settings, db
):
    target = await create_user(settings, "AgedDeleteTarget", "Synthetic9Pass", role="user")
    token = legacy.cookies["fire_session"]
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE sessions SET created_at=clock_timestamp()-interval '16 minutes' WHERE token_hash=%s",
            (digest(token),),
        )
        before = await (
            await conn.execute(
                "SELECT created_at,expires_at FROM sessions WHERE token_hash=%s", (digest(token),)
            )
        ).fetchone()
    raw = await body_for(client, target)
    command = {key: raw[key] for key in ("request_id", "revision")} | {"currentPassword": "Synthetic9Pass"}
    wrong = await legacy.request(
        "DELETE", P + "/" + target, json=command | {"currentPassword": "WrongSynthetic9Pass"}
    )
    assert wrong.status_code == 403 and wrong.json() == {"error": "管理员密码不正确"}
    assert "x-alcor-retire-context" not in wrong.headers
    removed = await legacy.request("DELETE", P + "/" + target, json=command)
    assert removed.status_code == 200 and removed.json()["ok"], removed.text
    assert (
        await legacy.request(
            "DELETE", P + "/" + target, json=command | {"currentPassword": "WrongSynthetic9Pass"}
        )
    ).json() == removed.json()
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT created_at,expires_at FROM sessions WHERE token_hash=%s", (digest(token),)
                )
            ).fetchone()
        ) == before


async def test_legacy_errors_preserve_old_self_delete_and_disabled_factor_contracts(
    legacy, client, admin, settings
):
    self_delete = await legacy.request("DELETE", P + "/" + admin, json={})
    assert self_delete.status_code == 400 and self_delete.json() == {"error": "不能删除自己的账号"}
    target = await create_user(settings, "DisabledFactorTarget", "Synthetic9Pass", role="user")
    raw = await body_for(client, target)
    command = {key: raw[key] for key in ("request_id", "revision")} | {"currentPassword": "Synthetic9Pass"}
    disabled = await legacy.post(P + "/" + target + "/disable-totp", json=command)
    assert disabled.status_code == 400 and disabled.json() == {"error": "该用户未开启二次验证"}
    headers = legacy_admin_route.response(
        {"error": "Synthetic"}, 403, {"X-Alcor-Reauthentication": "required"}
    )
    assert headers.headers["x-alcor-reauthentication"] == "required"
    assert headers.headers["cache-control"] == "private, no-store"


async def test_directory_rechecks_actor_before_any_private_projection(legacy, db, admin, monkeypatch):
    original = legacy_admin_route.web_identity

    async def revoked(*args, **kwargs):
        result = await original(*args, **kwargs)
        async with db.connection() as conn:
            await conn.execute("UPDATE users SET role='user' WHERE id=%s", (admin,))
        return result

    monkeypatch.setattr(legacy_admin_route, "web_identity", revoked)
    result = await legacy.get(P)
    assert result.status_code == 401 and result.headers["x-alcor-retire-context"] == "true", result.text
    assert "users" not in result.json()


async def test_directory_profile_and_row_share_one_snapshot(legacy, settings, db, monkeypatch):
    target = await create_user(settings, "SnapshotTarget", "Synthetic9Pass", role="user")
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO user_profiles(user_id,display_name,revision) VALUES(%s,'Before profile',%s)",
            (target, uuid4()),
        )
    original = legacy_admin_route.public_profiles

    async def changed(conn, identifiers):
        async with db.connection() as writer:
            await writer.execute(
                "UPDATE user_profiles SET display_name='After profile',revision=gen_random_uuid() WHERE user_id=%s",
                (target,),
            )
        return await original(conn, identifiers)

    monkeypatch.setattr(legacy_admin_route, "public_profiles", changed)
    result = await legacy.get(P)
    assert result.status_code == 200, result.text
    assert next(row for row in result.json()["users"] if row["id"] == target)["nickname"] == "Before profile"
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT display_name FROM user_profiles WHERE user_id=%s", (target,))
            ).fetchone()
        )["display_name"] == "After profile"


async def test_directory_shared_authority_rejects_stale_native_actor(client, admin, db, monkeypatch):
    original = account_admin.user_directory

    async def stale(database, who, **kwargs):
        async with db.connection() as conn:
            await conn.execute("DELETE FROM sessions WHERE token_hash=%s", (who.token_hash,))
        return await original(database, who, **kwargs)

    monkeypatch.setattr(account_admin, "user_directory", stale)
    result = await client.get(P)
    assert result.status_code == 401, result.text


@pytest.mark.parametrize(
    "password,message",
    [("a1", "密码至少 8 位"), ("a1" * 65, "密码最多 128 位"), ("noDigitsHere", "密码需同时包含字母和数字")],
)
async def test_old_password_validation_messages_do_not_mutate_target(
    legacy, client, settings, db, password, message
):
    target = await create_user(settings, "WeakPasswordTarget", "Synthetic9Pass", role="user")
    raw = await body_for(client, target)
    command = {key: raw[key] for key in ("request_id", "revision")} | {
        "currentPassword": "Synthetic9Pass",
        "newPassword": password,
    }
    result = await legacy.post(P + "/" + target + "/reset-password", json=command)
    assert result.status_code == 400 and result.json() == {"error": message}
    async with db.connection() as conn:
        assert (
            str(
                (await (await conn.execute("SELECT revision FROM users WHERE id=%s", (target,))).fetchone())[
                    "revision"
                ]
            )
            == command["revision"]
        )
        assert not await (
            await conn.execute("SELECT 1 FROM account_actions WHERE request_id=%s", (command["request_id"],))
        ).fetchone()


async def test_old_reset_accepts_utf16_password_vector_and_shared_hash(legacy, client, settings, db):
    from alcor_api.passwords import verify_password

    target = await create_user(settings, "Utf16PasswordTarget", "Synthetic9Pass", role="user")
    raw = await body_for(client, target)
    password = "A1😀😀😀"  # Eight UTF-16 units, as the frozen Node validator measures them.
    command = {key: raw[key] for key in ("request_id", "revision")} | {
        "currentPassword": "Synthetic9Pass",
        "newPassword": password,
    }
    result = await legacy.post(P + "/" + target + "/reset-password", json=command)
    assert result.status_code == 200 and result.json()["totpDisabled"] and result.json()["passkeysRevoked"], (
        result.text
    )
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT password_hash FROM users WHERE id=%s", (target,))).fetchone()
        assert verify_password(password, row["password_hash"])


@pytest.mark.parametrize("history", [False, True])
async def test_receipt_queries_revalidate_actor_after_protocol_auth(
    legacy, client, admin, settings, db, monkeypatch, history
):
    target = await create_user(settings, "ReceiptScopeTarget", "Synthetic9Pass", role="user")
    command = await body_for(client, target, username="ChangedScopeTarget")
    assert (await legacy.put(P + "/" + target, json=command)).status_code == 200
    original = legacy_admin_route.web_identity

    async def revoked(*args, **kwargs):
        result = await original(*args, **kwargs)
        async with db.connection() as conn:
            await conn.execute("DELETE FROM sessions WHERE token_hash=%s", (result[0].token_hash,))
        return result

    monkeypatch.setattr(legacy_admin_route, "web_identity", revoked)
    path = P + "/receipts" + ("" if history else "/" + command["request_id"])
    result = await legacy.get(path)
    assert result.status_code == 401 and result.headers["x-alcor-retire-context"] == "true"
    assert "ChangedScopeTarget" not in result.text


async def test_web_session_bearer_priority_scope_proof_replay_and_expiry(
    legacy, client, admin, settings, app, db
):
    from alcor_api.native_app_auth import issue_grant
    from alcor_api.security import COOKIE

    target = await create_user(settings, "BearerTarget", "Synthetic9Pass", role="user")
    admin_token = legacy.cookies["fire_session"]
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (admin,))).fetchone()
        grant = await issue_grant(
            conn, user, "portfolio.read security.read security.write", "Synthetic admin scope denial"
        )
        old_app_token = "d" * 64
        await conn.execute(
            "INSERT INTO sessions(token_hash,user_id,client_id,session_version,expires_at) VALUES(%s,%s,'legacy-v1',%s,clock_timestamp()+interval '1 hour')",
            (digest(old_app_token), admin, user["session_version"]),
        )
        before = await (
            await conn.execute(
                "SELECT created_at,expires_at FROM sessions WHERE token_hash=%s", (digest(admin_token),)
            )
        ).fetchone()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as peer:
        headers = {"authorization": "Bearer  " + admin_token + " "}
        directory = await peer.get(P, headers=headers)
        assert directory.status_code == 200 and directory.json()["me"] == admin, directory.text
        command = await body_for(client, target, username="BearerChangedTarget")
        saved = await peer.put(
            P + "/" + target, json=command, headers=headers | {"origin": "https://other.invalid"}
        )
        assert saved.status_code == 200, saved.text
        assert (await peer.put(P + "/" + target, json=command, headers=headers)).json() == saved.json()
        assert (await peer.get(P + "/receipts/" + command["request_id"], headers=headers)).status_code == 200
        for token in (client.cookies[COOKIE], old_app_token, grant["access_token"]):
            denied = await peer.get(P, headers={"authorization": "Bearer " + token})
            assert denied.status_code in (401, 403) and "users" not in denied.json()
        assert (
            await peer.get(P, headers=headers | {"x-csrf-token": "pretend-native-binding"})
        ).status_code in (401, 403)
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT created_at,expires_at FROM sessions WHERE token_hash=%s", (digest(admin_token),)
                )
            ).fetchone()
        ) == before
        await conn.execute("UPDATE users SET role='user' WHERE id=%s", (admin,))
    assert (await legacy.get(P, headers={"authorization": "Bearer " + admin_token})).status_code == 403


async def test_bearer_member_or_expired_web_identity_never_inherits_cookie_admin(legacy, settings, app, db):
    await create_user(settings, "BearerMember", "Synthetic9Pass", role="user")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as peer:
        assert (
            await peer.post(
                "/api/auth/login", json={"username": "BearerMember", "password": "Synthetic9Pass"}
            )
        ).status_code == 200
        token = peer.cookies["fire_session"]
    denied = await legacy.get(P, headers={"authorization": "Bearer " + token})
    assert denied.status_code == 403 and denied.headers["x-alcor-retire-context"] == "true"
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=%s",
            (digest(token),),
        )
    expired = await legacy.get(P, headers={"authorization": "Bearer " + token})
    assert expired.status_code == 401 and expired.headers["x-alcor-retire-context"] == "true"
    # A live browser administrator cookie cannot rescue an explicit invalid identity.
    assert (await legacy.get(P, headers={"authorization": "Bearer " + "f" * 64})).status_code == 401
    assert (await legacy.get(P)).status_code == 200


async def test_legacy_cookie_mutations_allow_missing_origin_but_reject_cross_site(legacy, client, settings):
    target = await create_user(settings, "CookieOriginTarget", "Synthetic9Pass", role="user")
    command = await body_for(client, target, username="CookieOriginChanged")
    blocked = await legacy.put(P + "/" + target, json=command, headers={"origin": "https://other.invalid"})
    assert blocked.status_code == 401 and blocked.json() == {"error": "未登录"}
    legacy.headers.pop("origin")
    cross_site = await legacy.put(P + "/" + target, json=command, headers={"sec-fetch-site": "cross-site"})
    assert cross_site.status_code == 401
    allowed = await legacy.put(P + "/" + target, json=command)
    assert allowed.status_code == 200, allowed.text


@pytest.mark.parametrize("action", ["put", "delete", "reset", "disable"])
async def test_all_old_mutations_honor_closed_original_uuid_without_late_execution(
    legacy, client, settings, db, action
):
    target = await create_user(settings, "ClosedActionTarget", "Synthetic9Pass", role="user")
    raw = await body_for(client, target, username="MustNeverApply")
    closed = await legacy.post(
        P + "/receipts/" + raw["request_id"] + "/close", json={"expected_kind": "account-action"}
    )
    assert closed.status_code == 200 and not closed.json()["executed"]
    base = {key: raw[key] for key in ("request_id", "revision")} | {"currentPassword": "Synthetic9Pass"}
    if action == "put":
        result = await legacy.put(
            P + "/" + target,
            json={key: value for key, value in raw.items() if key != "current_password"} | base,
        )
    elif action == "delete":
        result = await legacy.request("DELETE", P + "/" + target, json=base)
    else:
        result = await legacy.post(
            P + "/" + target + ("/reset-password" if action == "reset" else "/disable-totp"),
            json=base | ({"newPassword": "ChangedSynthetic9Pass"} if action == "reset" else {}),
        )
    assert result.status_code == 409 and "原账号操作已关闭" in result.text
    async with db.connection() as conn:
        row = await (
            await conn.execute("SELECT username,revision,deleted_at FROM users WHERE id=%s", (target,))
        ).fetchone()
        assert (
            row["username"] == "ClosedActionTarget"
            and str(row["revision"]) == raw["revision"]
            and row["deleted_at"] is None
        )


@pytest.mark.parametrize("action", ["put", "delete", "reset", "disable"])
async def test_concurrent_old_uuid_mutations_consume_one_real_backup_factor(
    legacy, client, admin, settings, app, db, action
):
    import asyncio

    from alcor_api.connections import Vault
    from psycopg.types.json import Jsonb

    target = await create_user(settings, "ConcurrentTarget", "Synthetic9Pass", role="user")
    codes, key, hashes = app.state.identity_management.codes()
    vault = Vault(settings.connection_secret_dir)
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext,backup_codes,backup_key_ciphertext) VALUES(%s,true,%s,%s,%s)",
            (
                admin,
                vault.encrypt("JBSWY3DPEHPK3PXP", "totp:" + admin, settings.instance_id),
                Jsonb(hashes),
                vault.encrypt(key.hex(), "backup-key:" + admin, settings.instance_id),
            ),
        )
        if action == "disable":
            await conn.execute(
                "INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext) VALUES(%s,true,%s)",
                (target, vault.encrypt("JBSWY3DPEHPK3PXP", "totp:" + target, settings.instance_id)),
            )
    raw = await body_for(client, target, username="ConcurrentChanged")
    base = {key: raw[key] for key in ("request_id", "revision")} | {
        "currentPassword": "Synthetic9Pass",
        "code": codes[0],
    }
    if action == "put":
        method, path, command = (
            "PUT",
            P + "/" + target,
            {key: value for key, value in raw.items() if key != "current_password"} | base,
        )
    elif action == "delete":
        method, path, command = "DELETE", P + "/" + target, base
    else:
        method, path = (
            "POST",
            P + "/" + target + ("/reset-password" if action == "reset" else "/disable-totp"),
        )
        command = base | ({"newPassword": "ChangedSynthetic9Pass"} if action == "reset" else {})
    responses = await asyncio.gather(*(legacy.request(method, path, json=command) for _ in range(4)))
    assert all(result.status_code == 200 for result in responses), [result.text for result in responses]
    assert all(result.json() == responses[0].json() for result in responses)
    async with db.connection() as conn:
        remaining = (
            await (
                await conn.execute("SELECT backup_codes FROM identity_security WHERE user_id=%s", (admin,))
            ).fetchone()
        )["backup_codes"]
        assert len(remaining) == 7
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM account_actions WHERE owner_id=%s AND request_id=%s",
                    (admin, base["request_id"]),
                )
            ).fetchone()
        )["n"] == 1


@pytest.mark.parametrize("native", [False, True])
async def test_partial_patch_preserves_role_active_and_cas_without_inferred_grants(
    legacy, client, settings, db, native
):
    target = await create_user(settings, "PartialTarget", "Synthetic9Pass", role="user")
    raw = await body_for(client, target)
    command = {key: raw[key] for key in ("request_id", "revision")} | {
        "username": "PartialRenamed",
        "currentPassword" if not native else "current_password": "Synthetic9Pass",
    }
    actor, method = (client, "PATCH") if native else (legacy, "PUT")
    changed = await actor.request(method, P + "/" + target, json=command)
    assert changed.status_code == 200 and changed.json()["user"]["username"] == "PartialRenamed", changed.text
    assert changed.json()["user"]["role"] == "user"
    async with db.connection() as conn:
        row = await (
            await conn.execute("SELECT role,active,username FROM users WHERE id=%s", (target,))
        ).fetchone()
        assert row == {"role": "user", "active": True, "username": "PartialRenamed"}
    assert (await actor.request(method, P + "/" + target, json=command)).json() == changed.json()
    # A different original UUID cannot silently apply a stale partial draft.
    stale = await actor.request(
        method,
        P + "/" + target,
        json=command | {"request_id": str(uuid4()), "email": "different@example.invalid"},
    )
    assert stale.status_code == 409


@pytest.mark.parametrize(
    "patch", [{"role": None}, {"active": None}, {"role": "superadmin"}, {"active": "true"}]
)
async def test_partial_patch_rejects_explicit_null_or_implicit_privilege_types(
    legacy, client, settings, db, patch
):
    target = await create_user(settings, "PartialTypeTarget", "Synthetic9Pass", role="user")
    raw = await body_for(client, target)
    command = {key: raw[key] for key in ("request_id", "revision")} | {
        "currentPassword": "Synthetic9Pass",
        **patch,
    }
    result = await legacy.put(P + "/" + target, json=command)
    assert result.status_code in (400, 422), result.text
    async with db.connection() as conn:
        assert (
            await (await conn.execute("SELECT role,active FROM users WHERE id=%s", (target,))).fetchone()
        ) == {"role": "user", "active": True}
        assert not await (
            await conn.execute("SELECT 1 FROM account_actions WHERE request_id=%s", (command["request_id"],))
        ).fetchone()


async def test_partial_last_admin_demotion_is_protected_and_missing_stepup_never_changes_fields(
    legacy, client, admin, settings
):
    raw = await body_for(client, admin)
    demotion = {key: raw[key] for key in ("request_id", "revision")} | {
        "role": "user",
        "currentPassword": "Synthetic9Pass",
    }
    result = await legacy.put(P + "/" + admin, json=demotion)
    assert result.status_code == 409 and "管理员" in result.text
    target = await create_user(settings, "PartialNoProof", "Synthetic9Pass", role="user")
    raw = await body_for(client, target)
    command = {key: raw[key] for key in ("request_id", "revision")} | {"username": "NoProofMustNotApply"}
    denied = await legacy.put(P + "/" + target, json=command)
    assert denied.status_code == 403 and denied.json() == {"error": "管理员密码不正确"}


async def test_missing_historical_target_redacts_private_immutable_snapshot_in_both_protocols(
    legacy, client, admin, settings, db
):
    from psycopg.types.json import Jsonb

    missing = "historical-target-not-restored"
    identifier = str(uuid4())
    snapshot = {
        "request_id": identifier,
        "user": {
            "id": missing,
            "username": "UnavailablePrivateName",
            "email": "unavailable-private@example.invalid",
        },
        "profile": {
            "id": missing,
            "nickname": "UnavailablePrivateNickname",
            "avatar": "/private/historical/path",
        },
        "changed": True,
    }
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO account_actions(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
            (admin, identifier, "a" * 64, Jsonb(snapshot)),
        )
        assert not await (await conn.execute("SELECT 1 FROM users WHERE id=%s", (missing,))).fetchone()
    for actor in (client, legacy):
        response = await actor.get(P + "/receipts/" + identifier)
        assert response.status_code == 200, response.text
        result = response.json()
        assert (
            result["snapshot_state"] == "redacted_target_unavailable"
            and result["redacted"] is True
            and result["retired"] is None
        )
        assert result["user"] == {"id": missing, "uid": None, "active": None, "deleted": None}
        assert (
            "UnavailablePrivate" not in response.text
            and "unavailable-private@" not in response.text
            and "/private/historical/path" not in response.text
        )
        history = await actor.get(P + "/receipts")
        assert history.status_code == 200 and history.json()["items"][0]["result"] == result
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT result FROM account_actions WHERE owner_id=%s AND request_id=%s",
                    (admin, identifier),
                )
            ).fetchone()
        )["result"] == snapshot
