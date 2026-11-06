import asyncio
import contextlib
import logging
import signal
from uuid import uuid4

from psycopg import Error as DatabaseError
from psycopg.types.json import Jsonb
from psycopg_pool import PoolTimeout

from . import __version__
from .config import Settings
from .connections import CacheHandle, Connections, bootstrap_settings
from .db import Database, TargetMismatch

log = logging.getLogger("alcor.worker")


async def claim(db: Database, worker_id):
    async with db.connection() as conn, conn.transaction():
        # Expired cancellations finish without executing work. Expired attempts have a finite budget.
        expired = await (
            await conn.execute("""
            UPDATE tasks SET status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE 'failed' END,
                error_code=CASE WHEN status='cancel_requested' THEN NULL ELSE 'retry_budget_exhausted' END,
                finished_at=clock_timestamp(), lease_until=NULL
            WHERE lease_until<clock_timestamp() AND (status='cancel_requested' OR (status='running' AND attempts>=3))
            RETURNING id,status
        """)
        ).fetchall()
        for row in expired:
            await conn.execute(
                "INSERT INTO task_events (task_id,phase) VALUES (%s,%s)", (row["id"], row["status"])
            )
        row = await (
            await conn.execute(
                """
            WITH candidate AS (
                SELECT id FROM tasks WHERE kind IN ('system.diagnostics','backup.create','backup.verify','backup.restore','backup.retention','dividends.source.import','dividends.entitlements.review','feed.source_test','feed.refresh','feed.discussion','celeb.sec_collect','asset.source','agent.runtime') AND attempts<3
                  AND (status='queued' OR (status='running' AND lease_until<clock_timestamp()))
                ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
            ) UPDATE tasks t SET status='running',attempts=attempts+1,lease_version=lease_version+1,
                lease_owner=%s,lease_until=clock_timestamp()+make_interval(secs=>%s),started_at=COALESCE(started_at,clock_timestamp())
                FROM candidate c WHERE t.id=c.id RETURNING t.*
        """,
                (worker_id, db.settings.lease_seconds),
            )
        ).fetchone()
        if row:
            await conn.execute("INSERT INTO task_events (task_id,phase) VALUES (%s,'running')", (row["id"],))
        return row


async def owned_row(conn, task):
    return await (
        await conn.execute(
            """
        SELECT * FROM tasks WHERE id=%s AND lease_owner=%s AND lease_version=%s
          AND lease_until>clock_timestamp() AND status IN ('running','cancel_requested') FOR UPDATE
    """,
            (task["id"], task["lease_owner"], task["lease_version"]),
        )
    ).fetchone()


async def checkpoint(db, task, phase):
    async with db.connection() as conn, conn.transaction():
        row = await owned_row(conn, task)
        if not row:
            return False
        if row["status"] == "cancel_requested":
            await conn.execute(
                "UPDATE tasks SET status='cancelled',finished_at=clock_timestamp(),lease_until=NULL WHERE id=%s",
                (task["id"],),
            )
            await conn.execute(
                "INSERT INTO task_events (task_id,phase) VALUES (%s,'cancelled')", (task["id"],)
            )
            return False
        await conn.execute(
            "UPDATE tasks SET lease_until=clock_timestamp()+make_interval(secs=>%s) WHERE id=%s",
            (db.settings.lease_seconds, task["id"]),
        )
        await conn.execute("INSERT INTO task_events (task_id,phase) VALUES (%s,%s)", (task["id"], phase))
        return True


async def finish(db, task, result=None, error_code=None):
    async with db.connection() as conn, conn.transaction():
        row = await owned_row(conn, task)
        if not row:
            return False
        status = (
            "cancelled" if row["status"] == "cancel_requested" else "failed" if error_code else "succeeded"
        )
        await conn.execute(
            "UPDATE tasks SET status=%s,result=%s,error_code=%s,finished_at=clock_timestamp(),lease_until=NULL WHERE id=%s",
            (status, Jsonb(result) if result else None, error_code, task["id"]),
        )
        await conn.execute("INSERT INTO task_events (task_id,phase) VALUES (%s,%s)", (task["id"], status))
        return True


async def heartbeat(db, worker_id):
    async with db.connection() as conn:
        await conn.execute(
            """INSERT INTO worker_heartbeats (worker_id,version) VALUES (%s,%s)
            ON CONFLICT (worker_id) DO UPDATE SET observed_at=clock_timestamp(),version=excluded.version""",
            (worker_id, __version__),
        )


async def diagnose(db, cache, task):
    if not await checkpoint(db, task, "checking_database"):
        return
    async with db.connection() as conn:
        await conn.execute("SELECT 1")
    components = [{"id": "postgresql", "state": "up"}]
    if not await checkpoint(db, task, "checking_cache"):
        return
    if cache:
        try:
            await asyncio.wait_for(cache.ping(), 1.5)
            components.append({"id": "redis", "state": "up"})
        except Exception:
            components.append({"id": "redis", "state": "down"})
    else:
        components.append({"id": "redis", "state": "unconfigured"})
    if not await checkpoint(db, task, "recording_receipt"):
        return
    # Successful execution can report a degraded dependency; the result never invents a healthy cache.
    await finish(db, task, {"scope": "runtime", "components": components, "healthy": all(x["state"] == "up" for x in components)})


async def run(settings=None, stop=None):
    settings = settings or Settings()
    stop = stop or asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in [signal.SIGTERM, signal.SIGINT]:
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(signum, stop.set)
    runtime, bootstrap_revision = bootstrap_settings(settings)
    db = Database(runtime)
    await db.open()
    cache = CacheHandle(settings)
    connections = Connections(settings, db, cache, role='worker')
    await connections.verify_bootstrap(bootstrap_revision)
    worker_id = uuid4()
    from .identity_mail import IdentityMail
    identity_mail = IdentityMail(runtime, db, dynamic=True)
    from .feed_worker import FeedWorker
    feed_worker = FeedWorker(db)
    from .celeb_source_worker import CelebSourceWorker
    celeb_worker = CelebSourceWorker(db)
    from .asset_source_worker import AssetSourceWorker
    asset_source_worker = AssetSourceWorker(db)
    from .agent_runtime_worker import AgentRuntimeWorker
    agent_runtime_worker = AgentRuntimeWorker(db)
    from .backup_schedule import BackupSchedule
    backup_schedule = BackupSchedule(db)
    from .fx_service import ReferenceReadiness, run_reference_worker
    reference_state=ReferenceReadiness()
    reference_task=asyncio.create_task(run_reference_worker(db,stop,readiness=reference_state))
    ready_task=asyncio.create_task(reference_state.ready.wait())
    pulse_task=None
    alerts_task=None
    market_task=None
    async def pulse():
        while True:
            if not reference_task.done() and reference_state.current(db):
                try:await heartbeat(db,worker_id)
                except (DatabaseError,TargetMismatch,ConnectionError,TimeoutError,PoolTimeout):
                    log.warning('worker_heartbeat_unavailable')
            await asyncio.sleep(3)
    try:
        await asyncio.wait({ready_task,reference_task},return_when=asyncio.FIRST_COMPLETED)
        if stop.is_set():return
        if reference_task.done():
            await reference_task
            raise RuntimeError('Reference worker stopped before initialization')
        pulse_task=asyncio.create_task(pulse())
        from .market_runtime import loop as market_latest_loop
        market_task=asyncio.create_task(market_latest_loop(db,stop,lambda:reference_state.current(db)))
        from .price_alert_runtime import from_settings as price_alerts_from_settings
        from .price_alert_worker import loop as price_alerts_loop
        alerts_task=asyncio.create_task(price_alerts_loop(price_alerts_from_settings(db),worker_id,stop,lambda:reference_state.current(db)))
        while not stop.is_set():
            if reference_task.done():
                await reference_task
                raise RuntimeError('Reference worker stopped unexpectedly')
            try:
                await connections.refresh()
                if not reference_state.current(db):
                    await asyncio.sleep(db.settings.worker_poll_seconds)
                    continue
                await heartbeat(db, worker_id)
                from .request_observability import rollup as rollup_requests
                await rollup_requests(db)
                await identity_mail.deliver_one(worker_id)
                await feed_worker.schedule()
                await celeb_worker.schedule()
                await backup_schedule.schedule_tick()
                from .dividend_source_worker import cycle as collect_dividend_sources, from_settings as dividend_sources_from_settings
                await collect_dividend_sources(dividend_sources_from_settings(db), worker_id, stop)
                task = await claim(db, worker_id)
                if task:
                    try:
                        if task['kind']=='system.diagnostics':
                            await diagnose(db, cache, task)
                        elif task['kind'].startswith('dividends.'):
                            from .dividend_chain_tasks import execute as execute_dividend_task
                            await execute_dividend_task(db,task)
                        elif task['kind'].startswith('feed.'):
                            await feed_worker.execute(task)
                        elif task['kind']=='celeb.sec_collect':
                            await celeb_worker.execute(task)
                        elif task['kind']=='asset.source':
                            await asset_source_worker.execute(task)
                        elif task['kind']=='agent.runtime':
                            await agent_runtime_worker.execute(task)
                        elif task['kind']=='backup.retention':
                            await backup_schedule.execute_retention(task)
                        else:
                            from .backups import BackupFailure, run_job
                            try:
                                result=await run_job(settings,db,task)
                                await finish(db,task,result)
                            except BackupFailure as exc:
                                await finish(db,task,{'scope':'backup','message':str(exc)},error_code='backup_failed')
                    except Exception:
                        if task['kind']=='backup.retention':
                            await finish(db,task,{'state':'unknown','willRetryAutomatically':False},error_code='backup_retention_unknown')
                            log.warning('backup_retention_unknown')
                        elif task['kind'].startswith('backup.'):
                            await finish(db,task,{'scope':'backup','message':'备份操作失败，请核对存储、工具和目标'},error_code='backup_failed')
                            log.warning('backup_failed')
                        elif task['kind'].startswith('dividends.'):
                            await finish(db,task,error_code='dividend_task_failed')
                            log.warning('dividend_task_failed')
                        elif task['kind']=='asset.source':
                            await finish(db,task,{'state':'unknown','willRetryAutomatically':False},error_code='asset_source_task_unknown')
                            log.warning('asset_source_task_unknown')
                        elif task['kind']=='celeb.sec_collect':
                            await finish(db,task,{'state':'unknown','willRetryAutomatically':False},error_code='celeb_task_unknown')
                            log.warning('celeb_task_unknown')
                        elif task['kind'].startswith('feed.'):
                            await finish(db,task,{'state':'unknown','willRetryAutomatically':False},error_code='feed_task_unknown')
                            log.warning('feed_task_unknown')
                        else:
                            await finish(db, task, error_code="diagnostic_failed")
                            log.warning("diagnostic_failed")
            except Exception:
                log.warning("worker_dependency_unavailable")
            try:
                await asyncio.wait_for(stop.wait(), db.settings.worker_poll_seconds)
            except TimeoutError:
                pass
    finally:
        if market_task is not None:
            market_task.cancel()
            await asyncio.gather(market_task,return_exceptions=True)
        if alerts_task is not None:
            alerts_task.cancel()
            await asyncio.gather(alerts_task,return_exceptions=True)
        reference_task.cancel()
        await asyncio.gather(reference_task,return_exceptions=True)
        ready_task.cancel()
        await asyncio.gather(ready_task,return_exceptions=True)
        if pulse_task:
            pulse_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):await pulse_task
        if cache:
            await cache.aclose()
        await db.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    asyncio.run(run())
