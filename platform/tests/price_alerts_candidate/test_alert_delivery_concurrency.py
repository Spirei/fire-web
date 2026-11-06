"""Actual rule fanout, lease fencing and concurrent claims over the shared authority."""

import asyncio
import re
from datetime import timedelta
from uuid import uuid4

import httpx
import pytest
from alcor_api.business_notification_worker import Acceptance, dispatch_one
from alcor_api.notification_sender import Sender
from alcor_api.price_alert_worker import claim, execute
from alcor_api.security import digest
from psycopg.errors import CheckViolation

from .test_notification_bindings import alert_settings, alerts, binding_mutation, configure, install
from .test_price_alerts import mutate, rule, run, upsert

__all__ = ["alert_settings", "alerts"]


async def bind_wechat(client, app, service, *, enabled=True):
    wire, _ = install(service)
    await configure(client, "wechat")
    response, _ = await binding_mutation(
        client, {"action": "wechat_start", "recipient": "SyntheticMember", "revision": 0}
    )
    state = next(row for row in response.json()["snapshot"]["channels"] if row["channel"] == "wechat")
    assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "accepted"
    code = re.search(r"验证码：(\d{6})", wire.messages[-1])[1]
    response, _ = await binding_mutation(
        client,
        {
            "action": "wechat_confirm",
            "challengeId": state["challengeId"],
            "verificationCode": code,
            "revision": 1,
            "enabled": enabled,
        },
    )
    assert response.status_code == 200, response.text
    return wire


async def test_rule_trigger_fans_out_once_and_concurrent_dispatch_sends_one_message(alerts):
    client, app, service, clock = alerts
    wire = await bind_wechat(client, app, service)
    await upsert(client)
    clock[0] += timedelta(seconds=1)
    assert (await run(service))[1] == "triggered"
    event = (await client.get("/api/price-alerts")).json()["events"][0]
    assert {row["channel"] for row in event["deliveries"]} == {"app", "wechat"}
    results = await asyncio.gather(
        *[dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) for _ in range(2)]
    )
    assert sorted(results) == ["accepted", "idle"]
    assert len(wire.messages) == 2 and "触达价格 340.000001" in wire.messages[-1]
    uid = next(row["id"] for row in event["deliveries"] if row["channel"] == "wechat")
    receipt = (await client.get("/api/notifications/deliveries/" + uid)).json()
    assert receipt["state"] == "accepted" and not receipt["willRetryAutomatically"]


async def test_daily_duplicate_does_not_send_to_channel_enabled_after_original_event(alerts):
    client, app, service, clock = alerts
    wire = await bind_wechat(client, app, service, enabled=False)
    await upsert(client, rule(frequency="daily"))
    clock[0] += timedelta(seconds=1)
    assert (await run(service))[1] == "triggered_daily"
    response, _ = await binding_mutation(
        client, {"action": "channel", "channel": "wechat", "enabled": True, "revision": 2}
    )
    assert response.status_code == 200, response.text
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE price_alert_jobs SET next_scan_at=clock_timestamp()-interval '1 second'")
    clock[0] += timedelta(seconds=1)
    assert (await run(service))[1] == "already_triggered_for_period"
    assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "idle"
    assert len(wire.messages) == 1


async def test_late_quote_old_lease_cannot_append_and_replacement_claim_triggers_once(alerts):
    client, app, service, clock = alerts
    await upsert(client)
    clock[0] += timedelta(seconds=1)
    task = await claim(app.state.db, uuid4())
    original = service.reader.read
    replacement = []

    async def read(row):
        async with app.state.db.connection() as conn:
            await conn.execute(
                "UPDATE tasks SET lease_until=clock_timestamp()-interval '1 second' WHERE id=%s",
                (task["id"],),
            )
        replacement.append(await claim(app.state.db, uuid4()))
        return await original(row)

    service.reader.read = read
    assert await execute(service, task) == "lost"
    assert (await client.get("/api/price-alerts")).json()["events"] == []
    service.reader.read = original
    assert await execute(service, replacement[0]) == "triggered"


async def test_expired_delivery_lease_is_unknown_and_old_worker_cannot_overwrite_receipt(alerts):
    client, app, service, _ = alerts
    wire = await bind_wechat(client, app, service)
    response, _ = await binding_mutation(client, {"action": "test", "channel": "wechat"})
    assert response.status_code == 200

    class Delayed:
        fixture = True

        async def ready(self, row):
            return True

        async def send(self, row, authorize):
            assert await authorize()
            async with app.state.db.connection() as conn:
                await conn.execute(
                    "UPDATE business_notification_deliveries SET lease_until=clock_timestamp()-interval '1 second' WHERE id=%s",
                    (row["id"],),
                )
            assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "idle"
            assert not await authorize()
            return Acceptance("synthetic-late-acceptance", "controlled-notification-receipt-v1")

    assert await dispatch_one(app.state.db, uuid4(), Delayed()) == "lost"
    assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "idle"
    async with app.state.db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT state,receipt FROM business_notification_deliveries WHERE channel='wechat' ORDER BY updated_at DESC LIMIT 1"
            )
        ).fetchone()
        assert row == {"state": "unknown", "receipt": {"reason": "delivery_outcome_unknown"}}
    assert len(wire.messages) == 1


async def test_pause_during_provider_auth_prevents_actual_message_transport(alerts):
    client, app, service, clock = alerts
    wire = await bind_wechat(client, app, service)
    value, _, _ = await upsert(client)
    clock[0] += timedelta(seconds=1)
    assert (await run(service))[1] == "triggered"
    original = wire.call

    async def call(label, method, path, **kwargs):
        value_reply = await original(label, method, path, **kwargs)
        if path.endswith("/gettoken"):
            response, _ = await mutate(client, {"action": "delete", "ruleId": value["id"], "revision": 1})
            assert response.status_code == 200, response.text
        return value_reply

    wire.call = call
    assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "failed"
    assert len(wire.messages) == 1


async def test_old_delivery_never_retargets_after_recipient_rebinding(alerts):
    client, app, service, clock = alerts
    wire = await bind_wechat(client, app, service)
    await upsert(client)
    clock[0] += timedelta(seconds=1)
    assert (await run(service))[1] == "triggered"
    async with app.state.db.connection() as conn:
        binding = await (
            await conn.execute("SELECT * FROM business_notification_bindings WHERE channel='wechat'")
        ).fetchone()
        cipher = service.providers.security.encrypt(
            "AnotherSyntheticMember", "recipient:" + binding["owner_id"] + ":wechat"
        )
        await conn.execute(
            "UPDATE business_notification_bindings SET recipient_cipher=%s,verified_at=clock_timestamp() WHERE owner_id=%s AND channel='wechat'",
            (cipher, binding["owner_id"]),
        )
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute(
                    "UPDATE business_notification_deliveries SET binding_fingerprint='retarget' WHERE channel='wechat'"
                )
    assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "cancelled"
    assert len(wire.messages) == 1


async def test_per_owner_read_write_budgets_survive_worker_restart_and_preserve_no_domain_get_writes(alerts):
    client, app, _, _ = alerts
    owner = (await client.get("/api/price-alerts")).json()["accountId"]
    async with app.state.db.connection() as conn:
        await conn.execute(
            "INSERT INTO auth_rate_limits(bucket,window_start,attempts) VALUES(%s,clock_timestamp(),60) ON CONFLICT(bucket) DO UPDATE SET attempts=60,window_start=excluded.window_start",
            (digest("price-alerts:write:" + owner),),
        )
    response, _ = await mutate(client, {"action": "test", "channel": "app"})
    assert response.status_code == 429
    assert (await client.get("/api/price-alerts")).status_code == 200
    async with app.state.db.connection() as conn:
        await conn.execute(
            "UPDATE auth_rate_limits SET attempts=180,window_start=clock_timestamp() WHERE bucket=%s",
            (digest("price-alerts:read:" + owner),),
        )
    assert (await client.get("/api/price-alerts")).status_code == 429
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM price_alert_operations")).fetchone())[
            "n"
        ] == 0


async def test_other_owner_cannot_read_receipts_configurations_or_reuse_confirmation_proof(alerts):
    client, app, service, _ = alerts
    await bind_wechat(client, app, service)
    _, _, operation = await upsert(client)
    first = (await client.get("/api/price-alerts")).json()["accountId"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as other:
        registered = await other.post(
            "/api/session/register", json={"username": "SecondAlertOwner", "password": "Synthetic9Pass"}
        )
        assert registered.status_code == 201, registered.text
        other.headers["x-csrf-token"] = registered.json()["csrf"]
        assert (await other.get("/api/price-alerts/operations/" + operation)).status_code == 404
        snapshot = (await other.get("/api/price-alerts")).json()
        assert snapshot["accountId"] != first and snapshot["rules"] == []
        configs = (await other.get("/api/notifications/providers")).json()["providers"]
        assert all(not row["configured"] and row["revision"] is None for row in configs)
        async with app.state.db.connection() as conn:
            uid = (
                await (
                    await conn.execute(
                        "SELECT id FROM business_notification_deliveries WHERE channel='wechat' LIMIT 1"
                    )
                ).fetchone()
            )["id"]
        assert (await other.get("/api/notifications/deliveries/" + str(uid))).status_code == 404
