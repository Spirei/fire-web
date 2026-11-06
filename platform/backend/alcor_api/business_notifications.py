"""Shared business-event/inbox authority; identity verification mail stays separate."""

import hashlib
from uuid import NAMESPACE_URL, uuid4, uuid5

from psycopg.types.json import Jsonb


def binding_fingerprint(row):
    return hashlib.sha256(
        (
            row["config_stamp"] + "\0" + row["recipient_cipher"] + "\0" + row["verified_at"].isoformat()
        ).encode()
    ).hexdigest()


async def append(conn, owner, kind, cause, payload, *, channels=("app",), created_at=None, with_status=False):
    identifier = uuid5(NAMESPACE_URL, "alcor-business-notification:" + owner + ":" + cause)
    inserted = await (
        await conn.execute(
            """INSERT INTO business_notification_events(owner_id,id,kind,cause_key,payload,created_at)
        VALUES(%s,%s,%s,%s,%s,COALESCE(%s,clock_timestamp())) ON CONFLICT(owner_id,cause_key) DO NOTHING RETURNING id""",
            (owner, identifier, kind, cause, Jsonb(payload), created_at),
        )
    ).fetchone()
    # A repeated business cause must not fan out to a channel enabled later.
    if inserted is None:
        return (str(identifier), False) if with_status else str(identifier)
    for channel in channels:
        binding = (
            await (
                await conn.execute(
                    "SELECT config_stamp,recipient_cipher,verified_at FROM business_notification_bindings WHERE owner_id=%s AND channel=%s AND verified_at IS NOT NULL AND revoked_at IS NULL",
                    (owner, channel),
                )
            ).fetchone()
            if channel != "app" and kind != "notification.binding"
            else None
        )
        await conn.execute(
            """INSERT INTO business_notification_deliveries(owner_id,id,event_id,channel,state,origin_instance,binding_fingerprint)
            VALUES(%s,%s,%s,%s,%s,(SELECT instance_id FROM alcor_instance WHERE singleton),%s) ON CONFLICT(owner_id,event_id,channel) DO NOTHING""",
            (
                owner,
                uuid4(),
                identifier,
                channel,
                "delivered" if channel == "app" else "queued",
                binding_fingerprint(binding) if binding else None,
            ),
        )
    return (str(identifier), True) if with_status else str(identifier)


async def bridge_dividends(conn, limit=100):
    """Explicit Worker projection of frozen archives; never a second external dispatcher."""
    exists = await (await conn.execute("SELECT to_regclass('dividend_review_notices') AS name")).fetchone()
    if exists["name"] is None:
        return 0
    rows = await (
        await conn.execute(
            """SELECT n.* FROM dividend_review_notices n LEFT JOIN business_notification_sources s
        ON s.owner_id=n.owner_id AND s.domain='dividend.review' AND s.source_id=n.id::text
        WHERE s.source_id IS NULL ORDER BY n.sequence LIMIT %s""",
            (limit,),
        )
    ).fetchall()
    for row in rows:
        identifier = await append(
            conn,
            row["owner_id"],
            "dividend.review",
            "dividend.review:" + str(row["id"]),
            {
                "sourceNoticeId": str(row["id"]),
                "sourceTaskId": str(row["task_id"]),
                "contents": row["contents"],
                "cashWritten": False,
            },
            created_at=row["created_at"],
        )
        await conn.execute(
            """INSERT INTO business_notification_sources(owner_id,domain,source_id,event_id)
            VALUES(%s,'dividend.review',%s,%s) ON CONFLICT DO NOTHING""",
            (row["owner_id"], str(row["id"]), identifier),
        )
    return len(rows)


async def inbox(conn, owner, *, kinds=None, limit=200):
    rows = await (
        await conn.execute(
            """SELECT e.*,r.read_at FROM business_notification_events e LEFT JOIN business_notification_reads r
        ON r.owner_id=e.owner_id AND r.event_id=e.id WHERE e.owner_id=%s
        AND (%s::text[] IS NULL OR e.kind=ANY(%s)) ORDER BY e.created_at DESC,e.id DESC LIMIT %s""",
            (owner, kinds, kinds, limit),
        )
    ).fetchall()
    result = []
    for row in rows:
        deliveries = await (
            await conn.execute(
                "SELECT id,channel,state FROM business_notification_deliveries WHERE owner_id=%s AND event_id=%s ORDER BY channel",
                (owner, row["id"]),
            )
        ).fetchall()
        result.append(
            {
                **row["payload"],
                "id": str(row["id"]),
                "read": row["read_at"] is not None,
                "deliveries": [{**delivery, "id": str(delivery["id"])} for delivery in deliveries],
            }
        )
    return result
