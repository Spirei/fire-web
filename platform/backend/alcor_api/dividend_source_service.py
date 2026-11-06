"""Trusted-source collection using existing PG tasks and announcement authority."""

from typing import Annotated, Literal
from uuid import UUID, uuid4, uuid5

from fastapi import Depends, HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict

from alcor_api import tasks

from .dividend_chain import DividendChain, announcement_view
from .dividend_source_transport import Transport, safe_error
from .dividend_sources import Target, canonical, digest, parse, security
from .fx_reference import external_delivery_blocked
from .models import TaskDetail, TaskOut
from .security import Identity, administrator, identity, lock_mutation_identity
from .worker import checkpoint, finish, owned_row

KIND = "dividends.source.collect"


class CollectInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    kind: Literal["dividends.source.collect"] = KIND
    data: dict


async def authorized(conn, task):
    row = await (
        await conn.execute(
            """SELECT u.id,u.username,u.role,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id
        WHERE u.id=%s AND s.token_hash=%s AND s.client_id='new-web' AND u.active AND u.role='admin'
        AND s.expires_at>clock_timestamp() AND s.session_version=u.session_version FOR SHARE OF u,s""",
            (task["owner_id"], task["payload"].get("_session_hash", "")),
        )
    ).fetchone()
    return Identity(**row, token_hash=task["payload"]["_session_hash"], csrf="") if row else None


class Sources:
    def __init__(self, db, targets=(), transport=None, target_provider=None):
        self.db = db
        self.targets = {target.id: target for target in targets}
        if len(self.targets) != len(targets) or any(not isinstance(target, Target) for target in targets):
            raise ValueError("duplicate_or_invalid_target")
        self.transport = transport or Transport()
        self.target_provider = target_provider

    def target(self, target_id, fingerprint=None):
        current = self.targets
        if self.target_provider is not None:
            try:
                values = self.target_provider()
                current = {target.id: target for target in values}
                if len(current) != len(values):
                    raise ValueError()
            except (TypeError, ValueError) as exc:
                raise ValueError("target_approval_revoked") from exc
        target = current.get(target_id)
        if target is None or fingerprint is not None and target.fingerprint != fingerprint:
            raise ValueError("target_approval_revoked")
        return target.validate(self.db.settings.environment)

    async def configure(self, who, raw):
        try:
            if not isinstance(raw, dict) or raw.keys() != {
                "requestId",
                "targetId",
                "market",
                "code",
                "periodFrom",
                "periodThrough",
            }:
                raise ValueError()
            UUID(raw["requestId"])
            target = self.target(raw["targetId"])
            security(target.source, raw["market"], raw["code"])
            if target.source == "yahoo":
                start, end = raw["periodFrom"], raw["periodThrough"]
                if (
                    type(start) is not int
                    or type(end) is not int
                    or not 0 <= start < end <= 253402300799
                    or end - start > 366 * 86400
                ):
                    raise ValueError("bounded_one_year_window_required")
            elif raw["periodFrom"] is not None or raw["periodThrough"] is not None:
                raise ValueError()
        except (ValueError, TypeError, KeyError) as exc:
            raise HTTPException(422, "来源未获实例授权，或证券/明确时间范围无效") from exc
        stamp = digest(canonical(raw).encode())
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            prior = await (
                await conn.execute(
                    "SELECT * FROM dividend_source_configs WHERE owner_id=%s AND request_id=%s",
                    (who.id, raw["requestId"]),
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != stamp:
                    raise HTTPException(409, "请求编号已用于不同来源配置")
                return {"revision": str(prior["revision"])}
            revision = uuid4()
            await conn.execute(
                """INSERT INTO dividend_source_configs
                (owner_id,revision,request_id,fingerprint,target_id,target_fingerprint,source,source_assurance,market,code,config)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    who.id,
                    revision,
                    raw["requestId"],
                    stamp,
                    target.id,
                    target.fingerprint,
                    target.source,
                    "controlled_fixture" if target.fixture else "transport_observed",
                    raw["market"],
                    raw["code"],
                    Jsonb(raw),
                ),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'dividend.source.configured',%s,%s)",
                (who.id, str(revision), raw["requestId"]),
            )
            return {"revision": str(revision)}

    async def submit(self, who, data):
        if data.data.keys() != {"configRevision"}:
            raise HTTPException(422, "须指定来源配置版本")
        try:
            revision = UUID(data.data["configRevision"])
        except (TypeError, ValueError, KeyError) as exc:
            raise HTTPException(422, "来源配置版本无效") from exc
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            row = await (
                await conn.execute(
                    "SELECT * FROM dividend_source_configs WHERE owner_id=%s AND revision=%s",
                    (who.id, revision),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "本人来源配置不存在")
            try:
                self.target(row["target_id"], row["target_fingerprint"])
            except ValueError as exc:
                raise HTTPException(409, "实例已撤回来源授权，请重新核对配置") from exc
            row = await tasks.submit(Bound(conn, self.db.settings), who, data)
            await conn.execute(
                "INSERT INTO dividend_source_scans(owner_id,task_id,config_revision) VALUES(%s,%s,%s) ON CONFLICT(task_id) DO NOTHING",
                (who.id, row["id"], revision),
            )
            return row

    async def read(self, who, config_revision):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            await DividendChain(self.db)._authorize_read(conn, who)
            config = await (
                await conn.execute(
                    "SELECT * FROM dividend_source_configs WHERE owner_id=%s AND revision=%s",
                    (who.id, config_revision),
                )
            ).fetchone()
            if not config:
                raise HTTPException(404, "本人来源配置不存在")
            last = await (
                await conn.execute(
                    """SELECT s.*,t.status,t.error_code,t.created_at FROM dividend_source_scans s
                JOIN tasks t ON t.id=s.task_id WHERE s.owner_id=%s AND s.config_revision=%s ORDER BY t.created_at DESC,t.id DESC LIMIT 1""",
                    (who.id, config_revision),
                )
            ).fetchone()
            complete = await (
                await conn.execute(
                    """SELECT s.* FROM dividend_source_scans s JOIN tasks t ON t.id=s.task_id
                WHERE s.owner_id=%s AND s.config_revision=%s AND s.state='complete' AND t.status='succeeded'
                ORDER BY s.completed_at DESC,t.id DESC LIMIT 1""",
                    (who.id, config_revision),
                )
            ).fetchone()
            now = (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
            policy_ok = True
            try:
                target = self.target(config["target_id"], config["target_fingerprint"])
            except ValueError:
                target, policy_ok = None, False
            stale = bool(
                complete
                and (
                    not policy_ok
                    or (now - complete["completed_at"]).total_seconds() > target.stale_seconds
                    or last["task_id"] != complete["task_id"]
                    and last["status"] != "succeeded"
                )
            )
            rows = []
            if complete:
                rows = await (
                    await conn.execute(
                        """SELECT a.*,o.json_pointer,p.source_timezone,p.representation,p.pagination_semantics
                    FROM dividend_source_observations o JOIN dividend_announcement_revisions a
                    ON a.owner_id=o.owner_id AND a.revision=o.announcement_revision
                    JOIN dividend_source_pages p ON p.owner_id=o.owner_id AND p.task_id=o.task_id AND p.cursor=o.cursor
                    WHERE o.owner_id=%s AND o.task_id=%s ORDER BY o.cursor,o.json_pointer LIMIT 10001""",
                        (who.id, complete["task_id"]),
                    )
                ).fetchall()
            return {
                "configRevision": str(config_revision),
                "state": "stale" if stale else "available" if complete else "unknown",
                "lastTaskId": str(last["task_id"]) if last else None,
                "lastStatus": last["status"] if last else None,
                "lastError": (last["latest_error"] or last["error_code"]) if last else None,
                "pendingPages": last["next_cursor"] - 1 if last and last["state"] != "complete" else 0,
                "lastSuccess": complete["completed_at"].isoformat() if complete else None,
                "completeHistory": False,
                "sourceAccessCurrent": policy_ok,
                "collectionBlockedReason": "restore_quarantined"
                if await external_delivery_blocked(conn)
                else None,
                "items": [
                    {
                        **announcement_view(row),
                        "sourceAssurance": config["source_assurance"],
                        "sourceTimezone": row["source_timezone"],
                        "representation": row["representation"],
                        "jsonPointer": row["json_pointer"],
                        "eventIdentity": "content_observation_not_official_event_id",
                        "closedEntitlementSource": False,
                    }
                    for row in rows
                ],
                "cashWritten": False,
            }


async def claim(db, worker_id):
    # Same lease/UUID authority; candidate claims only its own kind.
    async with db.connection() as conn, conn.transaction():
        expired = await (
            await conn.execute(
                """UPDATE tasks SET status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE 'failed' END,
            error_code=CASE WHEN status='cancel_requested' THEN NULL ELSE 'retry_budget_exhausted' END,
            finished_at=clock_timestamp(),lease_until=NULL WHERE kind=%s AND lease_until<clock_timestamp()
            AND (status='cancel_requested' OR (status='running' AND attempts>=3)) RETURNING id,status""",
                (KIND,),
            )
        ).fetchall()
        for row in expired:
            await conn.execute(
                "INSERT INTO task_events(task_id,phase) VALUES(%s,%s)", (row["id"], row["status"])
            )
            await conn.execute(
                "UPDATE dividend_source_scans SET state=%s WHERE task_id=%s", (row["status"], row["id"])
            )
        row = await (
            await conn.execute(
                """WITH c AS (SELECT t.id FROM tasks t LEFT JOIN dividend_source_scans s ON s.task_id=t.id
            WHERE t.kind=%s AND t.attempts<3 AND COALESCE(s.not_before<=clock_timestamp(),true) AND
            (t.status='queued' OR t.status='running' AND t.lease_until<clock_timestamp()) ORDER BY t.created_at,t.id
            FOR UPDATE OF t SKIP LOCKED LIMIT 1)
            UPDATE tasks t SET status='running',attempts=attempts+1,lease_version=lease_version+1,lease_owner=%s,
            lease_until=clock_timestamp()+make_interval(secs=>%s),started_at=COALESCE(started_at,clock_timestamp())
            FROM c WHERE t.id=c.id RETURNING t.*""",
                (KIND, worker_id, db.settings.lease_seconds),
            )
        ).fetchone()
        if row:
            await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'running')", (row["id"],))
        return row


async def step(service, task):
    """One page per bounded execution; cursor survives crash, retries never book cash."""
    db = service.db
    async with db.connection() as conn, conn.transaction():
        who = await authorized(conn, task)
        current = await owned_row(conn, task)
        if not current:
            return "lost"
        if current["status"] == "cancel_requested":
            await conn.execute(
                "UPDATE dividend_source_scans SET state='cancelled' WHERE task_id=%s", (task["id"],)
            )
            await finish(Bound(conn, db.settings), task)
            return "cancelled"
        if not who:
            await finish(Bound(conn, db.settings), task, error_code="authorization_changed")
            return "failed"
        config = await (
            await conn.execute(
                """SELECT c.*,s.next_cursor,s.expected_count,s.expected_pages,s.observed_count FROM dividend_source_configs c
            JOIN dividend_source_scans s ON s.owner_id=c.owner_id AND s.config_revision=c.revision
            WHERE s.task_id=%s""",
                (task["id"],),
            )
        ).fetchone()
        if config is None:
            await finish(Bound(conn, db.settings), task, error_code="source_config_missing")
            return "failed"
        try:
            target = service.target(config["target_id"], config["target_fingerprint"])
            if await external_delivery_blocked(conn):
                raise ValueError("restore_quarantined")
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                ("dividend-source-budget:" + target.budget_key,),
            )
            count = (
                await (
                    await conn.execute(
                        "SELECT count(*) AS n FROM dividend_source_attempts WHERE budget_key=%s AND started_at>clock_timestamp()-interval '30 seconds'",
                        (target.budget_key,),
                    )
                ).fetchone()
            )["n"]
            if count >= 30:
                await conn.execute(
                    """UPDATE dividend_source_scans SET not_before=clock_timestamp()+interval '30 seconds',
                    latest_error='source_rate_budget' WHERE task_id=%s""",
                    (task["id"],),
                )
                await conn.execute(
                    "UPDATE tasks SET status='queued',attempts=attempts-1,lease_until=NULL WHERE id=%s",
                    (task["id"],),
                )
                await conn.execute(
                    "INSERT INTO task_events(task_id,phase) VALUES(%s,'source_budget_deferred')",
                    (task["id"],),
                )
                return "deferred"
            attempt_id = uuid4()
            await conn.execute(
                "INSERT INTO dividend_source_attempts(id,owner_id,task_id,target_id,budget_key,cursor,lease_version) VALUES(%s,%s,%s,%s,%s,%s,%s)",
                (
                    attempt_id,
                    who.id,
                    task["id"],
                    target.id,
                    target.budget_key,
                    config["next_cursor"],
                    task["lease_version"],
                ),
            )
        except ValueError as exc:
            error = safe_error(exc)
            await conn.execute(
                "UPDATE dividend_source_scans SET latest_error=%s,state='failed' WHERE task_id=%s",
                (error, task["id"]),
            )
            await finish(Bound(conn, db.settings), task, error_code=error)
            return "failed"
    # No task/identity row is locked during external I/O, so cancellation is responsive.
    try:
        raw, representation = await service.transport.read(target, config["config"], config["next_cursor"])
        page = parse(target.source, raw, config["config"], config["next_cursor"])
        if representation not in {
            "http_response_body",
            "sdk_json_representation_not_wire_bytes",
            "controlled_fixture",
        }:
            raise ValueError("representation_invalid")
    except Exception as exc:  # noqa: BLE001 -- Provider boundary; sanitize all public errors.
        async with db.connection() as conn, conn.transaction():
            who = await authorized(conn, task)
            current = await owned_row(conn, task)
            if not current:
                return "lost"
            code = "authorization_changed" if not who else safe_error(exc)
            failed_raw = locals().get("raw") if "raw" in locals() else getattr(exc, "raw", None)
            if not isinstance(failed_raw, bytes) or len(failed_raw) > 131072:
                failed_raw = None
            await conn.execute(
                """INSERT INTO dividend_source_failures(attempt_id,task_id,owner_id,error_code,http_status,
                raw_bytes,raw_sha256,representation,body_complete) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    attempt_id,
                    task["id"],
                    task["owner_id"],
                    code,
                    getattr(exc, "status", None),
                    failed_raw,
                    digest(failed_raw) if failed_raw is not None else None,
                    locals().get("representation")
                    or ("http_response_body" if getattr(exc, "raw", None) is not None else None),
                    getattr(exc, "complete", True),
                ),
            )
            await conn.execute(
                "UPDATE dividend_source_scans SET latest_error=%s WHERE task_id=%s", (code, task["id"])
            )
            if current["status"] == "cancel_requested":
                await conn.execute(
                    "UPDATE dividend_source_scans SET state='cancelled' WHERE task_id=%s", (task["id"],)
                )
                await finish(Bound(conn, db.settings), task)
                return "cancelled"
            if not who or current["attempts"] >= 3:
                await conn.execute(
                    "UPDATE dividend_source_scans SET state='failed' WHERE task_id=%s", (task["id"],)
                )
                await finish(Bound(conn, db.settings), task, error_code=code)
                return "failed"
            # Retry only this read-only page, with the original task UUID and persisted earlier pages.
            await conn.execute("UPDATE tasks SET status='queued',lease_until=NULL WHERE id=%s", (task["id"],))
            await conn.execute(
                "INSERT INTO task_events(task_id,phase) VALUES(%s,'source_page_retry')", (task["id"],)
            )
            return "retry"
    async with db.connection() as conn, conn.transaction():
        who = await authorized(conn, task)
        current = await owned_row(conn, task)
        if not current:
            return "lost"
        if current["status"] == "cancel_requested" or not who:
            await conn.execute(
                "UPDATE dividend_source_scans SET state=%s WHERE task_id=%s",
                ("cancelled" if who else "failed", task["id"]),
            )
            await finish(Bound(conn, db.settings), task, error_code=None if who else "authorization_changed")
            return "cancelled" if who else "failed"
        try:
            # Approval can be revoked while the request was in flight; do not publish those bytes.
            service.target(config["target_id"], config["target_fingerprint"])
            if await external_delivery_blocked(conn):
                raise ValueError("restore_quarantined")
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("dividend-source:" + who.id,)
            )
            async with conn.transaction():
                await persist(conn, who, task, config, page, raw, representation, attempt_id)
        except ValueError as exc:
            code = safe_error(exc)
            await conn.execute(
                """INSERT INTO dividend_source_failures(attempt_id,task_id,owner_id,error_code,
                raw_bytes,raw_sha256,representation) VALUES(%s,%s,%s,%s,%s,%s,%s)""",
                (attempt_id, task["id"], who.id, code, raw, digest(raw), representation),
            )
            await conn.execute(
                "UPDATE dividend_source_scans SET state='failed',latest_error=%s WHERE task_id=%s",
                (code, task["id"]),
            )
            await finish(Bound(conn, db.settings), task, error_code=code)
            return "failed"
        if page.next_cursor is None:
            await finish(
                Bound(conn, db.settings),
                task,
                result={
                    "scanId": str(task["id"]),
                    "pages": config["next_cursor"],
                    "observations": config["observed_count"] + len(page.records),
                    "completeHistory": False,
                    "cashWritten": False,
                },
            )
            return "succeeded"
        await checkpoint(Bound(conn, db.settings), task, "source_page_committed")
        return "more"


async def persist(conn, who, task, config, page, raw, representation, attempt_id):
    if config["expected_count"] is not None and config["expected_count"] != page.total:
        raise ValueError("source_pagination_changed")
    if config["expected_pages"] is not None and config["expected_pages"] != page.page_count:
        raise ValueError("source_pagination_changed")
    records = [digest(canonical(row).encode()) for _, row, _ in page.records]
    old = await (
        await conn.execute(
            "SELECT record_fingerprint FROM dividend_source_observations WHERE owner_id=%s AND task_id=%s",
            (who.id, task["id"]),
        )
    ).fetchall()
    if len(set(records)) != len(records) or set(records) & {r["record_fingerprint"] for r in old}:
        raise ValueError("source_duplicates")
    if page.next_cursor is None and config["observed_count"] + len(records) != page.total:
        raise ValueError("source_pagination_count_mismatch")
    received = (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
    source_contract = (
        "official_market_local_calendar_yyyy_mm_dd"
        if config["source"] == "futu"
        else "observed_contract_unverified"
    )
    await conn.execute(
        """INSERT INTO dividend_source_pages(owner_id,task_id,cursor,attempt_id,raw_bytes,raw_sha256,
        representation,received_at,source_timezone,source_date_contract,pagination_semantics,record_count)
        VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (
            who.id,
            task["id"],
            config["next_cursor"],
            attempt_id,
            raw,
            digest(raw),
            representation,
            received,
            page.timezone,
            source_contract,
            page.pagination,
            len(records),
        ),
    )
    for (pointer, row, normalized), record_hash in zip(page.records, records, strict=True):
        event = "observation:" + record_hash
        prior = await (
            await conn.execute(
                """SELECT revision FROM dividend_announcement_revisions
            WHERE owner_id=%s AND source=%s AND market=%s AND code=%s AND source_event_id=%s ORDER BY version DESC LIMIT 1""",
                (who.id, config["source"], config["market"], config["code"], event),
            )
        ).fetchone()
        if prior:
            revision = prior["revision"]
        else:
            revision = uuid4()
            request_id = uuid5(task["id"], str(config["next_cursor"]) + pointer)
            await conn.execute(
                """INSERT INTO dividend_announcement_revisions(owner_id,revision,request_id,source,market,code,
                source_event_id,source_revision,previous_revision,version,captured_at,market_timezone,date_basis,raw_payload,
                raw_sha256,normalizer_version,normalized,fingerprint) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,NULL,1,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (
                    who.id,
                    revision,
                    request_id,
                    config["source"],
                    config["market"],
                    config["code"],
                    event,
                    digest(raw) + "#" + pointer,
                    received,
                    page.timezone,
                    "source_calendar_date" if config["source"] == "futu" else None,
                    raw.decode("utf-8"),
                    digest(raw),
                    normalized["normalizerVersion"],
                    Jsonb(jsonable(normalized)),
                    record_hash,
                ),
            )
            await conn.execute(
                """INSERT INTO dividend_review_notices(owner_id,id,task_id,announcement_revision,contents)
                VALUES(%s,%s,%s,%s,%s)""",
                (
                    who.id,
                    uuid5(task["id"], str(revision)),
                    task["id"],
                    revision,
                    Jsonb(
                        {
                            "kind": "source_observation_review",
                            "eventIdentity": "unresolved",
                            "cashWritten": False,
                            "sourceRevision": str(revision),
                            "delivery": "in_platform_only",
                        }
                    ),
                ),
            )
        await conn.execute(
            """INSERT INTO dividend_source_observations(owner_id,task_id,cursor,json_pointer,announcement_revision,record_fingerprint)
            VALUES(%s,%s,%s,%s,%s,%s)""",
            (who.id, task["id"], config["next_cursor"], pointer, revision, record_hash),
        )
    await conn.execute(
        """UPDATE dividend_source_scans SET next_cursor=%s,expected_count=%s,expected_pages=%s,observed_count=observed_count+%s,
        state=%s,latest_error=NULL,not_before=NULL,completed_at=CASE WHEN %s THEN clock_timestamp() ELSE NULL END WHERE task_id=%s""",
        (
            page.next_cursor or config["next_cursor"],
            page.total,
            page.page_count,
            len(records),
            "partial" if page.next_cursor else "complete",
            page.next_cursor is None,
            task["id"],
        ),
    )


def jsonable(value):
    import json

    return json.loads(canonical(value), parse_float=str)


class Bound:
    def __init__(self, conn, settings):
        self.conn, self.settings = conn, settings

    def connection(self):
        from contextlib import asynccontextmanager

        @asynccontextmanager
        async def bound():
            yield self.conn

        return bound()


def mount(app, service):
    member = Annotated[Identity, Depends(identity)]
    admin = Annotated[Identity, Depends(administrator)]

    @app.post("/api/dividends/sources", status_code=201)
    async def configure(raw: dict, who: admin):
        return await service.configure(who, raw)

    @app.get("/api/dividends/sources/{revision}")
    async def state(revision: UUID, who: member):
        return await service.read(who, revision)

    @app.post("/api/dividends/sources/tasks", status_code=202, response_model=TaskOut)
    async def submit(data: CollectInput, who: admin):
        return await service.submit(who, data)

    @app.get("/api/dividends/source-tasks/{task_id}", response_model=TaskDetail)
    async def detail(task_id: UUID, who: admin):
        return await tasks.detail(service.db, who, task_id)

    @app.post("/api/dividends/source-tasks/{task_id}/cancel", response_model=TaskOut)
    async def cancel(task_id: UUID, who: admin):
        return await tasks.cancel(service.db, who, task_id)
