"""Adversarial confirmation, cancellation, expiration and encrypted-key boundaries."""

import time
from datetime import timedelta
from uuid import uuid4

from alcor_api.business_notification_worker import dispatch_one
from alcor_api.connections import Vault
from alcor_api.native_identity import totp_code
from alcor_api.notification_sender import Sender

from .test_notification_bindings import (
    VALUES,
    alert_settings,
    alerts,
    binding_mutation,
    configure,
    install,
    proof,
)
from .test_price_alerts import rule, run, upsert

__all__ = ["alert_settings", "alerts"]


async def test_enabled_factor_required_for_current_password_confirmation(alerts):
    client, app, service, _ = alerts
    install(service)
    raw = {
        "requestId": str(uuid4()),
        "channel": "discord",
        "targetId": "fixture-discord",
        "expectedRevision": None,
        "credentials": VALUES["discord"],
    }
    secret = "JBSWY3DPEHPK3PXP"
    async with app.state.db.connection() as conn:
        owner = (await (await conn.execute("SELECT id FROM users")).fetchone())["id"]
        cipher = Vault(app.state.db.settings.connection_secret_dir).encrypt(
            secret, "totp:" + owner, app.state.db.settings.instance_id
        )
        await conn.execute(
            "INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext) VALUES(%s,true,%s) ON CONFLICT(user_id) DO UPDATE SET totp_enabled=true,totp_secret_ciphertext=excluded.totp_secret_ciphertext",
            (owner, cipher),
        )
    denied = await client.post(
        "/api/notifications/security/verify",
        json={"operation": raw, "currentPassword": "Synthetic9Pass", "code": ""},
    )
    assert denied.status_code == 403
    ticket = await proof(client, raw, code=totp_code(secret, int(time.time())))
    accepted = await client.post(
        "/api/notifications/providers", json=raw, headers={"x-alcor-notification-proof": ticket}
    )
    assert accepted.status_code == 200, accepted.text


async def test_configuration_revoke_and_qq_disconnect_need_no_working_provider(alerts):
    client, _, service, _ = alerts
    wire, _ = install(service)
    revision = await configure(client, "qq")
    response, _ = await binding_mutation(client, {"action": "qq_disconnect", "revision": 0})
    assert response.status_code == 200, response.text
    raw = {"action": "provider_revoke", "revision": revision, "requestId": str(uuid4())}
    ticket = await proof(client, raw)
    service.providers.targets.clear()
    count = len(wire.calls)
    response = await client.post(
        "/api/notifications/providers/" + revision + "/revoke",
        json={"requestId": raw["requestId"]},
        headers={"x-alcor-notification-proof": ticket},
    )
    assert response.status_code == 200 and response.json()["revoked"]
    saved = await client.get("/api/notifications/providers")
    assert saved.status_code == 200
    qq = next(row for row in saved.json()["providers"] if row["channel"] == "qq")
    assert qq["revision"] == revision and not qq["active"] and not qq["configured"]
    assert len(wire.calls) == count


async def test_missing_original_key_never_silently_creates_replacement(alerts):
    client, app, service, _ = alerts
    install(service)
    await configure(client, "wechat")
    directory = app.state.db.settings.connection_secret_dir
    (directory / "connections.key").unlink()
    result = await client.post(
        "/api/notifications/security/verify",
        json={
            "operation": {"action": "wechat_disconnect", "revision": 0},
            "currentPassword": "Synthetic9Pass",
            "code": "",
        },
    )
    assert result.status_code == 503 and not (directory / "connections.key").exists()


async def test_disconnect_cancels_unsent_challenge_without_transport(alerts):
    client, app, service, _ = alerts
    wire, _ = install(service)
    await configure(client, "wechat")
    response, _ = await binding_mutation(
        client, {"action": "wechat_start", "recipient": "SyntheticMember", "revision": 0}
    )
    assert response.status_code == 200
    response, _ = await binding_mutation(client, {"action": "wechat_disconnect", "revision": 1})
    assert response.status_code == 200
    assert await dispatch_one(app.state.db, uuid4(), Sender(service.bindings)) == "idle"
    assert wire.messages == []


async def test_expiry_while_quote_is_inflight_cannot_trigger(alerts):
    client, _, service, clock = alerts
    await upsert(client, rule(expiresAt=int(clock[0].timestamp() * 1000) + 1000))
    original = service.reader.read

    async def late(row):
        clock[0] += timedelta(seconds=2)
        return await original(row)

    service.reader.read = late
    assert (await run(service))[1] == "expired"
    snapshot = (await client.get("/api/price-alerts")).json()
    assert snapshot["events"] == [] and snapshot["rules"][0]["status"] == "expired"


async def test_daily_period_is_one_event_for_one_owner_rule_revision(alerts):
    client, app, service, clock = alerts
    await upsert(client, rule(frequency="daily"))
    clock[0] += timedelta(seconds=1)
    assert (await run(service))[1] == "triggered_daily"
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE price_alert_jobs SET next_scan_at=clock_timestamp()-interval '1 second'")
    clock[0] += timedelta(seconds=1)
    assert (await run(service))[1] == "already_triggered_for_period"
    assert len((await client.get("/api/price-alerts")).json()["events"]) == 1
