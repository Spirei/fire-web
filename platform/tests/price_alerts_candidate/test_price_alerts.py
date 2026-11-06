"""Real create_app/private PG, controlled quote evidence, no real sources or notifications."""

import asyncio
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alcor_api.business_notifications import bridge_dividends
from alcor_api.main import create_app
from alcor_api.market_calendar import Calendars
from alcor_api.native_app_auth import issue_grant
from alcor_api.price_alert_contract import ACTIONS
from alcor_api.price_alert_quotes import Quote
from alcor_api.price_alert_worker import claim, execute
from psycopg.errors import CheckViolation

from .source_fixture import ingest

HERE = __import__("pathlib").Path(__file__).resolve().parent


class Reader:
    fixture = True

    def __init__(self, now):
        self.now, self.calls, self.changes = now, 0, {}

    async def read(self, row):
        self.calls += 1
        quote = Quote(
            row["owner_id"],
            row["account_id"],
            row["source_identity"],
            "synthetic-fixture",
            "fixture-v1",
            row["config"]["market"],
            row["config"]["code"],
            Decimal("340.000001"),
            "USD",
            self.now(),
            self.now(),
            "REGULAR",
            False,
            b'{"controlled":"fresh quote fixture"}',
            True,
        )
        return replace(quote, **self.changes)


@pytest_asyncio.fixture
async def alert_settings(settings):
    return settings


@pytest_asyncio.fixture
async def alerts(alert_settings):
    app = create_app(alert_settings)
    clock = [datetime(2026, 10, 20, 14, tzinfo=UTC)]
    service = app.state.price_alert_candidate
    service.reader = Reader(lambda: clock[0])
    service.now = lambda: clock[0]
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client,
    ):
        response = await client.post(
            "/api/session/register", json={"username": "PriceAlertReader", "password": "Synthetic9Pass"}
        )
        assert response.status_code == 201, response.text
        client.headers["x-csrf-token"] = response.json()["csrf"]
        await Calendars(app.state.db).ensure_builtin()
        yield client, app, service, clock


def rule(**changes):
    return {
        "id": str(uuid4()),
        "name": "Fixture",
        "code": "AAPL",
        "market": "US",
        "direction": "above",
        "price": "340.000001",
        "extended": False,
        "frequency": "once",
        "expiresAt": None,
        **changes,
    }


async def mutate(client, data, uid=None, path="/api/price-alerts", headers=None):
    uid = uid or str(uuid4())
    response = await client.post(path + "/operations/" + uid, json=data, headers=headers)
    return response, uid


async def upsert(client, value=None, revision=0, **kwargs):
    value = value or rule()
    response, uid = await mutate(
        client, {"action": "upsert", "ruleId": value["id"], "revision": revision, "rule": value}, **kwargs
    )
    assert response.status_code == 200, response.text
    return value, response.json(), uid


async def run(service):
    task = await claim(service.db, uuid4())
    assert task is not None
    return task, await execute(service, task)


async def native_pair(app, scope="portfolio.read portfolio.write"):
    async with app.state.db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users ORDER BY created_at LIMIT 1")).fetchone()
        return await issue_grant(conn, user, scope, "Synthetic alert client")


async def test_read_empty_snapshot_has_no_domain_writes(alerts):
    client, app, service, _ = alerts
    for _ in range(2):
        response = await client.get("/api/price-alerts")
        assert response.status_code == 200, response.text
        assert response.json()["rules"] == [] and response.json()["events"] == []
    async with app.state.db.connection() as conn:
        for table in (
            "price_alert_collections",
            "price_alert_jobs",
            "business_notification_events",
            "price_alert_operations",
        ):
            assert (await (await conn.execute("SELECT count(*) AS n FROM " + table)).fetchone())["n"] == 0
    assert service.reader.calls == 0


async def test_once_threshold_receipt_inbox_and_same_uuid_no_replay(alerts):
    client, app, service, clock = alerts
    value, receipt, uid = await upsert(client)
    clock[0] += timedelta(seconds=1)
    task, result = await run(service)
    assert result == "triggered"
    snapshot = (await client.get("/api/price-alerts")).json()
    assert snapshot["rules"][0]["status"] == "completed" and len(snapshot["events"]) == 1
    assert snapshot["events"][0]["priceExact"] == "340.000001" and snapshot["unreadCount"] == 1
    assert (await client.get("/api/price-alerts/operations/" + uid)).json() == receipt
    duplicate, _ = await mutate(client, {"action": "delete", "ruleId": value["id"], "revision": 1}, uid=uid)
    assert duplicate.status_code == 409
    assert await claim(app.state.db, uuid4()) is None
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT status FROM tasks WHERE id=%s", (task["id"],))).fetchone())[
            "status"
        ] == "succeeded"
        assert (await (await conn.execute("SELECT count(*) AS n FROM cash_ledger_entries")).fetchone())[
            "n"
        ] == 0
        for table in ("price_alert_operations", "price_alert_quote_evidence", "business_notification_events"):
            with pytest.raises(CheckViolation):
                async with conn.transaction():
                    await conn.execute("DELETE FROM " + table)


@pytest.mark.parametrize(
    "changes",
    [
        {"cached": True},
        {"source_identity": "other"},
        {"account": "other"},
        {"owner": "other"},
        {"code": "MSFT"},
        {"currency": "HKD"},
        {"session": "PRE"},
    ],
)
async def test_wrong_or_stale_quote_cannot_trigger(alerts, changes):
    client, app, service, clock = alerts
    await upsert(client)
    clock[0] += timedelta(seconds=1)
    service.reader.changes = changes
    _, state = await run(service)
    assert state == "source_unknown_or_stale"
    assert (await client.get("/api/price-alerts")).json()["events"] == []
    async with app.state.db.connection() as conn:
        assert (
            await (await conn.execute("SELECT count(*) AS n FROM price_alert_quote_evidence")).fetchone()
        )["n"] == 0


@pytest.mark.parametrize("seconds", [-91, 6])
async def test_source_timestamp_outside_fresh_window_is_unknown(alerts, seconds):
    client, _, service, clock = alerts
    await upsert(client)
    clock[0] += timedelta(seconds=100)
    service.reader.changes = {"at": clock[0] + timedelta(seconds=seconds)}
    assert (await run(service))[1] == "source_unknown_or_stale"
    assert (await client.get("/api/price-alerts")).json()["events"] == []


async def test_pause_during_io_cancels_original_work_and_rejects_old_lease(alerts):
    client, app, service, _clock = alerts
    value, _, _ = await upsert(client)
    entered, release = asyncio.Event(), asyncio.Event()
    original = service.reader.read

    async def delayed(row):
        entered.set()
        await release.wait()
        return await original(row)

    service.reader.read = delayed
    task = await claim(app.state.db, uuid4())
    pending = asyncio.create_task(execute(service, task))
    await entered.wait()
    response, _ = await mutate(
        client, {"action": "state", "ruleId": value["id"], "revision": 1, "state": "paused"}
    )
    assert response.status_code == 200, response.text
    release.set()
    assert await pending == "cancelled"
    assert await execute(service, task) == "lost"
    assert (await client.get("/api/price-alerts")).json()["events"] == []


async def test_two_native_grants_and_web_one_shared_rule_one_event(alerts):
    client, app, service, clock = alerts
    value = rule()
    one, two = await native_pair(app), await native_pair(app)
    for revision, pair in [(0, one), (1, two)]:
        await upsert(
            client,
            value,
            revision=revision,
            path="/api/v2/price-alerts",
            headers={"authorization": "Bearer " + pair["access_token"]},
        )
    await upsert(client, value, revision=2)
    async with app.state.db.connection() as conn:
        await conn.execute(
            "UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s", (one["grant_id"],)
        )
        assert (await (await conn.execute("SELECT count(*) AS n FROM price_alert_subscriptions")).fetchone())[
            "n"
        ] == 3
    clock[0] += timedelta(seconds=1)
    assert (await run(service))[1] == "triggered"
    assert len((await client.get("/api/price-alerts")).json()["events"]) == 1


async def test_native_revoke_without_other_subscription_stops_monitoring(alerts):
    client, app, service, _ = alerts
    pair = await native_pair(app)
    await upsert(
        client, path="/api/v1/price-alerts", headers={"authorization": "Bearer " + pair["access_token"]}
    )
    async with app.state.db.connection() as conn:
        await conn.execute(
            "UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s", (pair["grant_id"],)
        )
    assert (await run(service))[1] == "authorization_revoked" and service.reader.calls == 0
    assert (await client.get("/api/price-alerts")).json()["rules"][0]["status"] == "paused"


@pytest.mark.parametrize("version", [1, 2])
async def test_legacy_scopes_headers_envelope_and_binding_actions_remain_explicit(alerts, version):
    client, app, _, _ = alerts
    path = f"/api/v{version}/price-alerts"
    assert (await client.get(path)).status_code == 401
    read = await native_pair(app, "portfolio.read")
    read_headers = {"authorization": "Bearer " + read["access_token"]}
    assert (await client.get(path, headers=read_headers)).status_code == 200
    response, _ = await mutate(client, {"action": "test", "channel": "app"}, path=path, headers=read_headers)
    assert response.status_code == 403
    write = await native_pair(app)
    headers = {"authorization": "Bearer " + write["access_token"]}
    for negotiated, count in [(None, 3), ("wechat-v1", 4), ("messengers-v1", 7)]:
        current = headers | ({"x-alcor-price-alerts": negotiated} if negotiated else {})
        snapshot = await client.get(path, headers=current)
        assert snapshot.status_code == 200 and len(snapshot.json()["data"]["channels"]) == count
        assert snapshot.headers["x-alcor-api-version"] == str(version)
    assert (await client.post(path + "/telegram-link", json={}, headers=headers)).status_code == 503
    assert len(ACTIONS) == 20
    for action in sorted(ACTIONS - {"upsert", "delete", "state", "channel", "test", "read"}):
        result, _ = await mutate(
            client, {"action": action}, path=path, headers=headers | {"x-alcor-price-alerts": "messengers-v1"}
        )
        assert result.status_code in ({409, 503} if action.endswith("_disconnect") else {503})


async def test_dividend_archives_project_once_into_shared_inbox_without_external_deliveries(alerts):
    client, app, _, _ = alerts
    await ingest(client, app)
    async with app.state.db.connection() as conn, conn.transaction():
        assert await bridge_dividends(conn) == 1
        assert await bridge_dividends(conn) == 0
        row = await (await conn.execute("SELECT * FROM business_notification_events")).fetchone()
        assert row["kind"] == "dividend.review" and row["payload"]["cashWritten"] is False
        deliveries = await (
            await conn.execute("SELECT channel,state FROM business_notification_deliveries")
        ).fetchall()
        assert deliveries == [{"channel": "app", "state": "delivered"}]
    assert (await client.get("/api/price-alerts")).json()["events"] == []
