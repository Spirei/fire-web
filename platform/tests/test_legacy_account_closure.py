"""Synthetic self-closure integration tests in identity-checked private PG instances."""

import asyncio
import time

import httpx
import pytest
from alcor_api.cli import create_user
from alcor_api.legacy_account_closure import PATH
from alcor_api.native_app_auth import issue_grant
from alcor_api.native_identity import totp_code

PASSWORD = "SyntheticClosure9Pass"


async def member(client, settings):
    await create_user(settings, "ClosureAdmin", PASSWORD, role="admin")
    uid = await create_user(settings, "ClosureMember", PASSWORD, role="user")
    result = await client.post("/api/auth/login", json={"username": "ClosureMember", "password": PASSWORD})
    assert result.status_code == 200, result.text
    return uid


async def test_cookie_closure_revokes_all_identity_and_keeps_financial_owner(client, settings, db):
    uid = await member(client, settings)
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
        grant = await issue_grant(conn, user, "portfolio.read", "Synthetic closure device")
        await conn.execute(
            "INSERT INTO portfolio_records(owner_id,id,name,code,market,qty,cost) VALUES(%s,'preserved-position','Synthetic holding','SYN','US',2,15)",
            (uid,),
        )
        original = await (
            await conn.execute("SELECT * FROM portfolio_records WHERE owner_id=%s", (uid,))
        ).fetchone()
    tag_result = await client.put(
        "/api/cards/tags", json={"cardKey": "private-card", "tags": ["Private label"]}
    )
    assert tag_result.status_code == 200, tag_result.text
    card_receipt = tag_result.headers["x-alcor-request-id"]
    assert (
        await client.put("/api/cards/holdings", json={"cardKey": "private-card", "held": True})
    ).status_code == 200
    result = await client.post(PATH, json={"password": PASSWORD})
    assert result.status_code == 200 and result.json() == {"ok": True}, result.text
    assert result.headers["cache-control"] == "no-store"
    assert (await client.get("/api/auth/me")).status_code == 401
    assert (
        await client.get("/api/v2/auth/me", headers={"authorization": "Bearer " + grant["access_token"]})
    ).status_code == 401
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
        assert user["deleted_at"] and not user["active"] and user["password_hash"] == ""
        assert (
            await (await conn.execute("SELECT * FROM portfolio_records WHERE owner_id=%s", (uid,))).fetchone()
        ) == original
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM audit_events WHERE actor_id=%s AND action='account.closed'",
                    (uid,),
                )
            ).fetchone()
        )["n"] == 1
        assert (
            await (
                await conn.execute("SELECT result FROM account_actions WHERE owner_id=%s", (uid,))
            ).fetchone()
        )["result"]["deleted"] is True
    for path in ("/api/cards/tags", "/api/cards/holdings", "/api/cards/operations/" + card_receipt):
        assert (await client.get(path)).status_code == 401
    async with db.connection() as conn:
        for table in (
            "card_preference_operations",
            "card_preference_tags",
            "card_preference_holdings",
            "card_preference_collections",
        ):
            assert not await (
                await conn.execute("SELECT 1 FROM " + table + " WHERE owner_id=%s", (uid,))
            ).fetchone()
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM audit_events WHERE actor_id=%s AND action='cards.tags.updated'",
                    (uid,),
                )
            ).fetchone()
        )["n"] == 1
    again = await client.post(PATH, json={"password": PASSWORD})
    assert again.status_code == 401 and again.json() == {"error": "未登录"}


async def test_last_admin_and_wrong_password_do_not_retire(client, settings, db):
    uid = await create_user(settings, "ClosureAdmin", PASSWORD, role="admin")
    await client.post("/api/auth/login", json={"username": "ClosureAdmin", "password": PASSWORD})
    wrong = await client.post(PATH, json={"password": "Incorrect9Password"})
    assert wrong.status_code == 403 and wrong.json() == {"error": "当前密码错误"}
    last = await client.post(PATH, json={"password": PASSWORD})
    assert last.status_code == 400 and last.json() == {"error": "不能删除最后一个管理员账号"}
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT active FROM users WHERE id=%s", (uid,))).fetchone())[
            "active"
        ]
        assert not await (
            await conn.execute("SELECT 1 FROM account_actions WHERE owner_id=%s", (uid,))
        ).fetchone()


async def test_totp_failure_and_last_admin_rollback_do_not_consume_backup(client, settings, db):
    uid = await member(client, settings)
    setup = (await client.post("/api/auth/totp")).json()
    enabled = await client.put("/api/auth/totp", json={"code": totp_code(setup["secret"], int(time.time()))})
    codes = enabled.json()["backupCodes"]
    bad = await client.post(PATH, json={"password": PASSWORD, "code": "invalid"})
    assert bad.status_code == 403 and bad.json() == {"error": "二次验证失败"}
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET role='admin' WHERE id=%s", (uid,))
        await conn.execute("UPDATE users SET active=false WHERE username='ClosureAdmin'")
    last = await client.post(PATH, json={"password": PASSWORD, "code": codes[0]})
    assert last.status_code == 400
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET role='user' WHERE id=%s", (uid,))
    good = await client.post(PATH, json={"password": PASSWORD, "code": codes[0]})
    assert good.status_code == 200, good.text


@pytest.mark.parametrize("mode", ["legacy-bearer", "native-grant"])
async def test_explicit_bearer_and_concurrent_closure(client, settings, db, app, mode):
    uid = await member(client, settings)
    token = client.cookies["fire_session"]
    if mode == "native-grant":
        async with db.connection() as conn:
            user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (uid,))).fetchone()
            token = (await issue_grant(conn, user, "portfolio.read", "Synthetic closure device"))[
                "access_token"
            ]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as peer:
        results = await asyncio.gather(
            *[
                peer.post(PATH, json={"password": PASSWORD}, headers={"authorization": "Bearer " + token})
                for _ in range(2)
            ]
        )
    assert sorted(result.status_code for result in results) == (
        [200, 401] if mode == "legacy-bearer" else [401, 401]
    )
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT count(*) AS n FROM account_actions WHERE owner_id=%s", (uid,))
            ).fetchone()
        )["n"] == (1 if mode == "legacy-bearer" else 0)


async def test_origin_new_web_and_rate_limit_boundaries(client, settings, db, app):
    uid = await member(client, settings)
    denied = await client.post(PATH, json={"password": PASSWORD}, headers={"origin": "https://other.invalid"})
    assert denied.status_code == 401 and denied.json() == {"error": "未登录"}
    for _ in range(5):
        assert (await client.post(PATH, json={"password": "wrong"})).status_code == 403
    limited = await client.post(PATH, json={"password": PASSWORD})
    assert limited.status_code == 429
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT active FROM users WHERE id=%s", (uid,))).fetchone())[
            "active"
        ]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as peer:
        await peer.post("/api/session/login", json={"login": "ClosureMember", "password": PASSWORD})
        denied = await peer.post(PATH, json={"password": PASSWORD})
        assert denied.status_code == 401


async def test_concurrent_admin_closures_leave_one_active_admin(client, settings, db, app):
    await create_user(settings, "ClosureAdminA", PASSWORD, role="admin")
    await create_user(settings, "ClosureAdminB", PASSWORD, role="admin")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as peer:
        await client.post("/api/auth/login", json={"username": "ClosureAdminA", "password": PASSWORD})
        await peer.post("/api/auth/login", json={"username": "ClosureAdminB", "password": PASSWORD})
        results = await asyncio.gather(
            client.post(PATH, json={"password": PASSWORD}), peer.post(PATH, json={"password": PASSWORD})
        )
    assert sorted(result.status_code for result in results) == [200, 400]
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM users WHERE active AND role='admin' AND deleted_at IS NULL"
                )
            ).fetchone()
        )["n"] == 1
        assert (
            await (
                await conn.execute("SELECT count(*) AS n FROM audit_events WHERE action='account.closed'")
            ).fetchone()
        )["n"] == 1


async def test_internal_failure_rolls_back_retirement_and_hides_details(client, settings, db, monkeypatch):
    from alcor_api import legacy_account_closure

    uid = await member(client, settings)
    original = legacy_account_closure.retire_account

    async def failed(*args, **kwargs):
        await original(*args, **kwargs)
        raise RuntimeError("synthetic-private-internal-detail")

    monkeypatch.setattr(legacy_account_closure, "retire_account", failed)
    result = await client.post(PATH, json={"password": PASSWORD})
    assert result.status_code == 500 and result.json() == {"error": "账号注销失败，请稍后再试"}
    assert result.headers["cache-control"] == "no-store"
    assert (await client.get("/api/auth/me")).status_code == 200
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT active FROM users WHERE id=%s", (uid,))).fetchone())[
            "active"
        ]
        assert not await (
            await conn.execute("SELECT 1 FROM account_actions WHERE owner_id=%s", (uid,))
        ).fetchone()


@pytest.mark.parametrize("damage", ["missing-table", "missing-migration-marker"])
async def test_card_schema_inconsistency_aborts_entire_retirement(client, settings, db, damage):
    uid = await member(client, settings)
    assert (
        await client.put("/api/cards/tags", json={"cardKey": "retained-private", "tags": ["Keep"]})
    ).status_code == 200
    async with db.connection() as conn:
        if damage == "missing-table":
            await conn.execute("DROP TABLE card_preference_holdings")
        else:
            marker = await (
                await conn.execute("SELECT * FROM schema_migrations WHERE name='0080_card_preferences.sql'")
            ).fetchone()
            await conn.execute("DELETE FROM schema_migrations WHERE name='0080_card_preferences.sql'")
    failed = await client.post(PATH, json={"password": PASSWORD})
    assert failed.status_code in (500, 503), failed.text
    if damage == "missing-migration-marker":
        # Restore the deliberate fixture corruption via its same isolated pool;
        # normal connections correctly reject the mismatched schema identity.
        async with db.pool.connection() as conn:
            await conn.execute(
                "INSERT INTO schema_migrations(name,sha256,applied_at) VALUES(%s,%s,%s)",
                (marker["name"], marker["sha256"], marker["applied_at"]),
            )
    assert (await client.get("/api/auth/me")).status_code == 200
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT active FROM users WHERE id=%s", (uid,))).fetchone())[
            "active"
        ]
        assert not await (
            await conn.execute("SELECT 1 FROM account_actions WHERE owner_id=%s", (uid,))
        ).fetchone()
        assert (
            await (
                await conn.execute("SELECT tags FROM card_preference_tags WHERE owner_id=%s", (uid,))
            ).fetchone()
        )["tags"] == ["Keep"]


async def test_retirement_redacts_other_actor_receipts_and_marks_replays(client, admin, settings, app, db):
    from test_account_admin import body_for

    uid = await create_user(
        settings, "ReceiptPrivate", "Synthetic9Pass", role="user", email="private@example.invalid"
    )
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO user_profiles(user_id,display_name,revision) VALUES(%s,'Private Receipt Nickname',gen_random_uuid())",
            (uid,),
        )
    await create_user(settings, "OtherReceiptAdmin", "Synthetic9Pass", role="admin")
    command = await body_for(client, uid, username="ChangedPrivate")
    changed = await client.patch("/api/users/" + uid, json=command)
    assert changed.status_code == 200 and "private@example.invalid" in changed.text, changed.text
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as legacy_admin:
        assert (
            await legacy_admin.post(
                "/api/auth/login", json={"username": "OtherReceiptAdmin", "password": "Synthetic9Pass"}
            )
        ).status_code == 200
        # A second actor's receipt must be scrubbed too, without changing the
        # target identity, request UUID, fingerprint, or original changed fields.
        legacy_command = await body_for(client, uid, username="LaterPrivate")
        translated = dict(legacy_command)
        translated["currentPassword"] = translated.pop("current_password")
        legacy_changed = await legacy_admin.put("/api/users/" + uid, json=translated)
        assert legacy_changed.status_code == 200, legacy_changed.text
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as owner:
            assert (
                await owner.post(
                    "/api/auth/login", json={"username": "LaterPrivate", "password": "Synthetic9Pass"}
                )
            ).status_code == 200
            assert (await owner.post(PATH, json={"password": "Synthetic9Pass"})).status_code == 200
        receipts = [
            await client.get("/api/users/receipts/" + command["request_id"]),
            await legacy_admin.get("/api/users/receipts/" + legacy_command["request_id"]),
        ]
        assert (await client.get("/api/users/receipts/" + legacy_command["request_id"])).status_code == 404
        assert (await legacy_admin.get("/api/users/receipts/" + command["request_id"])).status_code == 404
        histories = [await client.get("/api/users/receipts"), await legacy_admin.get("/api/users/receipts")]
        for history in histories:
            assert history.status_code == 200
            assert history.json()["items"][0]["result"]["redacted"] is True
        native_replay = await client.patch("/api/users/" + uid, json=command)
        legacy_replay = await legacy_admin.put("/api/users/" + uid, json=translated)
        assert native_replay.status_code == legacy_replay.status_code == 200
        for result in [*receipts, native_replay, legacy_replay]:
            assert (
                result.status_code == 200
                and result.json()["redacted"] is True
                and result.json()["retired"] is True
            )
            assert result.json()["snapshot_state"] == "redacted_after_retirement"
            assert result.json()["user"]["id"] == uid
            for private in (
                "ReceiptPrivate",
                "ChangedPrivate",
                "LaterPrivate",
                "private@example.invalid",
                "Private Receipt Nickname",
            ):
                assert private not in result.text
        assert native_replay.json()["request_id"] == command["request_id"]
        async with db.connection() as conn:
            original_receipts = await (
                await conn.execute("SELECT result FROM account_actions WHERE result#>>'{user,id}'=%s", (uid,))
            ).fetchall()
            assert len(original_receipts) == 2
            assert all("redacted" not in row["result"] for row in original_receipts)
            assert any("private@example.invalid" in str(row["result"]) for row in original_receipts)
            assert (
                await (
                    await conn.execute(
                        "SELECT count(*) AS n FROM audit_events WHERE target_id=%s AND action='account.updated'",
                        (uid,),
                    )
                ).fetchone()
            )["n"] == 2
