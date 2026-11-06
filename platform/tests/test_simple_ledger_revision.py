"""Lightweight independent-ledger checks use isolated PG and the same owner guard."""

from uuid import uuid4

import httpx

from alcor_api.backups import tables_and_hashes
from alcor_api.cli import create_user
from request_telemetry_tables import REQUEST_TELEMETRY_TABLES

ROOT = "/api/account/simple-ledger"


async def hashes(db):
    async with db.connection() as conn, conn.transaction():
        return {name: value for name, value in (await tables_and_hashes(conn)).items()
                if name not in REQUEST_TELEMETRY_TABLES}


async def test_revision_is_payload_free_private_and_does_not_initialize_empty_ledger(client, admin, db, app, monkeypatch):
    async def forbidden_payload(*args, **kwargs):
        raise AssertionError("A revision check must not load or normalize the full ledger")

    monkeypatch.setattr(app.state.simple_ledger, "current", forbidden_payload)
    before = await hashes(db)
    for _ in range(2):
        response = await client.get(ROOT + "/revision")
        assert response.status_code == 200 and response.json() == {"revision": 0}, response.text
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["vary"] == "Cookie, Authorization"
    assert await hashes(db) == before
    assert (await client.get(ROOT + "/revision?owner=ignored")).status_code == 400
    assert (await client.get(ROOT + "/revision", headers={"x-simple-ledger-user": "another-owner"})).status_code == 409
    assert (await client.get(ROOT + "/revision", headers={"origin": "https://untrusted.invalid"})).status_code == 403
    assert (await client.get(ROOT + "/revision", headers={"authorization": "Bearer invalid"})).status_code == 403
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as anonymous:
        assert (await anonymous.get(ROOT + "/revision")).status_code == 401


async def test_other_web_session_observes_saved_revision_but_other_owner_and_revoked_session_do_not(client, admin, db, app, settings):
    first = await client.get(ROOT)
    assert first.status_code == 200 and first.json()["revision"] == 0
    request = {"requestId": str(uuid4()), "expectedRevision": 0,
               "ledger": {**first.json()["ledger"], "reminder": 3}}
    saved = await client.put(ROOT, json=request)
    assert saved.status_code == 200 and saved.json()["revision"] == 1, saved.text
    before = await hashes(db)
    assert (await client.get(ROOT + "/revision")).json() == {"revision": 1}
    assert await hashes(db) == before
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver",
                                 headers={"origin": "http://testserver"}) as peer:
        login = await peer.post("/api/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"})
        assert login.status_code == 200
        assert (await peer.get(ROOT + "/revision")).json() == {"revision": 1}
        # Exact original request replay cannot manufacture a later change watermark.
        assert (await client.put(ROOT, json=request)).json() == saved.json()
        assert (await peer.get(ROOT + "/revision")).json() == {"revision": 1}
        async with db.connection() as conn:
            await conn.execute("DELETE FROM sessions WHERE user_id=%s", (admin,))
        assert (await peer.get(ROOT + "/revision")).status_code == 401
    other = await create_user(settings, "OtherRevisionOwner", "SyntheticOther9Pass")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver",
                                 headers={"origin": "http://testserver"}) as peer:
        login = await peer.post("/api/session/login", json={"login": "OtherRevisionOwner", "password": "SyntheticOther9Pass"})
        assert login.status_code == 200 and login.json()["user"]["id"] == other
        assert (await peer.get(ROOT + "/revision")).json() == {"revision": 0}
        assert (await peer.get(ROOT + "/revision", headers={"x-simple-ledger-user": admin})).status_code == 409
