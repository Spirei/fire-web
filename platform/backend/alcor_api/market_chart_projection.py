"""Ready-to-serve minute charts built once by the Worker, not on every read."""

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from psycopg.types.json import Jsonb

from .market_contract import ZONES, series_fingerprint


async def rebuild(conn, stream, policy, query, now=None):
    """Build the latest one-day chart payload from the facts just collected."""
    if query.frame != "minute" or query.kind not in ("bars", "price_series"):
        return False
    rows = await (
        await conn.execute(
            """SELECT * FROM (SELECT DISTINCT ON (source_time) * FROM market_facts
               WHERE owner_id=%s AND source_revision=%s AND series_fingerprint=%s
               ORDER BY source_time DESC,sequence DESC) newest
               ORDER BY source_time DESC LIMIT %s""",
            (stream["owner_id"], stream["source_revision"], series_fingerprint(query), 16001),
        )
    ).fetchall()
    if not rows or len(rows) > 16000:
        return False
    from .legacy_chart_series import minute_points, sample_points

    points = minute_points(
        rows, policy, query, 1, now or datetime.now(UTC), session_day=query.market == "US"
    )
    if len(points) < 2:
        return False
    latest = max(point["date"] for point in points)
    selected = [
        {key: point[key] for key in ("time", "price", "volume")}
        for point in points
        if point["date"] == latest
    ]
    if not selected:
        return False
    source_time = datetime.fromisoformat(latest + "T" + selected[-1]["time"]).replace(
        tzinfo=ZoneInfo(ZONES[query.market])
    )
    payload = {
        "date": latest,
        "stale": None,
        "sourceObservedAt": source_time.isoformat(),
        "expectedSessionKnown": False,
        "points": selected,
        "sampled": sample_points(selected),
        "source": policy.source,
    }
    await conn.execute(
        """INSERT INTO market_chart_projections(owner_id,source_revision,market,code,session,payload)
           VALUES(%s,%s,%s,%s,%s,%s)
           ON CONFLICT(owner_id,source_revision,market,code,session) DO UPDATE
           SET payload=excluded.payload,generation=market_chart_projections.generation+1,
               updated_at=clock_timestamp()""",
        (
            stream["owner_id"],
            stream["source_revision"],
            query.market,
            query.code,
            query.session,
            Jsonb(payload),
        ),
    )
    return True


async def backfill(authority, limit=10):
    """Build missing projections from retained facts; never calls a provider."""
    if type(limit) is not int or not 1 <= limit <= 50:
        raise ValueError("chart_projection_backfill_invalid")
    from .market_authority import query_from

    async with authority.db.connection() as conn, conn.transaction():
        rows = await (
            await conn.execute(
                """SELECT s.owner_id,s.source_revision,s.id,s.query FROM market_streams s
                   JOIN tasks t ON t.id=s.current_task_id
                   WHERE s.query->>'frame'='minute' AND s.query->>'kind' IN ('bars','price_series')
                     AND t.status='succeeded'
                     AND NOT EXISTS (SELECT 1 FROM market_chart_projections p
                       WHERE p.owner_id=s.owner_id AND p.source_revision=s.source_revision
                         AND p.market=s.query->>'market' AND p.code=s.query->>'code'
                         AND p.session=s.query->>'session')
                   ORDER BY s.next_due,s.owner_id,s.id LIMIT %s""",
                (limit,),
            )
        ).fetchall()
        built = 0
        clock = getattr(authority, "clock", None)
        for row in rows:
            try:
                _, policy = await authority.config(conn, row["owner_id"], row["source_revision"])
                if await rebuild(conn, row, policy, query_from(row["query"]), clock() if clock else None):
                    built += 1
            except Exception:  # noqa: BLE001 -- one unusable stream must not block the rest
                continue
        return built


async def read_current(conn, owner, pairs, session):
    """Read the newest projection per security; the caller checks each license."""
    unique = sorted({(market, code) for market, code in pairs if market and code})
    if not unique:
        return {}
    rows = await (
        await conn.execute(
            """SELECT DISTINCT ON (market,code) market,code,source_revision,payload,generation
               FROM market_chart_projections
               WHERE owner_id=%s AND session=%s
                 AND (market,code) IN (SELECT * FROM unnest(%s::text[],%s::text[]))
               ORDER BY market,code,updated_at DESC""",
            (owner, session, [market for market, _ in unique], [code for _, code in unique]),
        )
    ).fetchall()
    return {
        (row["market"].upper(), row["code"].upper()): (
            str(row["source_revision"]), row["payload"], row["generation"]
        )
        for row in rows
    }


async def read(conn, owner, revision, pairs, session):
    """Read projected series directly; the payload is already assembled."""
    unique = sorted({(market, code) for market, code in pairs if market and code})
    if not unique:
        return {}
    rows = await (
        await conn.execute(
            """SELECT market,code,payload,generation FROM market_chart_projections
               WHERE owner_id=%s AND source_revision=%s AND session=%s
                 AND (market,code) IN (SELECT * FROM unnest(%s::text[],%s::text[]))""",
            (
                owner,
                revision,
                session,
                [market for market, _ in unique],
                [code for _, code in unique],
            ),
        )
    ).fetchall()
    return {
        (row["market"].upper(), row["code"].upper()): (row["payload"], row["generation"])
        for row in rows
    }
