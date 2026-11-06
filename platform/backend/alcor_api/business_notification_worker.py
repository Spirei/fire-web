"""One shared delivery authority. Unknown outcomes are queried, never replayed."""

from dataclasses import dataclass

from psycopg.types.json import Jsonb

from .business_notifications import binding_fingerprint
from .fx_reference import external_delivery_blocked


@dataclass(frozen=True)
class Acceptance:
    provider_receipt: str
    protocol: str


class Rejected(Exception):
    """A transport has definitive evidence the provider rejected before acceptance."""


async def allowed(conn, event):
    # Future domains must install their own explicit policy; a source row is not consent to external delivery.
    if event["kind"] == "notification.binding":
        from .notification_bindings import subject_alive

        challenge = await (
            await conn.execute(
                """SELECT c.* FROM business_notification_challenges c
            WHERE c.owner_id=%s AND c.id=%s AND c.channel=%s AND c.expires_at>clock_timestamp()
            AND c.state IN ('queued','sending') AND c.code_cipher IS NOT NULL""",
                (event["owner_id"], event["payload"].get("challengeId"), event["channel"]),
            )
        ).fetchone()
        return bool(challenge and await subject_alive(conn, challenge))
    if event["kind"] not in {"price.alert", "price.alert.test"}:
        return False
    from .price_alert_service import active_subscriptions

    payload = event["payload"]
    binding = await (
        await conn.execute(
            """SELECT b.* FROM business_notification_bindings b JOIN alcor_instance i
        ON i.singleton AND i.instance_id=b.origin_instance JOIN price_alert_collections c ON c.owner_id=b.owner_id
        WHERE b.owner_id=%s AND b.channel=%s AND b.verified_at IS NOT NULL AND b.revoked_at IS NULL
        AND (%s OR c.preferences->>%s='true')""",
            (event["owner_id"], event["channel"], event["kind"] == "price.alert.test", event["channel"]),
        )
    ).fetchone()
    if binding is None or binding_fingerprint(binding) != event.get("binding_fingerprint"):
        return False
    from .notification_bindings import subject_alive

    if not await subject_alive(conn, binding):
        return False
    if event["kind"] == "price.alert.test":
        from .notification_bindings import subject_alive

        return await subject_alive(
            conn,
            {
                "owner_id": event["owner_id"],
                "principal": payload.get("principal", ""),
                "native_grant_id": payload.get("nativeGrantId"),
                "session_version": payload.get("sessionVersion"),
            },
        )
    row = await (
        await conn.execute(
            "SELECT * FROM price_alert_rules WHERE owner_id=%s AND id=%s",
            (event["owner_id"], payload.get("ruleId")),
        )
    ).fetchone()
    return bool(
        row
        and row["revision"] == payload.get("ruleRevision")
        and row["state"] in {"enabled", "completed"}
        and row["account_id"] == payload.get("accountScope")
        and row["source_identity"] == payload.get("sourceIdentity")
        and await active_subscriptions(conn, row)
    )


async def dispatch_one(db, worker_id, sender=None):
    if sender is None:
        return "disabled"
    if getattr(sender, "fixture", False) and db.settings.environment != "test":
        raise ValueError("fixture_notification_adapter_outside_test")
    if not getattr(sender, "fixture", False) and not getattr(sender, "approved_external_access", False):
        return "disabled"
    async with db.connection() as conn, conn.transaction():
        # Recovery never sends old jobs, even after the target's temporary quarantine was cleared.
        if await external_delivery_blocked(conn):
            return "restore_quarantined"
        await conn.execute(
            """UPDATE business_notification_deliveries SET state='unknown',lease_until=NULL,
            receipt=%s,updated_at=clock_timestamp() WHERE state='sending' AND lease_until<clock_timestamp()""",
            (Jsonb({"reason": "delivery_outcome_unknown"}),),
        )
        candidate = await (
            await conn.execute("""SELECT owner_id,id FROM business_notification_deliveries
            WHERE channel<>'app' AND state='queued' ORDER BY updated_at,id LIMIT 1""")
        ).fetchone()
        if candidate is None:
            return "idle"
        # Match mutation lock order; no delivery lock is held while waiting for owner/grant locks.
        await conn.execute("SELECT id FROM users WHERE id=%s FOR SHARE", (candidate["owner_id"],))
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
            ("price-alert-owner:" + candidate["owner_id"],),
        )
        row = await (
            await conn.execute(
                """SELECT d.*,e.kind,e.payload,b.config_stamp AS binding_stamp FROM business_notification_deliveries d
            JOIN business_notification_events e ON e.owner_id=d.owner_id AND e.id=d.event_id
            LEFT JOIN business_notification_bindings b ON b.owner_id=d.owner_id AND b.channel=d.channel
            WHERE d.owner_id=%s AND d.id=%s AND d.state='queued' FOR UPDATE OF d SKIP LOCKED""",
                (candidate["owner_id"], candidate["id"]),
            )
        ).fetchone()

        if row is None:
            return "idle"
        if (
            str(row["origin_instance"]) != str(db.settings.instance_id)
            or not await allowed(conn, row)
            or not await sender.ready(row)
        ):
            await conn.execute(
                "UPDATE business_notification_deliveries SET state='cancelled',updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s",
                (row["owner_id"], row["id"]),
            )
            if row["kind"] == "notification.binding":
                await conn.execute(
                    "UPDATE business_notification_challenges SET state='cancelled',code_cipher=NULL WHERE owner_id=%s AND id=%s AND state='queued'",
                    (row["owner_id"], row["payload"]["challengeId"]),
                )
            return "cancelled"
        current = await (
            await conn.execute(
                """UPDATE business_notification_deliveries SET state='sending',lease_owner=%s,
            lease_version=lease_version+1,lease_until=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
            WHERE owner_id=%s AND id=%s RETURNING *""",
                (worker_id, row["owner_id"], row["id"]),
            )
        ).fetchone()
        if row["kind"] == "notification.binding":
            await conn.execute(
                "UPDATE business_notification_challenges SET state='sending' WHERE owner_id=%s AND id=%s AND state='queued'",
                (row["owner_id"], row["payload"]["challengeId"]),
            )

    async def authorize():
        async with db.connection() as conn, conn.transaction():
            if (
                await external_delivery_blocked(conn)
                or not await allowed(conn, row)
                or not await sender.ready(row)
            ):
                return False
            return bool(
                await (
                    await conn.execute(
                        """SELECT 1 FROM business_notification_deliveries WHERE owner_id=%s AND id=%s
                AND state='sending' AND lease_owner=%s AND lease_version=%s AND lease_until>clock_timestamp()
                AND origin_instance=%s""",
                        (
                            row["owner_id"],
                            row["id"],
                            worker_id,
                            current["lease_version"],
                            db.settings.instance_id,
                        ),
                    )
                ).fetchone()
            )

    try:
        # Adapter must call this immediately before its controlled transport opens a connection.
        outcome = await sender.send(row, authorize)
        if (
            not isinstance(outcome, Acceptance)
            or not outcome.provider_receipt
            or len(outcome.provider_receipt) > 128
            or outcome.protocol
            not in {
                "controlled-notification-receipt-v1",
                "telegram-bot-api",
                "wecom-application-message",
                "feishu-im-v1",
                "discord-api-v10",
                "qq-bot-api-v2",
                "smtp",
            }
        ):
            raise ValueError("unverified_acceptance")
        state, receipt = (
            "accepted",
            {"providerReceipt": outcome.provider_receipt, "protocol": outcome.protocol},
        )
    except Rejected:
        state, receipt = "failed", {"reason": "provider_rejected"}
    except Exception:  # noqa: BLE001 -- A timeout/SDK failure can already have delivered; no automatic retry.
        state, receipt = "unknown", {"reason": "delivery_outcome_unknown"}
    event = row
    async with db.connection() as conn, conn.transaction():
        updated = await (
            await conn.execute(
                """UPDATE business_notification_deliveries SET state=%s,receipt=%s,lease_until=NULL,
            updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s AND state='sending' AND lease_owner=%s
            AND lease_version=%s AND lease_until>clock_timestamp() RETURNING id""",
                (
                    state,
                    Jsonb(receipt),
                    current["owner_id"],
                    current["id"],
                    worker_id,
                    current["lease_version"],
                ),
            )
        ).fetchone()
        if event["kind"] == "notification.binding":
            await conn.execute(
                "UPDATE business_notification_challenges SET state=%s,code_cipher=NULL WHERE owner_id=%s AND id=%s AND state='sending'",
                (state if updated else "unknown", event["owner_id"], event["payload"]["challengeId"]),
            )
        return state if updated else "lost"
