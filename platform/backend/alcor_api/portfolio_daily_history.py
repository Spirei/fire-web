"""Prepare closed sessions using the ledger owner's installed history source."""

from dataclasses import asdict
from datetime import datetime, time, timedelta
import logging
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .fx_reference import external_delivery_blocked
from .market_contract import ZONES, Query, digest, series_fingerprint

DAY = timedelta(days=1)
LOG = logging.getLogger(__name__)


async def prepare_due(authority, settled_through):
    db = authority.db
    async with db.connection() as conn:
        if await external_delivery_blocked(conn):
            return
        candidates = await (await conn.execute("""
            SELECT DISTINCT p.owner_id,p.market,p.code,c.next_check_at
            FROM portfolio_records p JOIN broker_accounts b ON b.owner_id=p.owner_id AND b.id=p.broker_account_id
            JOIN users u ON u.id=p.owner_id AND u.active
            LEFT JOIN portfolio_daily_source_checks c ON c.owner_id=p.owner_id AND c.market=p.market AND c.code=p.code
            WHERE p.deleted_at IS NULL AND p.qty>0 AND b.deleted_at IS NULL AND b.account_kind='real'
                AND b.holding_source<>'official' AND p.market IN ('US','HK','CN')
                AND (c.next_check_at IS NULL OR c.next_check_at<=clock_timestamp())
            ORDER BY c.next_check_at NULLS FIRST,p.owner_id,p.market,p.code LIMIT 12
        """)).fetchall()
    for candidate in candidates:
        try:
            await prepare(authority, candidate, settled_through)
        except Exception as error:  # noqa: BLE001 -- continue preparing the other securities
            LOG.warning("portfolio_daily_source_prepare_unavailable type=%s", type(error).__name__)


async def prepare(authority, candidate, settled_through):
    from .portfolio_daily import REGULAR_CLOSE

    owner, market, code = (candidate[key] for key in ("owner_id", "market", "code"))
    async with authority.db.connection() as conn, conn.transaction():
        if not await (await conn.execute("SELECT 1 FROM users WHERE id=%s AND active FOR SHARE", (owner,))).fetchone():
            return
        lock = await (await conn.execute("SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) AS ok",
                                        ("market-owner:" + owner,))).fetchone()
        if not lock["ok"]:
            return
        checked = await (await conn.execute("""
            INSERT INTO portfolio_daily_source_checks(owner_id,market,code,next_check_at)
            VALUES(%s,%s,%s,clock_timestamp()+interval '2 hours')
            ON CONFLICT(owner_id,market,code) DO UPDATE SET next_check_at=excluded.next_check_at
            WHERE portfolio_daily_source_checks.next_check_at<=clock_timestamp()
            RETURNING owner_id
        """, (owner, market, code))).fetchone()
        if not checked:
            return
        day = await (await conn.execute("""
            SELECT d.day,COALESCE(d.auction_latest,d.continuous_close) AS close
            FROM market_calendar_active a JOIN market_calendar_days d ON d.revision=a.revision
            WHERE market=%s AND d.day<=%s AND d.day>%s AND status IN ('trading','half_day')
            ORDER BY d.day DESC LIMIT 1
        """, (market, settled_through, settled_through - 10 * DAY))).fetchone()
        if not day:
            return
        through = day["day"]
        zone = ZoneInfo(ZONES[market])
        regular_close = time.fromisoformat(day["close"]) if day["close"] else REGULAR_CLOSE[market]
        close_at = datetime.combine(through, regular_close, zone)
        try:
            query = Query("bars", market, code, "day", "none", start=(through - 370 * DAY).isoformat(),
                          through=through.isoformat()).validate()
        except ValueError:
            return
        sources = await (await conn.execute("""
            SELECT c.revision,recent.source_time AS last_fact,recent.observed_at
            FROM market_source_configs c LEFT JOIN LATERAL (
                SELECT f.source_time,p.observed_at FROM market_facts f
                JOIN market_source_pages p ON p.owner_id=f.owner_id AND p.id=f.page_id
                WHERE f.owner_id=c.owner_id AND f.source_revision=c.revision AND f.series_fingerprint=%s
                ORDER BY f.source_time DESC,f.sequence DESC LIMIT 1
            ) recent ON true WHERE c.owner_id=%s
        """, (series_fingerprint(query), owner))).fetchall()
        supported = []
        for source in sources:
            try:
                _, policy = await authority.config(conn, owner, source["revision"])
                authority.validate_query(policy, query)
            except HTTPException:
                continue
            supported.append(source)
        observed = [source for source in supported if source["last_fact"] is not None]
        selected = observed if observed else supported
        if len(selected) != 1:
            return
        source = selected[0]
        if source["last_fact"] is not None:
            # Preserve the original series identity and request only the tail.
            latest = source["last_fact"].astimezone(zone).date()
            if latest >= through and source["observed_at"] >= close_at:
                return
            query = Query("bars", market, code, "day", "none",
                          start=max(through - 370 * DAY, latest - DAY).isoformat(), through=through.isoformat()).validate()
        data = asdict(query)
        stream = await (await conn.execute("""
            INSERT INTO market_streams(owner_id,id,source_revision,query_fingerprint,query)
            VALUES(%s,%s,%s,%s,%s)
            ON CONFLICT(owner_id,source_revision,query_fingerprint) DO UPDATE SET query=excluded.query
            RETURNING id,current_task_id
        """, (owner, uuid4(), source["revision"], digest(data), Jsonb(data)))).fetchone()
        if stream["current_task_id"]:
            task = await (await conn.execute("SELECT status FROM tasks WHERE id=%s", (stream["current_task_id"],))).fetchone()
            if task and task["status"] in ("queued", "running", "cancel_requested"):
                return
        if not await (await conn.execute("""
            INSERT INTO market_demands(owner_id,stream_id,principal,session_version,expires_at,hot_until,origin)
            SELECT id,%s,'portfolio.daily',session_version,clock_timestamp()+interval '1 day',clock_timestamp(),'portfolio.daily'
            FROM users WHERE id=%s AND active
            ON CONFLICT(owner_id,stream_id,principal) DO UPDATE SET revision=market_demands.revision+1,
                session_version=excluded.session_version,expires_at=excluded.expires_at,revoked_at=NULL
            RETURNING stream_id
        """, (stream["id"], owner))).fetchone():
            return
        await conn.execute("UPDATE market_streams SET demand_generation=demand_generation+1 WHERE owner_id=%s AND id=%s",
                           (owner, stream["id"]))


async def demand_alive(conn, stream):
    query = stream["query"]
    if (query.get("kind"), query.get("frame"), query.get("adjust"), query.get("session"), query.get("instrument")) != (
            "bars", "day", "none", "REGULAR", "equity"):
        return False
    return bool(await (await conn.execute("""
        SELECT 1 FROM portfolio_records p JOIN broker_accounts b ON b.owner_id=p.owner_id AND b.id=p.broker_account_id
        WHERE p.owner_id=%s AND p.market=%s AND p.code=%s AND p.deleted_at IS NULL AND p.qty>0
        AND b.deleted_at IS NULL AND b.account_kind='real' AND b.holding_source<>'official' LIMIT 1
    """, (stream["owner_id"], query["market"], query["code"]))).fetchone())
