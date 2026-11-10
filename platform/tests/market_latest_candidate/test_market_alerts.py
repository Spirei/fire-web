"""One source observation serves client reads and F19; neither reader calls the supplier."""

from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest_asyncio
from alcor_api.market_alert_reader import SharedQuotes, project_alert_demands
from alcor_api.market_calendar import Calendars
from alcor_api.market_worker import claim, execute, schedule
from alcor_api.price_alert_worker import claim as claim_alert
from alcor_api.price_alert_worker import execute as execute_alert
from price_alerts_candidate.test_price_alerts import alert_settings, upsert

from .test_market_authority import demand, market, read

__all__ = ["alert_settings", "market"]


@pytest_asyncio.fixture
async def market_settings(alert_settings, tmp_path):
    return alert_settings


async def attach(app, authority):
    clock = [datetime(2026, 10, 20, 14, tzinfo=UTC)]
    authority.clock = lambda: clock[0]
    alerts = app.state.price_alert_candidate
    alerts.reader, alerts.now = SharedQuotes(authority), lambda: clock[0]
    await Calendars(app.state.db).ensure_builtin()
    return alerts, clock


async def test_enabled_rule_projects_one_shared_demand_then_pg_reader_triggers_without_source_io(market):
    client, app, authority, transport, revision = market
    alerts, clock = await attach(app, authority)
    await upsert(client)
    assert await project_alert_demands(authority) == 1
    assert await project_alert_demands(authority) == 0
    await demand(client, revision)
    assert await schedule(authority) == 1
    task = await claim(app.state.db, uuid4())
    assert await execute(authority, task, transport) == "observed"
    clock[0] += timedelta(seconds=1)
    alert = await claim_alert(app.state.db, uuid4())
    assert await execute_alert(alerts, alert) == "triggered"
    assert transport.calls == 1
    assert len((await client.get("/api/price-alerts")).json()["events"]) == 1
    assert (await read(client, revision)).json()["facts"][0]["price"] == "340.000001"
    assert transport.calls == 1


async def test_cached_or_stale_pg_fact_does_not_trigger_and_stopping_rule_releases_background_demand(market):
    client, app, authority, transport, _revision = market
    alerts, clock = await attach(app, authority)
    value, _, _ = await upsert(client)
    await project_alert_demands(authority)
    await schedule(authority)
    task = await claim(app.state.db, uuid4())
    assert await execute(authority, task, transport) == "observed"
    clock[0] += timedelta(seconds=91)
    alert = await claim_alert(app.state.db, uuid4())
    assert await execute_alert(alerts, alert) == "source_unknown_or_stale"
    assert (await client.get("/api/price-alerts")).json()["events"] == []
    from price_alerts_candidate.test_price_alerts import mutate

    response, _ = await mutate(
        client, {"action": "state", "ruleId": value["id"], "revision": 1, "state": "paused"}
    )
    assert response.status_code == 200
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE market_streams SET next_due=clock_timestamp()-interval '1 second'")
    task = await claim(app.state.db, uuid4())
    assert await execute(authority, task, transport) == "authorization_revoked"
    assert transport.calls == 1


async def test_new_price_alert_wakes_an_existing_sleeping_client_stream(market):
    client, app, authority, transport, revision = market
    await attach(app, authority)
    await demand(client, revision)
    await schedule(authority)
    original = await claim(app.state.db, uuid4())
    assert await execute(authority, original, transport) == 'observed'
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE market_demands SET hot_until=clock_timestamp()-interval '1 second'")
        await conn.execute("UPDATE market_streams SET next_due=clock_timestamp()-interval '1 second'")
    cold = await claim(app.state.db, uuid4())
    assert await execute(authority, cold, transport) == 'sleeping'
    assert await claim(app.state.db, uuid4()) is None
    await upsert(client)
    assert await project_alert_demands(authority) == 1
    assert await schedule(authority) == 0
    awake = await claim(app.state.db, uuid4())
    assert awake and awake['id'] == original['id']
    assert await execute(authority, awake, transport) == 'observed'
    assert transport.calls == 2
