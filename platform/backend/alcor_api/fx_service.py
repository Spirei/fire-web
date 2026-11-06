"""Persistent budget, request receipts and independent-worker facade."""

import asyncio
import hashlib
import logging
from contextlib import asynccontextmanager
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg import Error as DatabaseError
from psycopg.types.json import Jsonb
from psycopg_pool import PoolTimeout

from .db import TargetMismatch
from .fx_reference import PROVIDER, FxWorker, external_delivery_blocked


class _WorkerConnection:
    """One identity-verified pooled connection for the serialized worker attempt."""

    def __init__(self, conn, settings):
        self.conn, self.settings = conn, settings

    @asynccontextmanager
    async def connection(self):
        yield self.conn


class ManagedFx(FxWorker):
    async def configure(self, who, enabled, budget, expected, custom=None):
        from .security import lock_mutation_identity

        if (
            type(enabled) is not bool
            or type(budget) is not int
            or not 1 <= budget <= 1000
            or type(expected) is not int
            or expected < 1
        ):
            raise HTTPException(400, "供应商设置无效")
        prepared = None
        if custom is not None and custom != {"type": "builtin"}:
            import ipaddress

            from .fx_provider_credentials import separate
            from .fx_provider_parser import approved_target
            from .fx_schedule import compile_schedule

            if (
                not isinstance(custom, dict)
                or not isinstance(custom.get("url"), str)
                or len(custom["url"]) > 2048
            ):
                raise ValueError("custom_config_invalid")
            prepared, secret = separate(custom)
            approval = custom.get("approval")
            if (
                not isinstance(approval, dict)
                or not isinstance(approval.get("addresses"), list)
                or not 1 <= len(approval["addresses"]) <= 32
            ):
                raise ValueError("approval_invalid")
            for address in approval["addresses"]:
                ipaddress.ip_address(address)
            trusted = [
                target
                for target in getattr(self.db.settings, "fx_provider_targets", [])
                if target.get("target") == approval.get("target")
                and set(approval["addresses"]) <= set(target.get("addresses", []))
                and (not approval.get("allow_plaintext") or target.get("allow_plaintext") is True)
            ]
            if not trusted:
                raise HTTPException(403, "供应商目标未获实例允许")
            if custom.get("time_field") and custom.get("time_precision") not in (
                "date",
                "instant",
                "epoch_seconds",
                "epoch_millis",
            ):
                raise ValueError("source_time_policy_invalid")
            if len(custom.get("time_field") or "") > 200:
                raise ValueError("source_time_path_invalid")
            approved_target(custom["url"], approval, approval["addresses"])
            if custom.get("schedule"):
                prepared["schedule"] = await compile_schedule(
                    custom["schedule"]["pattern"], custom["schedule"]["timezone"]
                )
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
            )
            await lock_mutation_identity(conn, who, require_admin=True)
            await conn.execute("SELECT revision FROM fx_config WHERE singleton=true FOR UPDATE")
            from .admin_verification import require_admin_verification

            await require_admin_verification(conn, who, "reference")
            if enabled and await external_delivery_blocked(conn):
                raise HTTPException(503, "恢复副本禁止外部读取")
            provider_revision = None
            if prepared is not None:
                from .fx_custom import kind, vault

                provider_revision = uuid4()
                cipher = vault(self.db).encrypt(secret, kind(provider_revision), self.db.settings.instance_id)
                await conn.execute(
                    "INSERT INTO fx_provider_revisions(id,config,secret_cipher,credential_instance) VALUES(%s,%s,%s,%s)",
                    (provider_revision, Jsonb(prepared), cipher, self.db.settings.instance_id),
                )
            row = await (
                await conn.execute(
                    "UPDATE fx_config SET enabled=%s,daily_budget=%s,revision=revision+1,provider_revision=CASE WHEN %s THEN %s ELSE provider_revision END WHERE singleton=true AND revision=%s RETURNING revision",
                    (enabled, budget, custom is not None, provider_revision, expected),
                )
            ).fetchone()
            if not row:
                raise HTTPException(409, "供应商设置已变化")
            if custom is not None:
                await conn.execute(
                    "UPDATE fx_refresh_tasks SET state='failed',error_code='provider_changed',completed_at=clock_timestamp() WHERE state='queued' AND provider_revision IS DISTINCT FROM %s",
                    (provider_revision,),
                )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id) VALUES(%s,'reference.fx.configure',%s)",
                (who.id, str(provider_revision) if custom is not None else PROVIDER),
            )
            return row["revision"]

    async def submit(self, principal, request_id, owner=None, *, authorization=None):
        request_id = UUID(str(request_id))
        key = hashlib.sha256(principal.encode()).hexdigest()
        if owner is not None and (
            authorization is None or authorization.id != owner or principal != "user:" + owner
        ):
            raise HTTPException(403, "请求身份不匹配")
        async with self.db.connection() as conn, conn.transaction():
            if authorization is not None:
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                    ("identity-management:" + authorization.id,),
                )
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('fx-requests',0))")
            if authorization is not None:
                from .security import lock_mutation_identity

                await lock_mutation_identity(conn, authorization, require_admin=False)
            if await external_delivery_blocked(conn):
                raise HTTPException(503, "恢复副本禁止外部读取")
            existing = await (
                await conn.execute("SELECT * FROM fx_requests WHERE request_id=%s", (request_id,))
            ).fetchone()
            if existing:
                if existing["principal"] != key:
                    raise HTTPException(404, "请求不存在")
                return existing["task_id"]
            config = await (
                await conn.execute("SELECT * FROM fx_config WHERE singleton=true FOR UPDATE")
            ).fetchone()
            budget = await (
                await conn.execute(
                    "INSERT INTO fx_rate_windows VALUES(%s,date_trunc('minute',clock_timestamp()),1) ON CONFLICT(key_hash,minute) DO UPDATE SET count=fx_rate_windows.count+1 RETURNING count",
                    (key,),
                )
            ).fetchone()
            if budget["count"] > 10:
                raise HTTPException(429, "刷新请求过于频繁")
            active = await (
                await conn.execute(
                    "SELECT id FROM fx_refresh_tasks WHERE state IN ('queued','running') AND provider_revision IS NOT DISTINCT FROM %s ORDER BY created_at LIMIT 1",
                    (config["provider_revision"],),
                )
            ).fetchone()
            if not config["enabled"]:
                active = None
            task = active["id"] if active else uuid4()
            if not active:
                await conn.execute(
                    "INSERT INTO fx_refresh_tasks(id,owner_id,provider,state,provider_revision) VALUES(%s,%s,%s,'queued',%s)",
                    (
                        task,
                        owner,
                        "custom" if config["provider_revision"] else PROVIDER,
                        config["provider_revision"],
                    ),
                )
            if not config["enabled"]:
                await conn.execute(
                    "UPDATE fx_refresh_tasks SET state='failed',error_code='provider_disabled',completed_at=clock_timestamp() WHERE id=%s",
                    (task,),
                )
            await conn.execute("INSERT INTO fx_requests VALUES(%s,%s,%s)", (request_id, key, task))
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'reference.fx.request',%s,%s)",
                (owner, str(task), request_id),
            )
            return task

    async def receipt(self, principal, request_id):
        try:
            identifier = UUID(str(request_id))
            if str(identifier) != str(request_id):
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(400, "requestId 无效") from None
        async with self.db.connection() as conn:
            row = await (
                await conn.execute(
                    "SELECT t.id,t.state,t.error_code,t.observation_id FROM fx_requests r JOIN fx_refresh_tasks t ON t.id=r.task_id WHERE r.request_id=%s AND r.principal=%s",
                    (identifier, hashlib.sha256(principal.encode()).hexdigest()),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "请求不存在")
            result={k: str(v) if k in ("id", "observation_id") and v else v for k, v in row.items()}
            response=await(await conn.execute('SELECT raw_sha256,http_status,complete FROM fx_response_pages WHERE task_id=%s',(row['id'],))).fetchone()
            if response:
                result['responseOriginal']={'taskId':str(row['id']),'sha256':response['raw_sha256'],'httpStatus':response['http_status'],'complete':response['complete'],
                    'downloadPath':'/api/reference/rates/responses/'+str(row['id'])+'/original','access':'current_admin_password_and_factor','method':'POST'}
            return result

    async def status(self):
        async with self.db.connection() as conn,conn.transaction():
            row=await (await conn.execute("SELECT c.enabled,c.daily_budget,c.revision,c.provider_revision,(clock_timestamp() AT TIME ZONE 'UTC')::date AS day,coalesce(u.calls,0) AS used FROM fx_config c LEFT JOIN fx_daily_usage u ON u.day=(clock_timestamp() AT TIME ZONE 'UTC')::date WHERE c.singleton=true")).fetchone()
            if not row:raise HTTPException(503,"汇率配置尚未初始化")
            quarantined=await external_delivery_blocked(conn)
            return {"enabled":row['enabled'],"configuredProviderRevision":str(row['provider_revision']) if row['provider_revision'] else None,
                    "configRevision":row['revision'],"quarantined":quarantined,
                    "budget":{"dayUTC":row['day'].isoformat(),"limit":row['daily_budget'],"used":row['used'],
                              "remaining":max(0,row['daily_budget']-row['used']),"scope":"shared_instance_provider_calls",
                              "countingBasis":"reserved_attempts_including_failed_or_interrupted","providerQuotaKnown":False}}

    async def observations(self,*,limit=25,before=None):
        if type(limit) is not int or not 1<=limit<=100:raise HTTPException(400,"汇率历史分页无效")
        try:before=UUID(before) if before else None
        except (ValueError,TypeError,AttributeError):raise HTTPException(400,"汇率历史游标无效") from None
        async with self.db.connection() as conn,conn.transaction():
            anchor=await (await conn.execute('SELECT received_at,id FROM fx_observations WHERE id=%s',(before,))).fetchone() if before else None
            if before and not anchor:raise HTTPException(400,"汇率历史游标不存在")
            rows=await (await conn.execute('SELECT id,provider,provider_revision,observation_date,source_instant,source_precision,received_at,raw_sha256 FROM fx_observations WHERE (%s::uuid IS NULL OR (received_at,id)<(%s::timestamptz,%s::uuid)) ORDER BY received_at DESC,id DESC LIMIT %s',
                (before,anchor['received_at'] if anchor else None,before,limit+1))).fetchall()
            return {"items":[{"id":str(row['id']),"provider":row['provider'],"providerRevision":str(row['provider_revision']) if row['provider_revision'] else None,
                "observationDate":row['observation_date'].isoformat() if row['observation_date'] else None,
                "observationInstant":row['source_instant'].isoformat() if row['source_instant'] else None,
                "sourcePrecision":row['source_precision'],"receivedAt":row['received_at'].isoformat(),"rawSha256":row['raw_sha256']}
                for row in rows[:limit]],"nextBefore":str(rows[limit-1]['id']) if len(rows)>limit else None}

    async def original(self,who,observation_id):
        from .security import lock_mutation_identity
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who,require_admin=True)
            row=await (await conn.execute('SELECT original_bytes,raw_sha256 FROM fx_observations WHERE id=%s',(observation_id,))).fetchone()
            if not row:raise HTTPException(404,"汇率原件不存在")
            raw=bytes(row['original_bytes'])
            if hashlib.sha256(raw).hexdigest()!=row['raw_sha256']:raise HTTPException(503,"汇率原件校验失败")
            return raw,row['raw_sha256']

    async def once(self):
        # Session advisory ownership spans claim/network/commit across independent workers.
        # The connection is always unlocked before returning to the pool.
        async with self.db.connection() as guard:
            claimed = await (
                await guard.execute(
                    "SELECT pg_try_advisory_lock(hashtextextended('fx-worker-singleflight',0)) AS ok"
                )
            ).fetchone()
            if not claimed["ok"]:
                return "busy"
            try:
                bound = ManagedFx(
                    _WorkerConnection(guard, self.db.settings),
                    transport=self.transport,
                    request_timeout=self.request_timeout,
                )
                bound.custom_requester = getattr(self, "custom_requester", None)
                return await bound._once_serialized()
            finally:
                await guard.execute("SELECT pg_advisory_unlock(hashtextextended('fx-worker-singleflight',0))")

    async def claim_task(self):
        # Claim and reserve quota atomically under the current provider configuration.
        # Failed or interrupted attempts consume their reservation and are never replayed.
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('fx-worker-budget',0))")
            if await external_delivery_blocked(conn):
                return "quarantined", None
            config = await (
                await conn.execute("SELECT * FROM fx_config WHERE singleton=true FOR UPDATE")
            ).fetchone()
            if not config["enabled"]:
                return "disabled", None
            queued = await (
                await conn.execute(
                    "SELECT * FROM fx_refresh_tasks WHERE state='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1"
                )
            ).fetchone()
            if not queued:
                return "idle", None
            usage = await (
                await conn.execute(
                    "SELECT calls FROM fx_daily_usage WHERE day=(clock_timestamp() AT TIME ZONE 'UTC')::date FOR UPDATE"
                )
            ).fetchone()
            if usage and usage["calls"] >= config["daily_budget"]:
                await conn.execute(
                    "UPDATE fx_refresh_tasks SET state='failed',error_code='daily_budget',completed_at=clock_timestamp() WHERE state='queued'"
                )
                return "budget_exhausted", None
            await conn.execute(
                "INSERT INTO fx_daily_usage VALUES((clock_timestamp() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(day) DO UPDATE SET calls=fx_daily_usage.calls+1"
            )
            await conn.execute(
                "UPDATE fx_refresh_tasks SET state='running',started_at=clock_timestamp() WHERE id=%s",
                (queued["id"],),
            )
            return "running", queued

    async def _once_serialized(self):
        self.enabled = True
        result = await super().once()
        async with self.db.connection() as conn:
            await conn.execute(
                "INSERT INTO audit_events(action,target_id) VALUES('reference.fx.worker',%s)", (result,)
            )
        return result

    async def schedule_tick(self, now=None):
        from datetime import UTC, datetime
        from uuid import NAMESPACE_URL, uuid5

        from .fx_schedule import current_slot

        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('fx-requests',0))")
            config = await (
                await conn.execute(
                    "SELECT c.*,p.config FROM fx_config c LEFT JOIN fx_provider_revisions p ON p.id=c.provider_revision WHERE singleton=true FOR UPDATE OF c"
                )
            ).fetchone()
            if (
                not config["enabled"]
                or not config["provider_revision"]
                or await external_delivery_blocked(conn)
            ):
                return "disabled"
            schedule = config["config"].get("schedule")
            slot = current_slot(schedule, now or datetime.now(UTC)) if schedule else None
            if not slot:
                return "idle"
            exists = await (
                await conn.execute(
                    "SELECT 1 FROM fx_schedule_firings WHERE provider_revision=%s AND local_day=%s AND slot=%s",
                    (config["provider_revision"], *slot),
                )
            ).fetchone()
            if exists:
                return "recorded"
            request_id = uuid5(
                NAMESPACE_URL, f"fx-schedule:{config['provider_revision']}:{slot[0]}:{slot[1]}"
            )
            active = await (
                await conn.execute(
                    "SELECT id FROM fx_refresh_tasks WHERE state IN ('queued','running') AND provider_revision=%s ORDER BY created_at LIMIT 1",
                    (config["provider_revision"],),
                )
            ).fetchone()
            task = active["id"] if active else uuid4()
            if not active:
                await conn.execute(
                    "INSERT INTO fx_refresh_tasks(id,provider,state,provider_revision) VALUES(%s,'custom','queued',%s)",
                    (task, config["provider_revision"]),
                )
            await conn.execute(
                "INSERT INTO fx_requests VALUES(%s,%s,%s)",
                (request_id, hashlib.sha256(b"scheduler").hexdigest(), task),
            )
            await conn.execute(
                "INSERT INTO fx_schedule_firings VALUES(%s,%s,%s,%s)",
                (config["provider_revision"], *slot, request_id),
            )
            await conn.execute(
                "INSERT INTO audit_events(action,target_id,request_id) VALUES('reference.fx.scheduled',%s,%s)",
                (str(task), request_id),
            )
            return "queued"

    async def wait_result(self, principal, request_id, timeout=15):
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            receipt = await self.receipt(principal, request_id)
            if receipt["state"] == "completed":
                return await self.snapshot(receipt["observation_id"])
            if receipt["state"] in ("failed", "interrupted"):
                raise HTTPException(502, "汇率供应商读取失败")
            if asyncio.get_running_loop().time() >= deadline:
                raise HTTPException(504, "刷新仍在处理中，请查询原请求")
            await asyncio.sleep(0.02)


class ReferenceReadiness:
    def __init__(self):
        self.ready = asyncio.Event()
        self.pool = None

    def current(self, db):
        return self.ready.is_set() and self.pool is db.pool


async def run_reference_worker(db, stop, *, transport=None, readiness=None):
    """Only the verified current database generation may advertise reference readiness."""
    worker = ManagedFx(db, transport=transport)
    readiness = readiness or ReferenceReadiness()
    while not stop.is_set():
        try:
            if not readiness.current(db):
                readiness.ready.clear()
                candidate_pool = db.pool
                from .market_calendar import Calendars

                await Calendars(db).ensure_builtin()
                if db.pool is not candidate_pool:
                    continue
                readiness.pool = candidate_pool
                readiness.ready.set()
            await worker.recover_interrupted()
            await worker.schedule_tick()
            await worker.once()
        except (DatabaseError, TargetMismatch, ConnectionError, TimeoutError, PoolTimeout):
            readiness.ready.clear()
            logging.getLogger(__name__).warning(
                "Reference worker storage unavailable; original tasks retained"
            )
        try:
            await asyncio.wait_for(stop.wait(), timeout=1)
        except TimeoutError:
            pass
