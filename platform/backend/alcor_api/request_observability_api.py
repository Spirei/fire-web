"""Administrator-only metadata snapshots and cross-instance bounded SSE leases."""

import asyncio
import contextlib
from datetime import UTC, datetime, timedelta, timezone
from uuid import uuid4

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from psycopg import Error as PostgresError
from psycopg_pool import PoolTimeout, TooManyRequests

from .api_documents import legacy_docs_user
from .db import TargetMismatch
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, web_identity
from .security import COOKIE, identity, lock_mutation_identity

STREAM_POLL_SECONDS = 15
LEGACY_SNAPSHOT_KEYS = (
    "revision",
    "today",
    "summary",
    "chart",
    "chartUnit",
    "endpoints",
    "logs",
    "pagination",
    "heatmap",
    "detailFrom",
)
READ_FAILURES = (PostgresError, PoolTimeout, TooManyRequests, TargetMismatch)


def filters(params, now):
    def pick(key, allowed, fallback):
        value = params.get(key)
        return value if value in allowed else fallback

    def positive(key, default, maximum):
        try:
            value = int(params.get(key, ""))
            return min(value, maximum) if value > 0 else default
        except ValueError:
            return default

    today = (now + timedelta(hours=8)).date()
    day = params.get("rDay", "")
    try:
        selected = datetime.strptime(day, "%Y-%m-%d").date()
        day = (
            day
            if selected.isoformat() == day and datetime(today.year - 1, 1, 1).date() <= selected <= today
            else ""
        )
    except ValueError:
        day = ""
    year = positive("rYear", today.year, today.year)
    return {
        "period": pick("rPeriod", {"today", "7d", "30d"}, "today"),
        "status": pick("rStatus", {"all", "success", "4xx", "5xx", "cancelled"}, "all"),
        "source": pick("rSource", {"all", "web", "ios", "app", "other"}, "all"),
        "method": pick(
            "rMethod", {"all", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "OTHER"}, "all"
        ),
        "q": params.get("rQ", "").strip()[:120],
        "page": positive("rPage", 1, 5000),
        "anchor": positive("rAnchor", 0, 9007199254740991),
        "day": day,
        "year": year if year >= today.year - 1 else today.year,
    }


async def snapshot(conn, params, now=None):
    now = now or datetime.now(UTC)
    f = filters(params, now)
    today = (now + timedelta(hours=8)).date()
    start = f["day"] or (today - timedelta(days={"today": 0, "7d": 6, "30d": 29}[f["period"]])).isoformat()
    end = f["day"] or today.isoformat()
    from_at = datetime.fromisoformat(start).replace(tzinfo=timezone(timedelta(hours=8)))
    until = datetime.fromisoformat(end).replace(tzinfo=timezone(timedelta(hours=8))) + timedelta(days=1)
    state = await (await conn.execute("SELECT * FROM request_rollup_state WHERE singleton")).fetchone()
    parts, args = [], []
    for column in ("source", "method"):
        if f[column] != "all":
            parts.append(column + "=%s")
            args.append(f[column])
    if f["q"]:
        parts.append("strpos(lower(path),lower(%s))>0")
        args.append(f["q"])
    clause = {
        "success": "status<400",
        "4xx": "status BETWEEN 400 AND 498",
        "5xx": "status>=500",
        "cancelled": "status=499",
    }.get(f["status"])
    if clause:
        parts.append(clause)
    suffix = " AND " + " AND ".join(parts) if parts else ""
    where = "unit='day' AND bucket>=%s AND bucket<%s" + suffix
    range_args = [from_at, until, *args]
    summary = await (
        await conn.execute(
            'SELECT coalesce(sum(count),0)::bigint AS total,coalesce(sum(count) FILTER(WHERE status>=400),0)::bigint AS errors,coalesce(sum(count) FILTER(WHERE status>=500),0)::bigint AS "serverErrors",coalesce(sum(total_ms)/nullif(sum(count),0),0)::float8 AS "averageMs" FROM request_rollups WHERE '
            + where,
            range_args,
        )
    ).fetchone()
    summary["sources"] = dict.fromkeys(("web", "ios", "app", "other"), 0)
    for row in await (
        await conn.execute(
            "SELECT source,sum(count)::bigint AS count FROM request_rollups WHERE "
            + where
            + " GROUP BY source",
            range_args,
        )
    ).fetchall():
        summary["sources"][row["source"]] = row["count"]
    endpoints = await (
        await conn.execute(
            'SELECT path,method,sum(count)::bigint AS count,sum(CASE WHEN status>=400 THEN count ELSE 0 END)::bigint AS errors,(sum(total_ms)/sum(count))::float8 AS "averageMs" FROM request_rollups WHERE '
            + where
            + " GROUP BY path,method ORDER BY count DESC,path,method LIMIT 8",
            range_args,
        )
    ).fetchall()
    anchor = min(f["anchor"], state["revision"]) if f["anchor"] else state["revision"]
    detail_where = "imported_source IS NULL AND at>=%s AND at<%s AND id<=%s" + suffix
    detail_args = [from_at, until, anchor, *args]
    total = (
        await (
            await conn.execute(
                "SELECT count(*) AS n FROM request_observations WHERE " + detail_where, detail_args
            )
        ).fetchone()
    )["n"]
    page = min(f["page"], max(1, (total + 19) // 20))
    logs = await (
        await conn.execute(
            "SELECT id,(extract(epoch FROM at)*1000)::float8 AS at,path,method,source,status,duration FROM request_observations WHERE "
            + detail_where
            + " ORDER BY id DESC LIMIT 20 OFFSET %s",
            [*detail_args, (page - 1) * 20],
        )
    ).fetchall()
    hourly = start == end and from_at >= now - timedelta(days=30)
    unit = "hour" if hourly else "day"
    chart_where = "unit=%s AND bucket>=%s AND bucket<%s" + suffix
    chart = await (
        await conn.execute(
            "SELECT to_char(bucket AT TIME ZONE 'Asia/Shanghai',%s) AS key,sum(count)::bigint AS count,sum(CASE WHEN status>=400 THEN count ELSE 0 END)::bigint AS errors FROM request_rollups WHERE "
            + chart_where
            + " GROUP BY bucket ORDER BY bucket",
            [('YYYY-MM-DD"T"HH24:00' if hourly else "YYYY-MM-DD"), unit, from_at, until, *args],
        )
    ).fetchall()
    heat = await (
        await conn.execute(
            "SELECT to_char(bucket AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,sum(count)::bigint AS count FROM request_rollups WHERE unit='day' AND bucket>=%s AND bucket<%s"
            + suffix
            + " GROUP BY bucket",
            [
                datetime(f["year"], 1, 1, tzinfo=from_at.tzinfo),
                datetime(f["year"] + 1, 1, 1, tzinfo=from_at.tzinfo),
                *args,
            ],
        )
    ).fetchall()
    return {
        "revision": state["revision"],
        "aggregateRevision": state["aggregate_revision"],
        "today": today.isoformat(),
        "summary": summary,
        "chart": chart,
        "chartUnit": unit,
        "endpoints": endpoints,
        "logs": logs,
        "pagination": {"page": page, "pageSize": 20, "total": total, "anchor": anchor},
        "heatmap": {r["day"]: r["count"] for r in heat},
        "detailFrom": (now - timedelta(days=7)).timestamp() * 1000,
        "detailFloor": state["detail_floor"],
        "detailGap": bool(f["anchor"] and f["anchor"] <= state["detail_floor"]),
        "observedOnly": True,
        "lostBuffered": state["lost"],
        "crashLossKnown": False,
        "rollupPending": state["aggregate_revision"] < state["revision"],
        "legacyImport": await legacy_import(conn),
    }


async def legacy_import(conn):
    row = await (
        await conn.execute(
            """SELECT
                 (SELECT count(*) FROM operational_request_log_rows) AS detail_rows,
                 (SELECT count(*) FROM operational_request_log_cells WHERE unit='day') AS daily_cells,
                 (SELECT count(*) FROM operational_request_log_cells WHERE unit='hour') AS hour_cells"""
        )
    ).fetchone()
    return {
        "detailRows": row["detail_rows"],
        "dailyCells": row["daily_cells"],
        "hourCells": row["hour_cells"],
        "historicalCoverageKnown": False,
        "hourDurationKnown": False,
    }


def legacy_logs_client(request):
    # An empty old cookie still selects this route. alcor_session keeps the platform response.
    if COOKIE in request.cookies:
        return False
    return WEB_COOKIE in request.cookies or OLD_COOKIE in request.cookies or "authorization" in request.headers


def legacy_fail(code, message, status):
    return JSONResponse(
        status_code=status,
        content={"code": code, "message": message},
        headers={"Cache-Control": "no-store"},
    )


def legacy_ok(data):
    return JSONResponse(
        content={"code": 0, "message": "ok", "data": data},
        headers={"Cache-Control": "no-store, private"},
    )


def legacy_snapshot(value):
    return {key: value[key] for key in LEGACY_SNAPSHOT_KEYS}


def mount_request_observability(app, settings, db):
    async def admin(request):
        assert_native_origin(request, settings)
        if "authorization" in request.headers:
            from .legacy_optional_credentials import credentials_present

            credentials_present(request)
            raise HTTPException(403, "请使用当前网页登录会话")
        who = await identity(request) if COOKIE in request.cookies else (await web_identity(request, db, allow_platform=True))[0]
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        return who

    async def legacy_admin(request):
        who = await legacy_docs_user(request)
        if who is None:
            return None, legacy_fail(40101, "未登录", 401)
        if who.role != "admin":
            return None, legacy_fail(40301, "需要管理员权限", 403)
        return who, None

    @app.get("/api/request-logs")
    async def read(request: Request, response: Response):
        if legacy_logs_client(request):
            who, denied = await legacy_admin(request)
            if denied:
                return denied
            try:
                async with db.connection() as conn, conn.transaction():
                    await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                    await lock_mutation_identity(conn, who, require_admin=True)
                    value = await snapshot(conn, request.query_params)
            except HTTPException as exc:
                if exc.status_code == 403:
                    return legacy_fail(40301, "需要管理员权限", 403)
                if exc.status_code == 401:
                    return legacy_fail(40101, "未登录", 401)
                return legacy_fail(50001, "请求日志读取失败", 500)
            except READ_FAILURES:
                return legacy_fail(50001, "请求日志读取失败", 500)
            return legacy_ok(legacy_snapshot(value))
        who = await admin(request)
        async with db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            await lock_mutation_identity(conn, who, require_admin=True)
            value = await snapshot(conn, request.query_params)
        value["localCollector"] = app.state.request_observations.status()
        response.headers["Cache-Control"] = "no-store, private"
        return {"code": 0, "message": "ok", "data": value}

    @app.get("/api/request-logs/events")
    async def events(request: Request):
        legacy = legacy_logs_client(request)
        if legacy:
            who, denied = await legacy_admin(request)
            if denied:
                return denied
        else:
            who = await admin(request)
        lease = uuid4()
        try:
            async with db.connection() as conn, conn.transaction():
                await lock_mutation_identity(conn, who, require_admin=True)
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended('request-stream-leases',0))"
                )
                count = (
                    await (
                        await conn.execute(
                            "SELECT count(*) AS n FROM request_stream_leases WHERE expires_at>clock_timestamp()"
                        )
                    ).fetchone()
                )["n"]
                if count >= 20:
                    # Platform callers assert HTTPException. The reviewed cookie gets the numeric body.
                    if legacy:
                        return legacy_fail(42901, "实时连接过多", 429)
                    raise HTTPException(429, "实时连接过多")
                await conn.execute(
                    "INSERT INTO request_stream_leases(id,expires_at) VALUES(%s,clock_timestamp()+interval '45 seconds')",
                    (lease,),
                )
        except HTTPException as exc:
            if not legacy:
                raise
            if exc.status_code == 403:
                return legacy_fail(40301, "需要管理员权限", 403)
            if exc.status_code == 429:
                return legacy_fail(42901, "实时连接过多", 429)
            return legacy_fail(40101, "未登录", 401)
        except READ_FAILURES:
            if not legacy:
                raise
            return legacy_fail(50001, "请求日志读取失败", 500)

        async def stream():
            prior = None
            try:
                while True:
                    if legacy:
                        current = await legacy_docs_user(request)
                        if (
                            current is None
                            or current.role != "admin"
                            or current.id != who.id
                            or current.token_hash != who.token_hash
                        ):
                            return
                    else:
                        current = await admin(request)
                        if current.id != who.id:
                            return
                    async with db.connection() as conn, conn.transaction():
                        await lock_mutation_identity(conn, current, require_admin=True)
                        updated = await (
                            await conn.execute(
                                "UPDATE request_stream_leases SET expires_at=clock_timestamp()+interval '45 seconds' WHERE id=%s AND expires_at>clock_timestamp() RETURNING id",
                                (lease,),
                            )
                        ).fetchone()
                        if not updated:
                            return
                        row = await (
                            await conn.execute(
                                "SELECT revision,aggregate_revision,lost FROM request_rollup_state WHERE singleton"
                            )
                        ).fetchone()
                    state = tuple(row.values())
                    if state != prior:
                        prior = state
                        yield f"event: change\ndata: {row['revision']}\n\n"
                    yield ": heartbeat\n\n"
                    await asyncio.sleep(STREAM_POLL_SECONDS)
            except HTTPException:
                return
            finally:

                async def release():
                    async with db.connection() as conn:
                        await conn.execute("DELETE FROM request_stream_leases WHERE id=%s", (lease,))

                with contextlib.suppress(Exception, asyncio.CancelledError):
                    await asyncio.shield(asyncio.wait_for(release(), 3))

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store, private", "X-Accel-Buffering": "no"},
        )
