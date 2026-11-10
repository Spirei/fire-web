import base64
import hashlib
import json
from datetime import datetime
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .models import TaskInput
from .security import lock_mutation_identity


async def submit(db, who, data: TaskInput):
    payload = data.model_dump(mode="json", exclude={"request_id"}, exclude_none=True)
    fingerprint = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    async with db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who)
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (who.id,))
        new = await (
            await conn.execute(
                """
            INSERT INTO tasks (id,owner_id,request_id,fingerprint,kind,status,payload)
            VALUES (%s,%s,%s,%s,%s,'queued',%s) ON CONFLICT (owner_id,request_id) DO NOTHING RETURNING *
        """,
                (
                    uuid4(),
                    who.id,
                    data.request_id,
                    fingerprint,
                    data.kind,
                    Jsonb(payload | {"_session_hash": who.token_hash, "_session_client": "legacy-web" if getattr(who, "legacy_client", False) and not getattr(who, "legacy_platform", False) else "new-web"}),
                ),
            )
        ).fetchone()
        row = (
            new
            or await (
                await conn.execute(
                    "SELECT * FROM tasks WHERE owner_id=%s AND request_id=%s", (who.id, data.request_id)
                )
            ).fetchone()
        )
        if row["fingerprint"] != fingerprint:
            raise HTTPException(409, "此请求编号已用于不同操作")
        if new:
            if data.kind.startswith("backup."):
                from .client_auth import recent
                from .backups import BackupFailure, validate_input

                await recent(conn, who)
                try:
                    await validate_input(db.settings, db, data, who)
                except BackupFailure as exc:
                    raise HTTPException(422, str(exc)) from None
            count = await (
                await conn.execute(
                    "SELECT count(*) AS n FROM tasks WHERE owner_id=%s AND kind<>'market.latest' AND status IN ('queued','running','cancel_requested')",
                    (who.id,),
                )
            ).fetchone()
            if count["n"] > 100:
                raise HTTPException(429, "待执行任务已达上限，请等待已有任务完成")
            await conn.execute("INSERT INTO task_events (task_id,phase) VALUES (%s,'queued')", (row["id"],))
            await conn.execute(
                "INSERT INTO audit_events (actor_id,action,target_id,request_id) VALUES (%s,'task.submitted',%s,%s)",
                (who.id, str(row["id"]), data.request_id),
            )
        return row


def decode_cursor(value):
    try:
        stamp, ident = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
        when = datetime.fromisoformat(stamp)
        if not when.tzinfo:
            raise ValueError()
        return when, UUID(ident)
    except Exception:
        raise HTTPException(422, "分页标记无效") from None


async def list_tasks(db, who, limit: int, cursor: str | None, status: str | None):
    args = [who.id]
    conditions = ["owner_id=%s"]
    if status:
        conditions.append("status=%s")
        args.append(status)
    if cursor:
        stamp, ident = decode_cursor(cursor)
        conditions.append("(created_at,id)<(%s,%s)")
        args.extend([stamp, ident])
    args.append(limit + 1)
    async with db.connection() as conn:
        # SQL fragments are constant; all caller-provided values remain bound parameters.
        rows = await (
            await conn.execute(
                "SELECT * FROM tasks WHERE "
                + " AND ".join(conditions)
                + " ORDER BY created_at DESC,id DESC LIMIT %s",
                args,
            )
        ).fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = (
        base64.urlsafe_b64encode(
            json.dumps([rows[-1]["created_at"].isoformat(), str(rows[-1]["id"])]).encode()
        )
        .decode()
        .rstrip("=")
        if more
        else None
    )
    return {"items": rows, "next_cursor": next_cursor}


async def detail(db, who, task_id):
    async with db.connection() as conn, conn.transaction():
        row = await (
            await conn.execute("SELECT * FROM tasks WHERE id=%s AND owner_id=%s FOR SHARE", (task_id, who.id))
        ).fetchone()
        if not row:
            raise HTTPException(404, "任务不存在或无权查看")
        events = await (
            await conn.execute(
                "SELECT id,phase,created_at FROM task_events WHERE task_id=%s ORDER BY id LIMIT 100",
                (task_id,),
            )
        ).fetchall()
        return {**row, "events": events}


async def cancel(db, who, task_id):
    async with db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who)
        row = await (
            await conn.execute(
                "SELECT * FROM tasks WHERE id=%s AND owner_id=%s FOR UPDATE", (task_id, who.id)
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "任务不存在或无权查看")
        if row["status"] in {"succeeded", "failed"}:
            raise HTTPException(409, "任务已结束，无法取消")
        if row["status"] not in {"cancel_requested", "cancelled"}:
            status = "cancelled" if row["status"] == "queued" else "cancel_requested"
            row = await (
                await conn.execute(
                    "UPDATE tasks SET status=%s,finished_at=CASE WHEN %s='cancelled' THEN clock_timestamp() ELSE NULL END WHERE id=%s RETURNING *",
                    (status, status, task_id),
                )
            ).fetchone()
            await conn.execute("INSERT INTO task_events (task_id,phase) VALUES (%s,%s)", (task_id, status))
            await conn.execute(
                "INSERT INTO audit_events (actor_id,action,target_id) VALUES (%s,'task.cancel_requested',%s)",
                (who.id, str(task_id)),
            )
        return row
