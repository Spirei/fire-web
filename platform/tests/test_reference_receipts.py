import asyncio
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alcor_api.cli import create_user
from alcor_api.fx_api import mount_rates
from alcor_api.reference_receipts import mount_reference_receipts
from fastapi import FastAPI


@pytest_asyncio.fixture
async def history(client, admin, db, settings):
    app = FastAPI()
    app.state.db, app.state.settings = db, settings
    mount_rates(app, settings, db)
    mount_reference_receipts(app, db)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url=settings.public_origin,
        cookies=client.cookies,
        headers=dict(client.headers),
    ) as value:
        yield value


async def request(client):
    identifier = str(uuid4())
    response = await client.post("/api/reference/rates/refresh", json={"requestId": identifier})
    assert response.status_code == 202, response.text
    return identifier, response.json()["id"]


@pytest.mark.asyncio
async def test_history_uses_original_request_time_and_read_never_mutates(history, db):
    identifier, task = await request(history)
    async with db.connection() as conn:
        before = {
            table: await (await conn.execute("SELECT * FROM " + table + " ORDER BY 1")).fetchall()
            for table in (
                "fx_requests",
                "fx_refresh_tasks",
                "fx_rate_windows",
                "fx_daily_usage",
                "audit_events",
            )
        }
        event = await (
            await conn.execute(
                "SELECT created_at FROM audit_events WHERE request_id=%s AND action='reference.fx.request'",
                (identifier,),
            )
        ).fetchone()
    response = await history.get("/api/reference/rates/operations")
    assert response.status_code == 200, response.text
    item = response.json()["items"][0]
    assert item["requestId"] == identifier and item["taskId"] == task
    assert item["state"] == "failed" and item["errorCode"] == "provider_disabled"
    assert item["requestedAt"] == event["created_at"].isoformat()
    assert item["startedAt"] is None and item["observationId"] is None
    assert "observationDate" not in item and "ownerId" not in item
    # The fixed list route and original UUID detail remain distinct.
    assert (await history.get("/api/reference/rates/operations/" + identifier)).json()["id"] == task
    async with db.connection() as conn:
        for table, expected in before.items():
            assert await (await conn.execute("SELECT * FROM " + table + " ORDER BY 1")).fetchall() == expected


@pytest.mark.asyncio
async def test_cursor_stays_on_original_sequence_when_new_requests_arrive(history):
    ids = [(await request(history))[0] for _ in range(3)]
    first = (await history.get("/api/reference/rates/operations?limit=1")).json()
    assert first["items"][0]["requestId"] == ids[-1]
    newest = (await request(history))[0]
    second = (
        await history.get(
            "/api/reference/rates/operations", params={"limit": 1, "cursor": first["nextCursor"]}
        )
    ).json()
    third = (
        await history.get(
            "/api/reference/rates/operations", params={"limit": 1, "cursor": second["nextCursor"]}
        )
    ).json()
    assert [second["items"][0]["requestId"], third["items"][0]["requestId"]] == ids[-2::-1]
    assert third["nextCursor"] is None
    assert (await history.get("/api/reference/rates/operations")).json()["items"][0]["requestId"] == newest
    for params in [{"cursor": "invalid"}, {"limit": 0}, {"limit": 101}]:
        assert (await history.get("/api/reference/rates/operations", params=params)).status_code in (400, 422)


@pytest.mark.asyncio
async def test_shared_task_never_uses_creator_owner_as_receipt_owner(history, client, db, settings, admin):
    async with db.connection() as conn:
        await conn.execute("UPDATE fx_config SET enabled=true")
    first, task = await request(history)
    # Add a second own request to obtain a continuation cursor.
    await request(history)
    own_cursor = (await history.get("/api/reference/rates/operations?limit=1")).json()["nextCursor"]
    user = await create_user(
        settings, "HistoryReader", "Synthetic9Pass", role="user", email="reader@example.invalid"
    )
    login = await client.post(
        "/api/session/login", json={"login": "HistoryReader", "password": "Synthetic9Pass"}
    )
    assert login.status_code == 200
    async with httpx.AsyncClient(
        transport=history._transport,
        base_url=settings.public_origin,
        cookies=client.cookies,
        headers={"origin": settings.public_origin, "x-csrf-token": login.json()["csrf"]},
    ) as other:
        second, same_task = await request(other)
        assert same_task == task
        rows = (await other.get("/api/reference/rates/operations")).json()["items"]
        assert [row["requestId"] for row in rows] == [second]
        assert (
            await other.get("/api/reference/rates/operations", params={"cursor": own_cursor})
        ).status_code == 400
        assert (await other.get("/api/reference/rates/provider")).status_code == 403
    assert first in [
        row["requestId"] for row in (await history.get("/api/reference/rates/operations")).json()["items"]
    ]
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT owner_id FROM fx_refresh_tasks WHERE id=%s", (task,))
            ).fetchone()
        )["owner_id"] == admin
        assert user != admin


@pytest.mark.asyncio
async def test_history_revalidates_session_after_waiting_on_owner_lock(history, db, admin):
    await request(history)
    async with db.connection() as blocker, blocker.transaction():
        await blocker.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + admin,)
        )
        pending = asyncio.create_task(history.get("/api/reference/rates/operations"))
        async with db.connection() as observer:
            waiting = False
            for _ in range(100):
                rows = await (
                    await observer.execute(
                        "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'"
                    )
                ).fetchone()
                if rows["n"]:
                    waiting = True
                    break
                await asyncio.sleep(0.01)
            assert waiting
            await observer.execute("DELETE FROM sessions WHERE user_id=%s", (admin,))
    assert (await pending).status_code == 401


@pytest.mark.asyncio
async def test_history_requires_cookie_and_survives_fresh_login(history, client):
    identifier, _ = await request(history)
    async with httpx.AsyncClient(transport=history._transport, base_url="http://testserver") as anonymous:
        assert (await anonymous.get("/api/reference/rates/operations")).status_code == 401
        assert (
            await anonymous.get(
                "/api/reference/rates/operations", headers={"authorization": "Bearer arbitrary"}
            )
        ).status_code == 401
    await client.post("/api/session/logout")
    assert (await history.get("/api/reference/rates/operations")).status_code == 401
    login = await client.post("/api/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"})
    assert login.status_code == 200
    history.cookies = client.cookies
    stale = await history.get("/api/reference/rates/operations")
    assert stale.status_code == 403
    assert stale.headers.get("x-alcor-session-changed") == "true"
    history.headers["x-csrf-token"] = login.json()["csrf"]
    assert (await history.get("/api/reference/rates/operations")).json()["items"][0][
        "requestId"
    ] == identifier
