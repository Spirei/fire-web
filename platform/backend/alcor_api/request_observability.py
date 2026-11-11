"""Bounded metadata-only observation; PG authority, independent Worker rollups."""

import asyncio
import logging
import math
import time
from collections import deque
from datetime import UTC, datetime
from uuid import uuid4

from psycopg import Error as DatabaseError
from psycopg_pool import PoolTimeout, TooManyRequests

from .db import TargetMismatch

METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
SOURCES = {"web", "ios", "app", "other"}


def source_for(headers):
    agent = headers.get(b"user-agent", b"")[:512].decode("latin1")
    if "Mozilla/" in agent:
        return "web"
    if any(word in agent.lower() for word in ("cfnetwork", "darwin", "iphone", "ipad")):
        return "ios"
    if b"sec-fetch-mode" in headers:
        return "web"
    return "app" if headers.get(b"authorization", b"")[:7].lower() == b"bearer " else "other"


class Observations:
    def __init__(self, db):
        self.db = db
        self.queue = deque(maxlen=2048)
        self.lost = 0
        self.flushed_lost = 0
        self.producer_id = uuid4()
        self.last_error = 0
        self.running = False
        self.inflight = 0
        self.storage_available = None
        self.lock = asyncio.Lock()

    def record(self, route, method, source, status, duration):
        # Callers supply only a framework-owned template, never raw URLs or IDs.
        if (
            not route
            or not route.startswith("/api/")
            or route.startswith(("/api/request-logs", "/api/system/request-logs"))
        ):
            return
        if len(self.queue) == self.queue.maxlen:
            self.lost += 1
        self.queue.append(
            (
                uuid4(),
                datetime.now(UTC),
                route[:240],
                method if method in METHODS else "OTHER",
                source if source in SOURCES else "other",
                max(100, min(599, status)),
                max(0, min(86400000, duration)) if math.isfinite(duration) else 0,
            )
        )

    async def flush(self):
        async with self.lock:
            batch = [self.queue.popleft() for _ in range(min(512, len(self.queue)))]
            lost = self.lost
            if not batch and lost == self.flushed_lost:
                return
            self.inflight = len(batch)
            try:
                async with self.db.connection() as conn, conn.transaction():
                    await conn.execute(
                        "SELECT singleton FROM request_rollup_state WHERE singleton FOR UPDATE"
                    )
                    for item in batch:
                        await conn.execute(
                            "INSERT INTO request_observations(observation_key,at,path,method,source,status,duration) VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(observation_key) DO NOTHING",
                            item,
                        )
                    prior = await (
                        await conn.execute(
                            "SELECT lost FROM request_observation_producers WHERE id=%s", (self.producer_id,)
                        )
                    ).fetchone()
                    delta = max(0, lost - (prior["lost"] if prior else 0))
                    await conn.execute(
                        "INSERT INTO request_observation_producers(id,lost) VALUES(%s,%s) ON CONFLICT(id) DO UPDATE SET lost=greatest(request_observation_producers.lost,excluded.lost)",
                        (self.producer_id, lost),
                    )
                    await conn.execute(
                        "UPDATE request_rollup_state SET revision=(SELECT coalesce(max(id),revision) FROM request_observations),lost=lost+%s WHERE singleton",
                        (delta,),
                    )
            except BaseException:
                self.storage_available = False
                self.inflight = 0
                combined = batch + list(self.queue)
                self.lost += max(0, len(combined) - 2048)
                self.queue = deque(combined[-2048:], maxlen=2048)
                raise
            self.flushed_lost = lost
            self.inflight = 0
            self.storage_available = True

    def status(self):
        return {
            "running": self.running,
            "buffered": len(self.queue) + self.inflight,
            "storageAvailable": self.storage_available,
            "scope": "this_process",
        }

    async def loop(self):
        self.running = True
        try:
            while True:
                await asyncio.sleep(1)
                try:
                    await self.flush()
                except (DatabaseError, PoolTimeout, TooManyRequests, TargetMismatch, OSError, TimeoutError):
                    if time.monotonic() - self.last_error > 60:
                        self.last_error = time.monotonic()
                        logging.getLogger("alcor.observability").warning(
                            "request_observation_storage_unavailable"
                        )
        finally:
            self.running = False


class ObserveRequests:
    def __init__(self, app, observations, routes):
        self.app, self.observations = app, observations
        self.templates = [
            (route.path_regex, route.path)
            for route in routes
            if getattr(route, "path", "").startswith("/api/") and route.path != "/api/{path:path}"
        ]

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        start, status = time.monotonic(), 503

        async def outgoing(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, outgoing)
        except asyncio.CancelledError:
            status = 499
            raise
        finally:
            path = scope.get("path", "")
            if path.startswith("/api/"):
                route = getattr(scope.get("route"), "path", None) or next(
                    (template for pattern, template in self.templates if pattern.fullmatch(path)),
                    "/api/[unmatched]",
                )
                if route in {"/api/{path:path}", "/{path:path}"}:
                    route = "/api/[unmatched]"
                # Unregistered API paths must never be copied into observation storage.
                self.observations.record(
                    route,
                    scope.get("method", "OTHER"),
                    source_for(dict(scope.get("headers", []))),
                    status,
                    (time.monotonic() - start) * 1000,
                )


async def rollup(db):
    """One finite Worker batch, serialized across processes and atomic with watermark."""
    async with db.connection() as conn, conn.transaction():
        state = await (
            await conn.execute("SELECT * FROM request_rollup_state WHERE singleton FOR UPDATE")
        ).fetchone()
        ids = await (
            await conn.execute(
                "SELECT id FROM request_observations WHERE id>%s AND id<=%s ORDER BY id LIMIT 2000",
                (state["aggregate_revision"], state["revision"]),
            )
        ).fetchall()
        high = ids[-1]["id"] if ids else state["aggregate_revision"]
        if ids:
            for unit in ("hour", "day"):
                await conn.execute(
                    """INSERT INTO request_rollups(unit,bucket,path,method,source,status,count,total_ms)
                  SELECT %s,date_trunc(%s,at AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai',path,method,source,status,count(*),sum(duration)
                  FROM request_observations WHERE imported_source IS NULL AND id>%s AND id<=%s GROUP BY 2,path,method,source,status
                  ON CONFLICT(unit,bucket,path,method,source,status) DO UPDATE SET count=request_rollups.count+excluded.count,total_ms=request_rollups.total_ms+excluded.total_ms""",
                    (unit, unit, state["aggregate_revision"], high),
                )
            await conn.execute(
                "UPDATE request_rollup_state SET aggregate_revision=%s WHERE singleton", (high,)
            )
        await conn.execute(
            "DELETE FROM request_observations WHERE id IN (SELECT id FROM request_observations WHERE imported_source IS NULL AND id<=%s AND (at<clock_timestamp()-interval '7 days' OR id<=coalesce((SELECT id FROM request_observations WHERE imported_source IS NULL ORDER BY id DESC OFFSET 100000 LIMIT 1),0)) ORDER BY id LIMIT 2000)",
            (high,),
        )
        await conn.execute(
            "UPDATE request_rollup_state SET detail_floor=greatest(detail_floor,coalesce((SELECT min(id)-1 FROM request_observations WHERE imported_source IS NULL),revision)) WHERE singleton"
        )
        await conn.execute(
            "DELETE FROM request_rollups WHERE (unit,bucket,path,method,source,status) IN (SELECT unit,bucket,path,method,source,status FROM request_rollups WHERE bucket<clock_timestamp()-CASE unit WHEN 'hour' THEN interval '31 days' ELSE interval '400 days' END LIMIT 2000)"
        )
        await conn.execute("DELETE FROM request_stream_leases WHERE expires_at<clock_timestamp()")
