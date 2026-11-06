"""Real create_app/private PG with explicit demands and controlled source observations."""

from dataclasses import asdict, replace
from pathlib import Path
from uuid import uuid4

import httpx
import pytest_asyncio
from alcor_api.main import create_app
from alcor_api.market_authority import Policy
from alcor_api.market_contract import Query, canonical
from alcor_api.market_worker import claim, execute, schedule

HERE = Path(__file__).resolve().parent


@pytest_asyncio.fixture
async def market_settings(settings):
    return settings


class Transport:
    fixture = True

    def __init__(self):
        self.calls = 0
        self.price = "340.000001"
        self.hook = None

    async def read(self, policy, query, cursor):
        self.calls += 1
        if self.hook:
            await self.hook()
        return canonical(
            {
                "query": asdict(query),
                "licenseRevision": policy.license_revision,
                "facts": [
                    {
                        "at": "2026-10-20T14:00:00+00:00",
                        "price": self.price,
                        "currency": "USD",
                        "session": "REGULAR",
                        "cached": False,
                        "name": "Fixture",
                    }
                ],
                "nextCursor": None,
            }
        ).encode(), "controlled_http_response_body"


@pytest_asyncio.fixture
async def market(market_settings):
    app = create_app(market_settings)
    authority = app.state.market_candidate
    authority.policy_provider = None
    transport = Transport()
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client,
    ):
        registered = await client.post(
            "/api/session/register", json={"username": "MarketReader", "password": "Synthetic9Pass"}
        )
        assert registered.status_code == 201, registered.text
        client.headers["x-csrf-token"] = registered.json()["csrf"]
        async with app.state.db.connection() as conn:
            owner = (await (await conn.execute("SELECT id FROM users")).fetchone())["id"]
        authority.policies = (
            Policy(
                "fixture",
                "controlled_market",
                "fixture-v1",
                "controlled-endpoint",
                "controlled-fingerprint",
                owner,
                "synthetic-license-v1",
                ("latest", "bars.day", "bars.month", "price_series.day"),
                ("US", "ASSET"),
                True,
            ),
        )
        response = await client.post(
            "/api/market/sources", json={"request_id": str(uuid4()), "policy_id": "fixture"}
        )
        assert response.status_code == 200, response.text
        revision = response.json()["revision"]
        yield client, app, authority, transport, revision


async def demand(client, revision, query=None, expected=0, remove=False):
    request_id = str(uuid4())
    raw = {
        "request_id": request_id,
        "source_revision": revision,
        "query": asdict(query or Query("latest", "US", "AAPL")),
        "expected_revision": expected,
    }
    response = await client.request("DELETE" if remove else "POST", "/api/market/demands", json=raw)
    assert response.status_code == 200, response.text
    return response.json()


async def read(client, revision, query=None):
    raw = {
        key: value
        for key, value in asdict(query or Query("latest", "US", "AAPL")).items()
        if value is not None
    }
    return await client.get("/api/market/data", params={"source_revision": revision, **raw})


async def run(authority, transport):
    await schedule(authority)
    task = await claim(authority.db, uuid4())
    assert task is not None
    return task, await execute(authority, task, transport)


async def test_get_reads_never_register_or_call_source_and_worker_collects_original_stream(market):
    client, app, authority, transport, revision = market
    for _ in range(2):
        assert (await read(client, revision)).json()["state"] == "unknown"
    async with app.state.db.connection() as conn:
        for table in (
            "market_demands",
            "market_streams",
            "market_data_jobs",
            "market_source_pages",
            "market_facts",
        ):
            assert (await (await conn.execute("SELECT count(*) AS n FROM " + table)).fetchone())["n"] == 0
    assert transport.calls == 0
    receipt = await demand(client, revision)
    _task, state = await run(authority, transport)
    assert state == "observed"
    data = (await read(client, revision)).json()
    assert (
        data["facts"][0]["price"] == "340.000001"
        and data["facts"][0]["fixture"]
        and data["coverage"] == "unknown"
    )
    assert data["streamId"] == receipt["streamId"] and transport.calls == 1
    assert (await client.get("/api/market/operations/" + receipt["requestId"])).json() == receipt
    assert await claim(app.state.db, uuid4()) is None


async def test_same_time_source_revision_changes_pg_current_view_without_overwriting_old_fact(market):
    client, app, authority, transport, revision = market
    await demand(client, revision)
    await run(authority, transport)
    first = (await read(client, revision)).json()["facts"][0]
    transport.price = "341"
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE market_streams SET next_due=clock_timestamp()-interval '1 second'")
    await run(authority, transport)
    second = (await read(client, revision)).json()["facts"][0]
    assert second["price"] == "341" and second["revision"] > first["revision"] and second["at"] == first["at"]
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM market_facts")).fetchone())["n"] == 2
        assert (await (await conn.execute("SELECT generation FROM market_cache_generations")).fetchone())[
            "generation"
        ] == 2


async def test_cancel_while_source_io_waits_retains_original_receipt_and_commits_no_fact(market):
    client, app, authority, transport, revision = market
    await demand(client, revision)

    async def cancel():
        await demand(client, revision, expected=1, remove=True)

    transport.hook = cancel
    task, state = await run(authority, transport)
    assert state == "authorization_revoked"
    assert (await read(client, revision)).json()["facts"] == []
    async with app.state.db.connection() as conn:
        row = await (await conn.execute("SELECT status FROM tasks WHERE id=%s", (task["id"],))).fetchone()
        assert row["status"] == "cancelled"


async def test_license_change_in_flight_cannot_publish_old_source_or_reuse_old_cache(market):
    client, app, authority, transport, revision = market
    await demand(client, revision)

    async def revoke():
        authority.policies = (replace(authority.policies[0], license_revision="changed-license"),)

    transport.hook = revoke
    _, state = await run(authority, transport)
    assert state == "source_authorization_unavailable"
    assert (await read(client, revision)).status_code == 503
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM market_facts")).fetchone())["n"] == 0


async def test_unknown_source_does_not_replay_without_new_explicit_demand_generation(market):
    client, app, authority, transport, revision = market
    await demand(client, revision)

    async def fail():
        raise TimeoutError("synthetic source outcome unknown")

    transport.hook = fail
    first, state = await run(authority, transport)
    assert state == "source_outcome_unknown"
    assert await schedule(authority) == 0 and await claim(app.state.db, uuid4()) is None
    transport.hook = None
    await demand(client, revision, expected=1)
    second, state = await run(authority, transport)
    assert state == "observed" and second["id"] != first["id"] and transport.calls == 2


async def test_source_revoke_is_receipted_and_stops_collection_before_any_transport(market):
    client, app, authority, transport, revision = market
    await demand(client, revision)
    assert await schedule(authority) == 1
    request_id = str(uuid4())
    result = await client.request(
        "DELETE", "/api/market/sources/" + revision, json={"request_id": request_id}
    )
    assert result.status_code == 200 and result.json()["revoked"]
    assert (await client.get("/api/market/operations/" + request_id)).json() == result.json()
    assert await claim(app.state.db, uuid4()) is None and transport.calls == 0
    assert (await read(client, revision)).status_code == 409
