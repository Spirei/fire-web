"""Actual create_app / identity-checked private PG; no supplier or account data."""

import asyncio

import httpx
import pytest
from alcor_api.account_signals import AccountSignals
from alcor_api.backups import tables_and_hashes
from alcor_api.cli import create_user
from alcor_api.main import create_app
from alcor_api.native_app_auth import issue_grant
from alcor_api.security import Identity
from fastapi import HTTPException
from request_telemetry_tables import REQUEST_TELEMETRY_TABLES


async def hashes(db):
    async with db.connection() as conn, conn.transaction():
        return {name:value for name,value in (await tables_and_hashes(conn)).items() if name not in REQUEST_TELEMETRY_TABLES}


async def grants(db, owner, scope="portfolio.read"):
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (owner,))).fetchone()
        return await issue_grant(conn, user, scope, "Synthetic client")


def bearer(pair):
    return {"authorization": "Bearer " + pair["access_token"]}


async def test_pure_get_real_profile_change_no_fake_unimplemented_domains(client, admin, db):
    initial = await client.get("/api/account/changes")
    assert initial.status_code == 200, initial.text
    value = initial.json()
    assert value["userId"] == admin and value["financialAuthority"] is False
    # Feed now has installed, integrity-checked change sources; an untouched book is known zero.
    assert value["domains"]["feed"]["revision"] == 0
    assert value["domains"]["feed"]["state"] == "observed"
    assert value["domains"]["watch"]["revision"] == 0
    assert value["domains"]["watch"]["lastChangedAt"] is None
    before = await hashes(db)
    repeated = await client.get("/api/account/changes", headers={"x-alcor-context": value["context"]})
    device = await client.get("/api/account/device-state")
    assert repeated.status_code == device.status_code == 200
    assert await hashes(db) == before
    assert repeated.json()["revisions"] == value["revisions"]
    assert device.json()["device"]["onlineState"] == "unknown"
    assert device.json()["device"]["lastUsedAt"] is None
    old = (await client.get("/api/profile")).json()
    changed = await client.patch("/api/profile", json={"display_name": "After", "revision": old["revision"]})
    assert changed.status_code == 200, changed.text
    final = (await client.get("/api/account/changes")).json()
    assert final["revisions"]["profile"] > value["revisions"]["profile"]
    assert final["domains"]["profile"]["lastChangedAt"] is not None
    assert final["context"] == value["context"]


async def test_rollback_noop_delete_tombstone_and_concurrent_versions(client, admin, db):
    async def update(number):
        async with db.connection() as conn:
            await conn.execute("INSERT INTO watch_groups(owner_id,id,name,name_key,sort,kind,revision) VALUES(%s,%s,%s,%s,%s,'custom',1)", (admin, str(number), str(number), str(number), number))
    await asyncio.gather(*(update(n) for n in range(8)))
    first = (await client.get("/api/account/changes")).json()
    assert first["revisions"]["watch"] == 8
    async with db.connection() as conn:
        await conn.execute("UPDATE watch_groups SET name=name WHERE owner_id=%s", (admin,))
    # Separate real async rollback; trigger/event writes participate in the same transaction.
    with pytest.raises(RuntimeError):
        async with db.connection() as conn, conn.transaction():
            await conn.execute("DELETE FROM watch_groups WHERE owner_id=%s", (admin,))
            raise RuntimeError("synthetic rollback")
    unchanged = (await client.get("/api/account/changes")).json()
    assert unchanged["revisions"]["watch"] == 8
    async with db.connection() as conn:
        await conn.execute("DELETE FROM watch_groups WHERE owner_id=%s AND id='0'", (admin,))
        rows = await (await conn.execute("SELECT revision,operation FROM account_change_events WHERE owner_id=%s AND domain='watch' ORDER BY revision", (admin,))).fetchall()
    assert len(rows) == 9 and rows[-1] == {"revision": 9, "operation": "DELETE"}
    assert (await client.get("/api/account/changes")).json()["revisions"]["watch"] == 9


async def test_native_scopes_current_device_no_last_seen_write_and_revocation(client, admin, db):
    pair = await grants(db, admin)
    path = "/api/client/account/changes"
    response = await client.get(path, headers=bearer(pair))
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["domains"]["authorization"]["state"] == "forbidden"
    assert value["revisions"]["authorization"] is None
    assert value["domains"]["resources"]["state"] == "forbidden"
    before = await hashes(db)
    current = await client.get("/api/client/device-state", headers=bearer(pair))
    assert current.status_code == 200, current.text
    assert current.json()["device"]["id"] == pair["grant_id"]
    assert current.json()["device"]["authorizationState"] == "active"
    assert current.json()["device"]["onlineState"] == "unknown"
    assert await hashes(db) == before
    authorization = (await client.get("/api/account/changes")).json()["revisions"]["authorization"]
    async with db.connection() as conn:
        await conn.execute("UPDATE identity_app_grants SET last_used_at=clock_timestamp() WHERE id=%s", (pair["grant_id"],))
    assert (await client.get("/api/account/changes")).json()["revisions"]["authorization"] == authorization
    async with db.connection() as conn:
        await conn.execute("UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s", (pair["grant_id"],))
    denied = await client.get(path, headers=bearer(pair))
    assert denied.status_code == 401 and denied.headers["x-alcor-retire-context"] == "true"


async def test_session_role_scope_and_context_boundaries(client, admin, db):
    context = (await client.get("/api/account/changes")).json()["context"]
    pair = await grants(db, admin, "portfolio.read security.read")
    foreign = await client.get("/api/client/account/changes", headers={**bearer(pair), "x-alcor-context": context})
    assert foreign.status_code == 403 and foreign.headers["x-alcor-retire-context"] == "true"
    state = (await client.get("/api/client/account/changes", headers=bearer(pair))).json()
    async with db.connection() as conn:
        await conn.execute("UPDATE identity_app_grants SET scope='portfolio.read' WHERE id=%s", (pair["grant_id"],))
    reduced = await client.get("/api/client/account/changes", headers={**bearer(pair), "x-alcor-context": state["context"]})
    assert reduced.status_code == 403
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET role='user' WHERE id=%s", (admin,))
    changed = await client.get("/api/account/changes", headers={"x-alcor-context": context})
    assert changed.status_code == 403 and changed.headers["x-alcor-retire-context"] == "true"
    assert (await client.get("/api/account/changes")).json()["context"] != context
    async with db.connection() as conn:
        await conn.execute("DELETE FROM sessions WHERE user_id=%s", (admin,))
    expired = await client.get("/api/account/device-state")
    assert expired.status_code == 401 and expired.headers["x-alcor-retire-context"] == "true"


async def test_restart_persists_pg_watermark_and_get_does_not_repair_missing_trigger(client, admin, db, settings):
    initial = (await client.get("/api/account/changes")).json()
    changed = await client.patch("/api/account/preferences", json={"revision": None, "avatar_status": "focus"})
    assert changed.status_code == 200
    current = (await client.get("/api/account/changes")).json()
    assert current["revisions"]["settings"] == 1
    application = create_app(settings)
    async with application.router.lifespan_context(application), httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url="http://testserver", cookies=client.cookies, headers={"origin":"http://testserver"}) as restarted:
        final = (await restarted.get("/api/account/changes")).json()
    assert final["epoch"] == initial["epoch"] and final["revisions"] == current["revisions"]
    assert final["context"] == current["context"]
    async with db.connection() as conn:
        await conn.execute("ALTER TABLE user_profiles DISABLE TRIGGER account_signal_profile")
    missing = (await client.get("/api/account/changes")).json()
    assert missing["domains"]["profile"]["state"] == "partial"
    assert missing["domains"]["profile"]["missingSources"] == ["user_profiles"]
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT tgenabled FROM pg_trigger WHERE tgname='account_signal_profile' AND tgrelid='user_profiles'::regclass")).fetchone()
    assert row["tgenabled"] == "D"


async def test_user_owner_and_mid_read_identity_revalidation(client, admin, db):
    async with db.connection() as conn:
        row = await (await conn.execute("SELECT u.*,s.token_hash,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=%s AND s.client_id='new-web'", (admin,))).fetchone()
    who = Identity(id=admin, username=row["username"], role=row["role"], token_hash=row["token_hash"], csrf="", expires_at=row["expires_at"])
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET role='user' WHERE id=%s", (admin,))
    with pytest.raises(HTTPException) as denied:
        await AccountSignals(db).read(who)
    assert denied.value.status_code == 403
    # Newly mounted App-only state adapters never use a Web cookie to authorize a write.
    assert (await client.post("/api/v2/app-state", json={"namespace":"fees","changes":[]})).status_code == 401


async def test_other_owner_cannot_reuse_context_or_select_arbitrary_owner(client, admin, db, app, settings):
    own = (await client.get("/api/account/changes")).json()
    other = await create_user(settings, "OtherSignalOwner", "SyntheticOtherPass9")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver", headers={"origin":"http://testserver"}) as second:
        logged = await second.post("/api/session/login", json={"login":"OtherSignalOwner", "password":"SyntheticOtherPass9"})
        assert logged.status_code == 200
        forbidden = await second.get("/api/account/changes", headers={"x-alcor-context": own["context"]})
        assert forbidden.status_code == 403
        assert forbidden.headers["x-alcor-retire-context"] == "true"
        read = (await second.get("/api/account/changes")).json()
        assert read["userId"] == other and read["context"] != own["context"]
        assert (await second.get("/api/account/changes", params={"userId":admin})).status_code == 400
        assert read["revisions"]["watch"] == 0
