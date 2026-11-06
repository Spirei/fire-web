"""Durable dividend candidate jobs using the existing tasks/lease/receipt tables."""

from contextlib import asynccontextmanager
from typing import Literal
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict

from alcor_api import tasks
from alcor_api.dividend_chain import DividendChain, announcement_input
from alcor_api.dividend_entitlements import ident, text
from alcor_api.security import Identity
from alcor_api.worker import finish, owned_row

KINDS = ("dividends.source.import", "dividends.entitlements.review")


class DividendTaskInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    kind: Literal["dividends.source.import", "dividends.entitlements.review"]
    data: dict


def review_input(data):
    if not isinstance(data, dict) or data.keys() != {
        "recordId",
        "recordRevision",
        "announcementRevision",
        "coverageRevision",
    }:
        raise ValueError("invalid review scope")
    text(data["recordId"])
    ident(data["announcementRevision"])
    if data["coverageRevision"] is not None:
        ident(data["coverageRevision"])
    if type(data["recordRevision"]) is not int or data["recordRevision"] < 1:
        raise ValueError("record version required")
    return data


async def submit(db, who, data):
    try:
        if data.kind == "dividends.source.import":
            announcement_input(data.data)
        else:
            review_input(data.data)
    except (ValueError, TypeError, KeyError) as exc:
        raise HTTPException(422, "股息任务来源或目标参数无效") from exc
    # Same durable UUID fingerprint, owner budget, CSRF and transactional admin checks.
    return await tasks.submit(db, who, data)


async def claim(db, worker_id):
    async with db.connection() as conn, conn.transaction():
        ended = await (
            await conn.execute(
                """UPDATE tasks SET status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE 'failed' END,
            error_code=CASE WHEN status='cancel_requested' THEN NULL ELSE 'retry_budget_exhausted' END,
            finished_at=clock_timestamp(),lease_until=NULL
            WHERE kind=ANY(%s) AND lease_until<clock_timestamp()
            AND (status='cancel_requested' OR (status='running' AND attempts>=3)) RETURNING id,status""",
                (list(KINDS),),
            )
        ).fetchall()
        for row in ended:
            await conn.execute(
                "INSERT INTO task_events(task_id,phase) VALUES(%s,%s)", (row["id"], row["status"])
            )
        row = await (
            await conn.execute(
                """WITH candidate AS (
            SELECT id FROM tasks WHERE kind=ANY(%s) AND attempts<3
            AND (status='queued' OR (status='running' AND lease_until<clock_timestamp()))
            ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
            UPDATE tasks t SET status='running',attempts=attempts+1,lease_version=lease_version+1,
            lease_owner=%s,lease_until=clock_timestamp()+make_interval(secs=>%s),
            started_at=COALESCE(started_at,clock_timestamp()) FROM candidate c WHERE t.id=c.id RETURNING t.*""",
                (list(KINDS), worker_id, db.settings.lease_seconds),
            )
        ).fetchone()
        if row:
            await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'running')", (row["id"],))
        return row


class BoundDatabase:
    def __init__(self, conn, settings):
        self.conn, self.settings = conn, settings

    @asynccontextmanager
    async def connection(self):
        yield self.conn


async def execute(db, task, coverage_verifier=None):
    async with db.connection() as conn, conn.transaction():
        # Identity before task-row lock: the same order used by cancellation/submission.
        user = await (
            await conn.execute(
                """SELECT u.id,u.username,u.role,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id
            WHERE u.id=%s AND s.token_hash=%s AND s.client_id='new-web' AND u.active AND u.role='admin'
            AND s.expires_at>clock_timestamp() AND s.session_version=u.session_version FOR SHARE OF u,s""",
                (task["owner_id"], task["payload"].get("_session_hash", "")),
            )
        ).fetchone()
        current = await owned_row(conn, task)
        if not current:
            return False
        bound = BoundDatabase(conn, db.settings)
        if current["status"] == "cancel_requested":
            return await finish(bound, task)
        if not user:
            return await finish(bound, task, error_code="authorization_changed")
        who = Identity(**user, token_hash=task["payload"]["_session_hash"], csrf="")
        service = DividendChain(bound, coverage_verifier)
        try:
            async with conn.transaction():
                if task["kind"] == "dividends.source.import":
                    value = await service.append(who, task["payload"]["data"])
                    announcement_revision = value["revision"]
                    record_id = coverage_revision = None
                    contents = {
                        "kind": "source_revision_review",
                        "announcement": value,
                        "cashWritten": False,
                        "delivery": "in_platform_only",
                    }
                elif task["kind"] == "dividends.entitlements.review":
                    data = review_input(task["payload"]["data"])
                    value = await service._entitlement(
                        conn,
                        who,
                        data["recordId"],
                        data["announcementRevision"],
                        data["coverageRevision"],
                    )
                    if value["recordRevision"] != data["recordRevision"]:
                        raise HTTPException(409, "证券版本已变化")
                    announcement_revision = data["announcementRevision"]
                    record_id, coverage_revision = data["recordId"], data["coverageRevision"]
                    contents = {
                        "kind": "entitlement_review",
                        "expectation": value,
                        "cashWritten": False,
                        "delivery": "in_platform_only",
                    }
                else:
                    raise HTTPException(422, "不支持的股息任务")
                notice_id = uuid4()
                await conn.execute(
                    """INSERT INTO dividend_review_notices(
                    owner_id,id,task_id,announcement_revision,record_id,coverage_revision,contents)
                    VALUES(%s,%s,%s,%s,%s,%s,%s)""",
                    (
                        who.id,
                        notice_id,
                        task["id"],
                        announcement_revision,
                        record_id,
                        coverage_revision,
                        Jsonb(contents),
                    ),
                )
                result = {"noticeId": str(notice_id), "value": value, "cashWritten": False}
        except HTTPException as exc:
            code = "version_or_source_changed" if exc.status_code == 409 else "invalid_source_or_scope"
            return await finish(bound, task, error_code=code)
        # Fencing failure rolls back source revision, notice and receipt together.
        current = await owned_row(conn, task)
        if not current:
            raise RuntimeError("Dividend candidate lease lost; transaction must roll back")
        return await finish(bound, task, result=result)
