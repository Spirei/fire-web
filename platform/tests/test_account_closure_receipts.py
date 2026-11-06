"""Only identity-verified private PG fixtures; never a real account or provider."""

import asyncio
import secrets
from uuid import uuid4

import httpx
import pytest_asyncio
from alcor_api.account_closure import capability_hash
from alcor_api.cli import create_user
from alcor_api.native_app_auth import issue_grant
from alcor_api.security import digest
from test_account_admin import login

ROOT = "/api/account/closure"
PASSWORD = "Synthetic9Pass"


@pytest_asyncio.fixture
async def ordinary(admin, settings, app):
    owner = await create_user(settings, "ClosureMember", PASSWORD, role="user")
    peer = await login(app, "ClosureMember")
    yield peer, owner
    await peer.aclose()


async def command(peer):
    own = (await peer.get("/api/account")).json()
    return {
        "request_id": str(uuid4()),
        "revision": own["revision"],
        "receipt_token": "acr_" + secrets.token_urlsafe(32),
    }


async def confirm(peer, data, **patch):
    return await peer.post("/api/account/close", json=data | {"current_password": PASSWORD} | patch)


async def public(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    )


async def test_member_prepares_then_closes_and_queries_after_all_sessions_revoked_keeps_finance(
    ordinary, db, settings, app
):
    peer, owner = ordinary
    data = await command(peer)
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (owner,))).fetchone()
        grant = await issue_grant(conn, user, "portfolio.read", "Synthetic closure device")
        await conn.execute(
            "INSERT INTO portfolio_records(owner_id,id,name,code,market,qty,cost) VALUES(%s,'preserved','Synthetic holding','SYN','US',2,15)",
            (owner,),
        )
        finance = await (
            await conn.execute("SELECT * FROM portfolio_records WHERE owner_id=%s", (owner,))
        ).fetchone()
        session = await (
            await conn.execute(
                "SELECT * FROM sessions WHERE token_hash=%s", (digest(peer.cookies["alcor_session"]),)
            )
        ).fetchone()
    prepared = await peer.post(ROOT + "/prepare", json=data)
    assert prepared.status_code == 200 and prepared.json()["state"] == "prepared", prepared.text
    assert data["receipt_token"] not in prepared.text and "user_id" not in prepared.json()
    assert (await peer.post(ROOT + "/prepare", json=data)).json() == prepared.json()
    async with db.connection() as conn:
        stored = await (
            await conn.execute("SELECT * FROM account_closure_intents WHERE owner_id=%s", (owner,))
        ).fetchone()
        assert stored["token_hash"] == capability_hash(settings.instance_id, data["receipt_token"])
        assert data["receipt_token"] not in str(stored)
        assert (
            await (
                await conn.execute("SELECT * FROM sessions WHERE token_hash=%s", (session["token_hash"],))
            ).fetchone()
            == session
        )
    result = await confirm(peer, data)
    assert result.status_code == 200 and result.json()["deleted"] is True, result.text
    assert (await peer.get("/api/session")).status_code == 401
    async with await public(app) as anonymous:
        observed = await anonymous.post(
            ROOT + "/" + data["request_id"] + "/receipt", json={"receipt_token": data["receipt_token"]}
        )
        assert observed.status_code == 200 and observed.json() == {
            "request_id": data["request_id"],
            "state": "completed",
            "scope": "account-closure-only",
            "deleted": True,
        }, observed.text
        assert observed.headers["cache-control"] == "no-store"
        assert (
            await anonymous.post(
                ROOT + "/" + data["request_id"] + "/close", json={"receipt_token": data["receipt_token"]}
            )
        ).json() == observed.json()
        assert (
            await anonymous.get("/api/users", headers={"authorization": "Bearer " + data["receipt_token"]})
        ).status_code == 401
        assert (
            await anonymous.get(
                "/api/client/profile", headers={"authorization": "Bearer " + grant["access_token"]}
            )
        ).status_code == 401
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT * FROM portfolio_records WHERE owner_id=%s", (owner,))
            ).fetchone()
            == finance
        )
        assert not await (await conn.execute("SELECT 1 FROM sessions WHERE user_id=%s", (owner,))).fetchone()
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM audit_events WHERE target_id=%s AND action='account.closed'",
                    (owner,),
                )
            ).fetchone()
        )["n"] == 1


async def test_owner_abort_can_precede_unknown_prepare_and_blocks_late_original(ordinary, db):
    peer, owner = ordinary
    data = await command(peer)
    first = await peer.post(ROOT + "/abort", json=data)
    assert first.status_code == 200 and first.json()["executed"] is False, first.text
    late = await peer.post(ROOT + "/prepare", json=data)
    assert late.status_code == 200 and late.json()["state"] == "closed" and late.json()["executed"] is False
    assert (await confirm(peer, data)).status_code == 409
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT active FROM users WHERE id=%s", (owner,))).fetchone())[
            "active"
        ]
        assert (
            await (
                await conn.execute(
                    "SELECT closed FROM account_actions WHERE owner_id=%s AND request_id=%s",
                    (owner, data["request_id"]),
                )
            ).fetchone()
        )["closed"]


async def test_prepare_vs_abort_and_confirm_vs_close_are_serialized_original_uuid_races(ordinary, db, app):
    peer, owner = ordinary
    data = await command(peer)
    prepared, aborted = await asyncio.gather(
        peer.post(ROOT + "/prepare", json=data), peer.post(ROOT + "/abort", json=data)
    )
    assert prepared.status_code == aborted.status_code == 200
    assert (await confirm(peer, data)).status_code == 409
    # A second explicit operation is legal only after the first UUID is terminal.
    data = await command(peer)
    assert (await peer.post(ROOT + "/prepare", json=data)).status_code == 200
    async with await public(app) as anonymous:
        accepted, closed = await asyncio.gather(
            confirm(peer, data),
            anonymous.post(
                ROOT + "/" + data["request_id"] + "/close", json={"receipt_token": data["receipt_token"]}
            ),
        )
        assert closed.status_code == 200, closed.text
        assert (accepted.status_code == 200 and closed.json()["state"] == "completed") or (
            accepted.status_code == 409 and closed.json()["state"] == "closed"
        )
    async with db.connection() as conn:
        current = await (await conn.execute("SELECT active FROM users WHERE id=%s", (owner,))).fetchone()
        assert current["active"] is (closed.json()["state"] == "closed")


async def test_wrong_owner_new_session_or_capability_cannot_confirm_or_borrow_management(
    ordinary, client, admin, app, db
):
    peer, owner = ordinary
    data = await command(peer)
    assert (await peer.post(ROOT + "/prepare", json=data)).status_code == 200
    assert (await confirm(client, data)).status_code == 404
    later = await login(app, "ClosureMember")
    try:
        assert (await confirm(later, data)).status_code == 409
        assert (await later.post(ROOT + "/prepare", json=data)).status_code == 409
        assert (await confirm(peer, data | {"receipt_token": "acr_" + "A" * 43})).status_code == 404
        assert (await peer.get("/api/users")).status_code == 403
    finally:
        await later.aclose()
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT active FROM users WHERE id=%s", (owner,))).fetchone())[
            "active"
        ]
        assert (await (await conn.execute("SELECT active FROM users WHERE id=%s", (admin,))).fetchone())[
            "active"
        ]


async def test_last_admin_guard_wrong_password_and_no_capability_bypass(client, admin, ordinary, db):
    data = await command(client)
    assert (await client.post(ROOT + "/prepare", json=data)).status_code == 200
    assert (await confirm(client, data, current_password="WrongSynthetic9")).status_code == 403
    assert (await confirm(client, data)).status_code == 409
    direct = {k: v for k, v in data.items() if k != "receipt_token"}
    assert (await confirm(client, direct)).status_code == 409
    peer, owner = ordinary
    assert (await confirm(peer, await command(peer))).status_code == 404
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT active FROM users WHERE id=%s", (admin,))).fetchone())[
            "active"
        ]
        assert (await (await conn.execute("SELECT active FROM users WHERE id=%s", (owner,))).fetchone())[
            "active"
        ]


async def test_late_session_revocation_is_rechecked_before_password_and_retirement(
    ordinary, db, monkeypatch, app
):
    from alcor_api import account_closure

    peer, owner = ordinary
    data = await command(peer)
    assert (await peer.post(ROOT + "/prepare", json=data)).status_code == 200
    original = account_closure.lock_mutation_identity

    async def revoked(conn, who, **kwargs):
        async with db.connection() as other:
            await other.execute("DELETE FROM sessions WHERE token_hash=%s", (who.token_hash,))
        return await original(conn, who, **kwargs)

    monkeypatch.setattr(account_closure, "lock_mutation_identity", revoked)
    assert (await confirm(peer, data)).status_code == 401
    async with await public(app) as anonymous:
        observed = await anonymous.post(
            ROOT + "/" + data["request_id"] + "/receipt", json={"receipt_token": data["receipt_token"]}
        )
        assert observed.status_code == 200 and observed.json()["state"] == "prepared"
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT active FROM users WHERE id=%s", (owner,))).fetchone())[
            "active"
        ]
        assert not await (
            await conn.execute(
                "SELECT 1 FROM account_actions WHERE owner_id=%s AND request_id=%s",
                (owner, data["request_id"]),
            )
        ).fetchone()


async def test_real_backup_factor_consumed_once_by_concurrent_confirmation(
    ordinary, db, app, settings, monkeypatch
):
    from alcor_api.connections import Vault
    from alcor_api.identity_service import IdentityService
    from psycopg.types.json import Jsonb

    peer, owner = ordinary
    data = await command(peer)
    codes, key, hashes = app.state.identity_management.codes()
    vault = Vault(settings.connection_secret_dir)
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext,backup_codes,backup_key_ciphertext) VALUES(%s,true,%s,%s,%s)",
            (
                owner,
                vault.encrypt("JBSWY3DPEHPK3PXP", "totp:" + owner, settings.instance_id),
                Jsonb(hashes),
                vault.encrypt(key.hex(), "backup-key:" + owner, settings.instance_id),
            ),
        )
    assert (await peer.post(ROOT + "/prepare", json=data)).status_code == 200
    assert (await confirm(peer, data, code="wrong")).status_code == 403
    original = IdentityService.consume
    consumed = []

    async def observed(self, conn, user, code):
        result = await original(self, conn, user, code)
        if result:
            consumed.append(user)
        return result

    monkeypatch.setattr(IdentityService, "consume", observed)
    results = await asyncio.gather(confirm(peer, data, code=codes[0]), confirm(peer, data, code=codes[0]))
    assert [r.status_code for r in results].count(200) == 1
    assert all(r.status_code in {200, 401} for r in results)
    assert consumed == [owner]


async def test_cross_origin_malformed_capability_duplicate_body_and_request_swap_never_write(
    ordinary, app, db
):
    peer, owner = ordinary
    data = await command(peer)
    assert (await peer.post(ROOT + "/prepare", json=data)).status_code == 200
    async with await public(app) as anonymous:
        endpoint = ROOT + "/" + data["request_id"] + "/close"
        assert (
            await anonymous.post(
                endpoint,
                json={"receipt_token": data["receipt_token"]},
                headers={"origin": "https://other.example.invalid"},
            )
        ).status_code == 403
        invalid = await anonymous.post(
            endpoint, json={"receipt_token": data["receipt_token"] + "SyntheticNeverEcho"}
        )
        assert invalid.status_code == 422 and data["receipt_token"] not in invalid.text
        assert (
            await anonymous.post(
                ROOT + "/" + str(uuid4()) + "/receipt", json={"receipt_token": data["receipt_token"]}
            )
        ).status_code == 404
    duplicate = (
        '{"request_id":"'
        + data["request_id"]
        + '","request_id":"'
        + str(uuid4())
        + '","revision":"'
        + data["revision"]
        + '","receipt_token":"'
        + data["receipt_token"]
        + '","current_password":"'
        + PASSWORD
        + '"}'
    )
    assert (
        await peer.post("/api/account/close", content=duplicate, headers={"content-type": "application/json"})
    ).status_code == 422
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT state FROM account_closure_intents WHERE owner_id=%s AND request_id=%s",
                    (owner, data["request_id"]),
                )
            ).fetchone()
        )["state"] == "prepared"
        assert (await (await conn.execute("SELECT active FROM users WHERE id=%s", (owner,))).fetchone())[
            "active"
        ]


async def test_expired_preparation_cannot_be_renewed_and_terminal_intent_is_retained(
    ordinary, db, settings, app
):
    import pytest
    from psycopg import Error

    peer, owner = ordinary
    data = await command(peer)
    async with db.connection() as conn:
        original_session = digest(peer.cookies["alcor_session"])
        await conn.execute(
            "INSERT INTO account_closure_intents(owner_id,request_id,token_hash,prepared_session_hash,revision,created_at,prepared_until,expires_at) VALUES(%s,%s,%s,%s,%s,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day')",
            (
                owner,
                data["request_id"],
                capability_hash(settings.instance_id, data["receipt_token"]),
                original_session,
                data["revision"],
            ),
        )
        before = await (
            await conn.execute("SELECT * FROM account_closure_intents WHERE owner_id=%s", (owner,))
        ).fetchone()
    assert (await peer.post(ROOT + "/prepare", json=data)).status_code == 200
    assert (await confirm(peer, data)).status_code == 409
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT * FROM account_closure_intents WHERE owner_id=%s", (owner,))
            ).fetchone()
            == before
        )
    async with await public(app) as anonymous:
        closed = await anonymous.post(
            ROOT + "/" + data["request_id"] + "/close", json={"receipt_token": data["receipt_token"]}
        )
        assert closed.status_code == 200 and closed.json()["state"] == "closed"
    for statement in (
        "UPDATE account_closure_intents SET state='prepared',finished_at=NULL WHERE owner_id=%s",
        "DELETE FROM account_closure_intents WHERE owner_id=%s",
    ):
        async with db.connection() as conn, conn.transaction():
            with pytest.raises(Error):
                async with conn.transaction():
                    await conn.execute(statement, (owner,))
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT active FROM users WHERE id=%s", (owner,))).fetchone())[
            "active"
        ]
        assert (
            await (
                await conn.execute("SELECT state FROM account_closure_intents WHERE owner_id=%s", (owner,))
            ).fetchone()
        )["state"] == "closed"
