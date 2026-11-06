"""Bounded independent monitoring cycle over the existing PG task/lease authority."""

import asyncio
import hashlib
import logging
from contextlib import asynccontextmanager
from uuid import uuid4

from psycopg.types.json import Jsonb

from .business_notifications import append, bridge_dividends
from .fx_reference import external_delivery_blocked
from .price_alert_contract import millis, price
from .price_alert_quotes import admissible, session_context
from .price_alert_service import active_subscriptions
from .worker import finish, owned_row


class Bound:
    def __init__(self, conn, settings):
        self.conn, self.settings = conn, settings

    @asynccontextmanager
    async def connection(self):
        yield self.conn


async def claim(db, worker):
    async with db.connection() as conn, conn.transaction():
        rows = await (
            await conn.execute("""UPDATE tasks SET status='cancelled',finished_at=clock_timestamp(),lease_until=NULL
            WHERE kind='alerts.monitor' AND status='cancel_requested' AND lease_until<clock_timestamp() RETURNING id""")
        ).fetchall()
        for row in rows:
            await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'cancelled')", (row["id"],))
        task = await (
            await conn.execute(
                """WITH c AS (SELECT t.id FROM tasks t JOIN price_alert_jobs j ON j.task_id=t.id
            WHERE t.kind='alerts.monitor' AND j.next_scan_at<=clock_timestamp() AND (t.status='queued' OR
            t.status='running' AND t.lease_until<clock_timestamp()) ORDER BY j.next_scan_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 1)
            UPDATE tasks t SET status='running',lease_owner=%s,lease_version=lease_version+1,attempts=attempts+1,
            lease_until=clock_timestamp()+make_interval(secs=>%s),started_at=COALESCE(started_at,clock_timestamp())
            FROM c WHERE t.id=c.id RETURNING t.*""",
                (worker, db.settings.lease_seconds),
            )
        ).fetchone()
        if task:
            await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'running')", (task["id"],))
        return task


async def current(conn, task):
    # Match mutation lock order: user -> owner -> task -> rule/grant.
    await conn.execute("SELECT id FROM users WHERE id=%s FOR SHARE", (task["owner_id"],))
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("price-alert-owner:" + task["owner_id"],)
    )
    owned = await owned_row(conn, task)
    if not owned:
        return None, None, "lost"
    row = await (
        await conn.execute(
            "SELECT r.* FROM price_alert_rules r JOIN price_alert_jobs j ON j.owner_id=r.owner_id AND j.rule_id=r.id WHERE j.task_id=%s FOR UPDATE OF r",
            (task["id"],),
        )
    ).fetchone()
    if (
        owned["status"] == "cancel_requested"
        or not row
        or row["state"] != "enabled"
        or row["revision"] != task["payload"]["revision"]
    ):
        return owned, row, "cancelled"
    if not await active_subscriptions(conn, row):
        return owned, row, "authorization_revoked"
    return owned, row, None


async def defer(conn, db, task, state):
    await conn.execute(
        "UPDATE price_alert_jobs SET next_scan_at=clock_timestamp()+interval '5 seconds',monitoring_state=%s WHERE task_id=%s",
        (state, task["id"]),
    )
    await conn.execute(
        "UPDATE tasks SET status='queued',lease_until=NULL,attempts=0,result=%s WHERE id=%s",
        (Jsonb({"monitoringState": state, "cashWritten": False}), task["id"]),
    )
    await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,%s)", (task["id"], state))


async def stop_task(conn, db, task, row, reason):
    if reason == "authorization_revoked" and row:
        await conn.execute(
            "UPDATE price_alert_rules SET state='paused',revision=revision+1 WHERE owner_id=%s AND id=%s",
            (row["owner_id"], row["id"]),
        )
    await conn.execute(
        "UPDATE price_alert_jobs SET monitoring_state=%s WHERE task_id=%s", (reason, task["id"])
    )
    await conn.execute("UPDATE tasks SET status='cancel_requested' WHERE id=%s", (task["id"],))
    return await finish(
        Bound(conn, db.settings), task, result={"monitoringState": reason, "cashWritten": False}
    )


async def execute(service, task):
    db = service.db
    async with db.connection() as conn, conn.transaction():
        _owned, row, reason = await current(conn, task)
        if reason == "lost":
            return reason
        if reason:
            await stop_task(conn, db, task, row, reason)
            return reason
        if row["config"]["expiresAt"] is not None and row["config"]["expiresAt"] <= millis(service.now()):
            await conn.execute(
                "UPDATE price_alert_rules SET state='expired',revision=revision+1 WHERE owner_id=%s AND id=%s",
                (row["owner_id"], row["id"]),
            )
            await stop_task(conn, db, task, row, "expired")
            return "expired"
        if await external_delivery_blocked(conn):
            await defer(conn, db, task, "restore_quarantined")
            return "restore_quarantined"
        reader=service.reader
        if reader is None:
            await defer(conn, db, task, "source_unknown")
            return "source_unknown"
    # No owner/task/grant locks while waiting for source I/O; pause/cancel stays responsive.
    try:
        quote = await reader.read(row)
    except Exception:  # noqa: BLE001 -- Sanitized source boundary, no secrets or error bodies in receipts.
        quote = None
    async with db.connection() as conn, conn.transaction():
        _owned, current_row, reason = await current(conn, task)
        if reason == "lost":
            return reason
        if reason:
            await stop_task(conn, db, task, current_row, reason)
            return reason
        if await external_delivery_blocked(conn):
            await defer(conn, db, task, "restore_quarantined")
            return "restore_quarantined"
        if current_row["config"]["expiresAt"] is not None and current_row["config"]["expiresAt"] <= millis(
            service.now()
        ):
            await conn.execute(
                "UPDATE price_alert_rules SET state='expired',revision=revision+1 WHERE owner_id=%s AND id=%s",
                (current_row["owner_id"], current_row["id"]),
            )
            await stop_task(conn, db, task, current_row, "expired")
            return "expired"
        if not admissible(quote, current_row, service.now(), db.settings.environment):
            await defer(conn, db, task, "source_unknown_or_stale")
            return "source_unknown_or_stale"
        source_guard=getattr(reader,'authorize_on_connection',None)
        source_reason=await source_guard(conn,current_row,quote) if source_guard else None if quote.fixture else 'source_authorization_unavailable'
        if source_reason:
            await defer(conn,db,task,source_reason)
            return source_reason
        context = await session_context(conn, quote)
        if context is None:
            await defer(conn, db, task, "market_session_unverified")
            return "market_session_unverified"
        identifier = uuid4()
        await conn.execute(
            """INSERT INTO price_alert_quote_evidence(id,task_id,owner_id,account_id,source_identity,source_id,source_version,
            market,code,received_at,raw_bytes,raw_sha256,normalized,fixture) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (
                identifier,
                task["id"],
                quote.owner,
                quote.account,
                quote.source_identity,
                quote.source_id,
                quote.version,
                quote.market,
                quote.code,
                quote.received,
                quote.raw,
                hashlib.sha256(quote.raw).hexdigest(),
                Jsonb(
                    {
                        "price": str(quote.amount),
                        "currency": quote.currency,
                        "time": quote.at.isoformat(),
                        "session": quote.session,
                        **context,
                    }
                ),
                quote.fixture,
            ),
        )
        await conn.execute(
            "UPDATE price_alert_rules SET last_quote_at=%s WHERE owner_id=%s AND id=%s",
            (quote.at, quote.owner, current_row["id"]),
        )
        cfg = current_row["config"]
        crossed = (
            quote.amount >= price(cfg["price"])
            if cfg["direction"] == "above"
            else quote.amount <= price(cfg["price"])
        )
        if not crossed:
            await defer(conn, db, task, "fresh_quote_below_threshold")
            return "fresh_quote_below_threshold"
        period = "once" if cfg["frequency"] == "once" else context["date"]
        cause = f"price-alert:{current_row['id']}:{current_row['revision']}:{period}"
        payload = {
            "ruleId": str(current_row["id"]),
            "ruleRevision": current_row["revision"],
            "name": cfg["name"],
            "code": cfg["code"],
            "market": cfg["market"],
            "currency": quote.currency,
            "direction": cfg["direction"],
            "target": cfg["price"],
            "price": float(quote.amount),
            "priceExact": str(quote.amount),
            "session": quote.session,
            "quoteTime": quote.at.isoformat(),
            "createdAt": millis(service.now()),
            "quoteEvidenceId": str(identifier),
            "calendarRevision": context["calendarRevision"],
            "accountScope": quote.account,
            "sourceIdentity": quote.source_identity,
            "cashWritten": False,
        }
        preferences = await (
            await conn.execute(
                "SELECT preferences FROM price_alert_collections WHERE owner_id=%s", (quote.owner,)
            )
        ).fetchone()
        channels = ["app"] if preferences["preferences"].get("app", True) else []
        for channel in ("email", "telegram", "wechat", "feishu", "discord", "qq"):
            if preferences["preferences"].get(channel, False):
                state = await service.bindings.state(conn, quote.owner, channel)
                if state["ready"]:
                    channels.append(channel)
        event_id, created = await append(
            conn,
            quote.owner,
            "price.alert",
            cause,
            payload,
            channels=channels,
            created_at=service.now(),
            with_status=True,
        )
        await conn.execute(
            "UPDATE price_alert_collections SET revision=revision+1 WHERE owner_id=%s", (quote.owner,)
        )
        if cfg["frequency"] == "once":
            await conn.execute(
                "UPDATE price_alert_rules SET state='completed' WHERE owner_id=%s AND id=%s",
                (quote.owner, current_row["id"]),
            )
            await conn.execute(
                "UPDATE price_alert_jobs SET monitoring_state='triggered' WHERE task_id=%s", (task["id"],)
            )
            await finish(
                Bound(conn, db.settings),
                task,
                result={"eventId": event_id, "monitoringState": "triggered", "cashWritten": False},
            )
            return "triggered"
        state = "triggered_daily" if created else "already_triggered_for_period"
        await defer(conn, db, task, state)
        return state


async def cycle(service, worker_id):
    async with service.db.connection() as conn, conn.transaction():
        await bridge_dividends(conn)
    task = await claim(service.db, worker_id)
    result = (
        {"taskId": str(task["id"]), "state": await execute(service, task)}
        if task
        else {"taskId": None, "state": "idle"}
    )
    from .business_notification_worker import dispatch_one
    from .notification_sender import Sender
    from .notification_telegram import poll

    result["telegram"] = await poll(service.providers, worker_id)
    result["delivery"] = await dispatch_one(service.db, worker_id, Sender(service.bindings))
    from . import __version__

    async with service.db.connection() as conn:
        await conn.execute(
            """INSERT INTO price_alert_worker_heartbeats(worker_id,origin_instance,release_version,source_fingerprint)
            VALUES(%s,%s,%s,%s) ON CONFLICT(worker_id) DO UPDATE SET origin_instance=excluded.origin_instance,
            release_version=excluded.release_version,source_fingerprint=excluded.source_fingerprint,observed_at=clock_timestamp()""",
            (
                worker_id,
                service.db.settings.instance_id,
                __version__,
                getattr(service.reader, "fingerprint", None),
            ),
        )
    return result


async def loop(service, worker_id, stop, current=lambda: True):
    """Existing Worker-owned lane: bounded alert work cannot wait behind historical backfill."""
    while not stop.is_set():
        if current():
            try:
                await cycle(service, worker_id)
            except Exception:  # noqa: BLE001 -- A failing provider never leaks credentials/URLs into logs.
                logging.getLogger("alcor.worker").warning("business_notification_cycle_unavailable")
        try:
            await asyncio.wait_for(stop.wait(), timeout=5)
        except TimeoutError:
            pass
