"""Actual encrypted backup/restore preserves authority and never replays old notification sends."""

from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import psycopg
import pytest_asyncio
import test_backups as backups
from alcor_api.business_notification_worker import dispatch_one
from alcor_api.business_notifications import bridge_dividends
from alcor_api.db import Database
from alcor_api.main import create_app
from alcor_api.market_calendar import Calendars
from alcor_api.notification_bindings import Bindings
from alcor_api.notification_providers import Providers
from alcor_api.notification_sender import Sender
from alcor_api.price_alert_service import Alerts
from alcor_api.security import Identity, digest
from psycopg.rows import dict_row

from .source_fixture import ingest
from .test_notification_bindings import ControlledSmtp, ControlledWire, binding_mutation, configure, install
from .test_price_alerts import Reader, alert_settings, upsert

__all__ = ["alert_settings"]


@pytest_asyncio.fixture
async def configured(alert_settings, pg, tmp_path):
    async for value in backups.configured.__wrapped__(alert_settings, pg, tmp_path):
        yield value


@pytest_asyncio.fixture
async def backup_app(configured):
    app = create_app(configured)
    clock = lambda: datetime(2026, 10, 20, 14, tzinfo=UTC)
    service = app.state.price_alert_candidate
    service.reader, service.now = Reader(clock), clock
    install(service)
    async with app.router.lifespan_context(app):
        await Calendars(app.state.db).ensure_builtin()
        yield app


bc = backups.bc


async def test_actual_encrypted_restore_retains_receipts_and_never_automatically_delivers(
    bc, backup_app, configured
):
    service = backup_app.state.price_alert_candidate
    await upsert(bc)
    await configure(bc, "wechat")
    response, _ = await binding_mutation(
        bc, {"action": "wechat_start", "recipient": "SyntheticMember", "revision": 0}
    )
    assert response.status_code == 200
    await ingest(bc, backup_app)
    async with backup_app.state.db.connection() as conn, conn.transaction():
        assert await bridge_dividends(conn) == 1
    tables = (
        "price_alert_collections",
        "price_alert_rules",
        "price_alert_subscriptions",
        "price_alert_jobs",
        "price_alert_operations",
        "business_notification_events",
        "business_notification_deliveries",
        "business_notification_sources",
        "business_notification_security_proofs",
        "business_notification_provider_revisions",
        "business_notification_provider_checks",
        "business_notification_challenges",
    )
    async with backup_app.state.db.connection() as conn:
        original = {
            table: await (await conn.execute("SELECT * FROM " + table + " ORDER BY 1,2")).fetchall()
            for table in tables
        }
        owner = original["price_alert_rules"][0]["owner_id"]
    backup_id, _ = await backups.create_capsule(bc, backup_app, configured)
    preview = await bc.get(
        "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert preview.status_code == 200, preview.text
    job, _ = await backups.submit(
        bc,
        "backup.restore",
        backup_id=backup_id,
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    receipt = await backups.execute(backup_app, configured, UUID(job["id"]))
    assert receipt["sessions_revoked"]
    target = configured.restore_targets[0]
    token = "synthetic-business-notification-restore-" + uuid4().hex
    async with await psycopg.AsyncConnection.connect(
        target.database_url.get_secret_value(), row_factory=dict_row
    ) as conn:
        for table in tables:
            assert (
                await (await conn.execute("SELECT * FROM " + table + " ORDER BY 1,2")).fetchall()
                == original[table]
            ), table
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (owner,))).fetchone()
        await conn.execute(
            "INSERT INTO sessions(token_hash,user_id,session_version,expires_at,client_id) VALUES(%s,%s,%s,clock_timestamp()+interval '1 day','new-web')",
            (digest(token), owner, user["session_version"]),
        )
    recovery = configured.model_copy(
        update={"database_url": target.database_url, "instance_id": target.instance_id, "environment": "test"}
    )
    db = Database(recovery)
    await db.open()
    try:
        recovered = Alerts(db)
        wire, smtp = ControlledWire(), ControlledSmtp()
        recovered.providers = Providers(
            db,
            tuple(service.providers.targets.values()),
            wire_factory=lambda target: wire,
            smtp_factory=lambda target: smtp,
        )
        recovered.bindings = Bindings(recovered, recovered.providers)
        who = Identity(
            id=owner,
            username=user["username"],
            role=user["role"],
            token_hash=digest(token),
            csrf="",
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )
        snapshot = await recovered.snapshot(who)
        assert snapshot["rules"][0]["status"] == "paused"
        channel = next(row for row in snapshot["channels"] if row["channel"] == "wechat")
        assert not channel["configured"] and not channel["ready"]
        assert await dispatch_one(db, uuid4(), Sender(recovered.bindings)) == "restore_quarantined"
        assert wire.calls == [] and smtp.messages == []
        async with db.connection() as conn:
            await conn.execute(
                "UPDATE restore_quarantine SET payload='{"
                + '"disabled":false'
                + "}'::jsonb WHERE category='external_delivery_disabled'"
            )
        # Clearing the temporary guard still cannot activate the original instance's queued delivery.
        assert await dispatch_one(db, uuid4(), Sender(recovered.bindings)) == "cancelled"
        assert wire.calls == [] and smtp.messages == []
        async with db.connection() as conn:
            assert (await (await conn.execute("SELECT count(*) AS n FROM cash_ledger_entries")).fetchone())[
                "n"
            ] == 0
    finally:
        await db.close()
