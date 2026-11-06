"""Lightweight authenticated request counts, batched into PG outside the HTTP path."""

import asyncio
import logging
from collections import Counter
from contextvars import ContextVar
from datetime import UTC, date, datetime, timedelta
from typing import Annotated
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import Depends
from psycopg import Error as DatabaseError
from psycopg_pool import PoolTimeout
from pydantic import BaseModel

from .db import TargetMismatch
from .security import Identity, identity

ZONE = ZoneInfo("Asia/Shanghai")
_account = ContextVar("request_activity_account", default=None)


def bind_account(user_id):
    """Only call after server-side authentication; never accept an ID from headers."""
    holder = _account.get()
    if holder is not None:
        holder["user_id"] = user_id


class RequestActivity:
    def __init__(self, db):
        self.db = db
        self.pending = Counter()
        self.dropped = 0
        self.batch = None
        self.producer = uuid4()
        self.watermark = datetime.now(UTC)
        self.lock = asyncio.Lock()

    def record(self, owner, at=None):
        key = (owner, (at or datetime.now(UTC)).astimezone(ZONE).date())
        if key not in self.pending and len(self.pending) >= 4096:
            self.dropped += 1
            return
        self.pending[key] += 1

    async def flush(self):
        async with self.lock:
            if self.batch is None:
                if not self.pending and not self.dropped:
                    return
                self.watermark = max(datetime.now(UTC), self.watermark + timedelta(microseconds=1))
                self.batch = (self.watermark, self.pending, self.dropped)
                self.pending, self.dropped = Counter(), 0
            watermark, counts, dropped = self.batch
            async with self.db.connection() as conn, conn.transaction():
                fresh = await (
                    await conn.execute(
                        # One durable watermark per process, rather than a new row every second.
                        """INSERT INTO account_request_activity_batches(id,recorded_at) VALUES(%s,%s)
                        ON CONFLICT(id) DO UPDATE SET recorded_at=excluded.recorded_at
                        WHERE account_request_activity_batches.recorded_at<excluded.recorded_at RETURNING id""",
                        (self.producer, watermark),
                    )
                ).fetchone()
                if fresh:
                    for (owner, day), count in counts.items():
                        # Deleting an account must not be undone by a queued metric.
                        await conn.execute(
                            """INSERT INTO account_request_activity(user_id,day,requests)
                            SELECT id,%s,%s FROM users WHERE id=%s
                            ON CONFLICT(user_id,day) DO UPDATE
                            SET requests=account_request_activity.requests+excluded.requests""",
                            (day, count, owner),
                        )
                    if dropped:
                        await conn.execute(
                            "UPDATE account_request_activity_state SET dropped=dropped+%s WHERE singleton",
                            (dropped,),
                        )
            self.batch = None

    async def loop(self):
        failed = False
        while True:
            await asyncio.sleep(1)
            try:
                await self.flush()
                failed = False
            except (DatabaseError, PoolTimeout, TargetMismatch, OSError, TimeoutError):
                if not failed:
                    logging.getLogger("alcor.activity").warning("request_activity_storage_unavailable")
                failed = True


class CountAccountRequests:
    def __init__(self, app, activity):
        self.app, self.activity = app, activity

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope.get("path", "").startswith("/api/"):
            return await self.app(scope, receive, send)
        holder = {}
        token = _account.set(holder)
        at = datetime.now(UTC)
        try:
            await self.app(scope, receive, send)
        finally:
            _account.reset(token)
            if holder.get("user_id"):
                self.activity.record(holder["user_id"], at)


def calendar_window(end):
    month = end.year * 12 + end.month - 1 - 11
    return date(month // 12, month % 12 + 1, 1)


async def snapshot(db, owner, now=None):
    now = now or datetime.now(UTC)
    end = now.astimezone(ZONE).date()
    start = calendar_window(end)
    async with db.connection() as conn, conn.transaction():
        state = await (
            await conn.execute(
                "SELECT observed_since,dropped FROM account_request_activity_state WHERE singleton"
            )
        ).fetchone()
        user = await (await conn.execute("SELECT created_at FROM users WHERE id=%s", (owner,))).fetchone()
        observed = max(state["observed_since"], user["created_at"]).astimezone(ZONE).date()
        rows = await (
            await conn.execute(
                "SELECT day,requests FROM account_request_activity WHERE user_id=%s AND day BETWEEN %s AND %s ORDER BY day",
                (owner, start, end),
            )
        ).fetchall()
    known = {row["day"]: row["requests"] for row in rows}
    day, days = max(start, observed), []
    while day <= end:
        days.append({"date": day, "requests": known.get(day, 0)})
        day += timedelta(days=1)
    return {
        "timezone": "Asia/Shanghai",
        "start": start,
        "end": end,
        "observed_since": observed,
        "observed_at": now,
        "observed_only": True,
        "incomplete": state["dropped"] > 0,
        "days": days,
    }


class RequestActivityDay(BaseModel):
    date: date
    requests: int


class RequestActivityOut(BaseModel):
    timezone: str
    start: date
    end: date
    observed_since: date
    observed_at: datetime
    observed_only: bool
    incomplete: bool
    days: list[RequestActivityDay]


def mount_request_activity(app, db):
    @app.get("/api/profile/requests", response_model=RequestActivityOut, tags=["profile"])
    async def own_requests(who: Annotated[Identity, Depends(identity)]):
        return await snapshot(db, who.id)
