import asyncio
from datetime import datetime, timezone

from . import __version__, __build__


async def read_overview(app, who):
    db, settings, cache, connections = (
        app.state.db,
        app.state.settings,
        app.state.cache,
        app.state.connections,
    )
    now = datetime.now(timezone.utc)
    async with db.connection() as conn:
        heartbeat = await (
            await conn.execute(
                "SELECT max(observed_at) AS observed_at, bool_or(observed_at>clock_timestamp()-interval '30 seconds') AS online FROM worker_heartbeats"
            )
        ).fetchone()
        counts = await (
            await conn.execute(
                "SELECT status,count(*) AS count,count(*) FILTER (WHERE kind='market.latest') AS recurring FROM tasks WHERE owner_id=%s GROUP BY status", (who.id,)
            )
        ).fetchall()
        configured_rows = await (
            await conn.execute("SELECT kind,revision FROM connection_settings")
        ).fetchall()
    configured = (
        {}
        if settings.connections_from_environment
        else {row["kind"]: row["revision"] for row in configured_rows}
    )
    pg_applied = bool(
        configured.get("postgresql") and connections.applied.get("postgresql") == configured["postgresql"]
    )
    pg_current = pg_applied or "postgresql" not in configured
    services = [
        {
            "id": "postgresql",
            "label": "PostgreSQL",
            "state": "up" if pg_current else "pending" if "postgresql" in configured else "unconfigured",
            "configured": bool(db.settings.database_url),
            "detail": "连接正常"
            if pg_current
            else "配置正在应用"
            if "postgresql" in configured
            else "尚未配置",
            "observed_at": now if pg_current else None,
        },
        {
            "id": "worker",
            "label": "后台 Worker",
            "state": "up" if heartbeat["online"] else "down",
            "configured": True,
            "detail": "独立进程已报告心跳" if heartbeat["online"] else "尚未收到有效心跳",
            "observed_at": heartbeat["observed_at"],
        },
    ]
    state = "pending" if "redis" in configured else "unconfigured"
    redis_applied = bool(configured.get("redis") and connections.applied.get("redis") == configured["redis"])
    redis_current = redis_applied or "redis" not in configured and bool(db.settings.redis_url)
    if redis_current and cache:
        try:
            await asyncio.wait_for(cache.ping(), 1.5)
            state = "up"
        except Exception:
            state = "down"
    elif redis_current:
        state = "down"
    services.insert(
        1,
        {
            "id": "redis",
            "label": "Redis",
            "state": state,
            "configured": "redis" in configured or bool(db.settings.redis_url),
            "detail": {
                "up": "缓存连接正常",
                "down": "连接异常，身份与任务仍由 PostgreSQL 核验",
                "unconfigured": "尚未配置缓存连接",
                "pending": "配置正在应用",
            }[state],
            "observed_at": now if state in {"up", "down"} else None,
        },
    )
    return {
        "version": __version__,
        "build": __build__,
        "environment": settings.environment,
        "topology": "single-app-external-pg-redis",
        "services": services,
        "task_counts": {r["status"]: r["count"] for r in counts},
        "recurring_task_counts": {r["status"]: r["recurring"] for r in counts},
        "compatibility": {
            "ios_v1": False,
            "ios_v2": False,
            "legacy_web": False,
            "financial_writes": False,
        },
    }
