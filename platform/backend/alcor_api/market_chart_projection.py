"""Ready-to-serve minute charts built once by the Worker, not on every read."""

import json
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from psycopg.types.json import Jsonb

from .market_contract import ZONES, series_fingerprint


async def rebuild(conn, stream, policy, query):
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
        rows, policy, query, 1, datetime.now(UTC), session_day=query.market == "US"
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


async def read(conn, owner, revision, pairs, session, *, cache=None, instance_id=""):
    """Read projected series; an optional Redis layer shares the same payloads."""
    unique = sorted({(market, code) for market, code in pairs if market and code})
    if not unique:
        return {}
    prefix = f"alcor:{instance_id}:chart-projection:{owner}:{revision}:{session}:"
    keys = {pair: prefix + pair[0] + ":" + pair[1] for pair in unique}
    found = {}
    if cache is not None:
        try:
            import asyncio

            values = await asyncio.wait_for(
                cache.mget([keys[pair] for pair in unique]), 1
            )
            for pair, value in zip(unique, values):
                if value is not None:
                    found[pair] = (json.loads(value), None)
        except Exception:  # noqa: BLE001 -- cache is optional; PG remains authority
            found = {}
    missing = [pair for pair in unique if pair not in found]
    if missing:
        rows = await (
            await conn.execute(
                """SELECT market,code,payload,generation FROM market_chart_projections
                   WHERE owner_id=%s AND source_revision=%s AND session=%s
                     AND (market,code) IN (SELECT * FROM unnest(%s::text[],%s::text[]))""",
                (
                    owner,
                    revision,
                    session,
                    [market for market, _ in missing],
                    [code for _, code in missing],
                ),
            )
        ).fetchall()
        for row in rows:
            pair = (row["market"].upper(), row["code"].upper())
            found[pair] = (row["payload"], row["generation"])
            if cache is not None:
                try:
                    await asyncio.wait_for(
                        cache.setex(keys[pair], 10, json.dumps(row["payload"], ensure_ascii=False)),
                        1,
                    )
                except Exception:  # noqa: BLE001
                    pass
    return found
