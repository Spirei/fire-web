"""One durable polling cursor per verified bot, routing nonce proofs to their exact owner."""

import hashlib
import json
import re
from uuid import uuid4

from psycopg.types.json import Jsonb

from .fx_reference import external_delivery_blocked
from .notification_bindings import subject_alive


async def poll(providers, worker_id):
    db, security = providers.db, providers.security
    async with db.connection() as conn, conn.transaction():
        if await external_delivery_blocked(conn):
            return "restore_quarantined"
        candidates = await (
            await conn.execute("""SELECT p.*,v.identity FROM business_notification_provider_revisions p
            JOIN LATERAL (SELECT * FROM business_notification_provider_checks WHERE owner_id=p.owner_id AND provider_revision=p.revision ORDER BY checked_at DESC LIMIT 1) v ON v.status='verified'
            WHERE p.channel='telegram' AND p.revision=(SELECT q.revision FROM business_notification_provider_revisions q WHERE q.owner_id=p.owner_id AND q.channel=p.channel ORDER BY q.created_at DESC,q.revision DESC LIMIT 1)
            AND EXISTS(SELECT 1 FROM business_notification_challenges c WHERE c.owner_id=p.owner_id AND c.provider_revision=p.revision AND c.channel='telegram' AND c.state='queued' AND c.token_mac IS NOT NULL AND c.expires_at>clock_timestamp())
            ORDER BY p.created_at LIMIT 100""")
        ).fetchall()
        chosen = None
        for row in candidates:
            try:
                pending = await (
                    await conn.execute(
                        "SELECT * FROM business_notification_challenges WHERE owner_id=%s AND provider_revision=%s AND state='queued' AND token_mac IS NOT NULL AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 1",
                        (row["owner_id"], row["revision"]),
                    )
                ).fetchone()
                if pending is None or not await subject_alive(conn, pending):
                    continue
                target, config = providers.materialize(row)
                bot_id = row["identity"]["identity"]
                if not isinstance(bot_id, str) or not bot_id.isdecimal():
                    continue
            except Exception:  # noqa: BLE001,S112 -- Unavailable targets confer no permission; never log credential/URL errors.
                continue
            await conn.execute(
                "INSERT INTO business_notification_telegram_state(bot_id,origin_instance) VALUES(%s,%s) ON CONFLICT DO NOTHING",
                (bot_id, db.settings.instance_id),
            )
            lease = await (
                await conn.execute(
                    """UPDATE business_notification_telegram_state SET lease_owner=%s,lease_version=lease_version+1,
                lease_until=clock_timestamp()+interval '30 seconds' WHERE bot_id=%s AND origin_instance=%s
                AND (lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *""",
                    (worker_id, bot_id, db.settings.instance_id),
                )
            ).fetchone()
            if lease:
                chosen = row
                break
        if chosen is None:
            return "idle"
    try:
        response = await providers.wire(target).call(
            "api",
            "POST",
            "/bot" + config["botToken"] + "/getUpdates",
            json_body={
                "offset": lease["next_offset"],
                "limit": 100,
                "timeout": 3,
                "allowed_updates": ["message"],
            },
        )
        updates = response.get("result")
        if response.get("ok") is not True or not isinstance(updates, list) or len(updates) > 100:
            raise ValueError("incoming_contract_invalid")
        identifiers = [row.get("update_id") for row in updates if isinstance(row, dict)]
        if (
            len(identifiers) != len(updates)
            or any(type(value) is not int or value < lease["next_offset"] for value in identifiers)
            or len(set(identifiers)) != len(identifiers)
        ):
            raise ValueError("incoming_cursor_invalid")
    except Exception:  # noqa: BLE001 -- Read failures never prove a recipient or produce a notification.
        async with db.connection() as conn:
            await conn.execute(
                "UPDATE business_notification_telegram_state SET lease_until=NULL WHERE bot_id=%s AND origin_instance=%s AND lease_owner=%s AND lease_version=%s",
                (bot_id, db.settings.instance_id, worker_id, lease["lease_version"]),
            )
        return "source_unknown"
    async with db.connection() as conn, conn.transaction():
        if await external_delivery_blocked(conn):
            return "restore_quarantined"
        current = await providers.current(conn, chosen["owner_id"], "telegram")
        providers.materialize(chosen)
        if current is None or current["revision"] != chosen["revision"]:
            return "configuration_changed"
        owned = await (
            await conn.execute(
                """SELECT 1 FROM business_notification_telegram_state WHERE bot_id=%s AND origin_instance=%s
            AND lease_owner=%s AND lease_version=%s AND lease_until>clock_timestamp() FOR UPDATE""",
                (bot_id, db.settings.instance_id, worker_id, lease["lease_version"]),
            )
        ).fetchone()
        if not owned:
            return "lost"
        page_id = uuid4()
        raw = getattr(response, "raw", None)
        representation = (
            "http_response_body" if isinstance(raw, bytes) else "controlled_response_representation"
        )
        raw = (
            raw
            if isinstance(raw, bytes)
            else json.dumps(response, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        )
        await conn.execute(
            """INSERT INTO business_notification_telegram_pages(id,bot_id,provider_owner,provider_revision,raw_ciphertext,raw_sha256,representation)
            VALUES(%s,%s,%s,%s,%s,%s,%s)""",
            (
                page_id,
                bot_id,
                chosen["owner_id"],
                chosen["revision"],
                security.encrypt(raw.decode(), "telegram-page:" + str(page_id)),
                hashlib.sha256(raw).hexdigest(),
                representation,
            ),
        )
        received = 0
        for index, update in enumerate(updates):
            message = update.get("message")
            if not isinstance(message, dict) or not isinstance(message.get("text"), str):
                continue
            match = re.fullmatch(r"/start(?:@([A-Za-z0-9_]+))? ([A-Za-z0-9_-]{43})", message["text"])
            chat, sender = message.get("chat"), message.get("from")
            if (
                not match
                or not isinstance(chat, dict)
                or not isinstance(sender, dict)
                or chat.get("type") != "private"
                or type(chat.get("id")) is not int
                or chat["id"] <= 0
                or chat["id"] != sender.get("id")
                or sender.get("is_bot") is True
                or match[1]
                and match[1].lower() != config["botUsername"].lower()
            ):
                continue
            candidate = await (
                await conn.execute(
                    """SELECT c.* FROM business_notification_challenges c
                JOIN business_notification_provider_checks v ON v.owner_id=c.owner_id AND v.provider_revision=c.provider_revision AND v.status='verified'
                WHERE c.token_mac=%s AND c.channel='telegram' AND c.expires_at>clock_timestamp() AND c.state='queued'
                AND v.identity->>'identity'=%s ORDER BY v.checked_at DESC LIMIT 1 FOR UPDATE OF c""",
                    (security.mac(["telegram-start", match[2]]), bot_id),
                )
            ).fetchone()
            if not candidate or not await subject_alive(conn, candidate):
                continue
            provider = await providers.current(conn, candidate["owner_id"], "telegram")
            providers.materialize(provider)
            if provider["revision"] != candidate["provider_revision"]:
                continue
            incoming_id = uuid4()
            record = json.dumps(update, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            await conn.execute(
                """INSERT INTO business_notification_incoming(owner_id,id,provider_revision,external_id,raw_ciphertext,raw_sha256,page_id,json_pointer)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
                (
                    candidate["owner_id"],
                    incoming_id,
                    provider["revision"],
                    str(update["update_id"]),
                    security.encrypt(record, "incoming:" + str(incoming_id)),
                    hashlib.sha256(record.encode()).hexdigest(),
                    page_id,
                    "/result/" + str(index),
                ),
            )
            await conn.execute(
                """UPDATE business_notification_challenges SET recipient_cipher=%s,state='received',token_mac=NULL,incoming_id=%s
                WHERE owner_id=%s AND id=%s""",
                (
                    security.encrypt(str(chat["id"]), "challenge-recipient:" + str(candidate["id"])),
                    incoming_id,
                    candidate["owner_id"],
                    candidate["id"],
                ),
            )
            await conn.execute(
                "UPDATE price_alert_collections SET channel_revision=channel_revision+1,revision=revision+1,preferences=preferences||%s WHERE owner_id=%s",
                (Jsonb({"telegram": False}), candidate["owner_id"]),
            )
            received += 1
        await conn.execute(
            "UPDATE business_notification_telegram_state SET next_offset=%s,lease_until=NULL WHERE bot_id=%s AND origin_instance=%s AND lease_owner=%s AND lease_version=%s",
            (
                max(identifiers) + 1 if identifiers else lease["next_offset"],
                bot_id,
                db.settings.instance_id,
                worker_id,
                lease["lease_version"],
            ),
        )
        return {"received": received, "pageId": str(page_id)}
