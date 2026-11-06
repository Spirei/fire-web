"""Owner-scoped, read-only history of original FX request receipts."""

import base64
import hashlib
import json
from typing import Annotated

from fastapi import Depends, HTTPException, Query, Response

from .security import Identity, identity, lock_mutation_identity


def cursor_value(owner, identifier):
    raw = json.dumps([1, hashlib.sha256(owner.encode()).hexdigest(), identifier], separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def cursor_id(owner, cursor):
    if cursor is None:
        return None
    try:
        if not isinstance(cursor, str) or not 1 <= len(cursor) <= 256:
            raise ValueError()
        value = json.loads(base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True))
        if (
            not isinstance(value, list)
            or len(value) != 3
            or value[0] != 1
            or value[1] != hashlib.sha256(owner.encode()).hexdigest()
            or type(value[2]) is not int
            or not 1 <= value[2] < 2**63
            or cursor_value(owner, value[2]) != cursor
        ):
            raise ValueError()
        return value[2]
    except (ValueError, TypeError, UnicodeError):
        raise HTTPException(400, "回执分页标记无效，请从第一页读取") from None


class ReferenceReceipts:
    def __init__(self, db):
        self.db = db

    async def list(self, who, *, limit=25, cursor=None):
        if type(limit) is not int or not 1 <= limit <= 100:
            raise HTTPException(422, "回执分页大小无效")
        before = cursor_id(who.id, cursor)
        principal = hashlib.sha256(("user:" + who.id).encode()).hexdigest()
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
            )
            await lock_mutation_identity(conn, who, require_admin=False)
            rows = await (
                await conn.execute(
                    "WITH originals AS ("
                    "SELECT DISTINCT ON (r.request_id) a.id AS sequence,a.created_at AS requested_at,"
                    "r.request_id,r.task_id FROM audit_events a "
                    "JOIN fx_requests r ON r.request_id=a.request_id AND r.principal=%s "
                    "WHERE a.actor_id=%s AND a.action='reference.fx.request' AND a.target_id=r.task_id::text "
                    "ORDER BY r.request_id,a.id) "
                    "SELECT o.*,t.state,t.error_code,t.created_at AS task_created_at,t.started_at,t.completed_at,t.observation_id "
                    "FROM originals o JOIN fx_refresh_tasks t ON t.id=o.task_id "
                    "WHERE (%s::bigint IS NULL OR o.sequence<%s::bigint) ORDER BY o.sequence DESC LIMIT %s",
                    (principal, who.id, before, before, limit + 1),
                )
            ).fetchall()
            items = rows[:limit]
            return {
                "items": [
                    {
                        "requestId": str(row["request_id"]),
                        "taskId": str(row["task_id"]),
                        "state": row["state"],
                        "errorCode": row["error_code"],
                        "requestedAt": row["requested_at"].isoformat(),
                        "taskCreatedAt": row["task_created_at"].isoformat(),
                        "startedAt": row["started_at"].isoformat() if row["started_at"] else None,
                        "completedAt": row["completed_at"].isoformat() if row["completed_at"] else None,
                        "observationId": str(row["observation_id"]) if row["observation_id"] else None,
                    }
                    for row in items
                ],
                "nextCursor": cursor_value(who.id, items[-1]["sequence"]) if len(rows) > limit else None,
            }


def mount_reference_receipts(app, db):
    service = ReferenceReceipts(db)

    @app.get("/api/reference/rates/operations", tags=["reference"])
    async def history(
        response: Response,
        who: Annotated[Identity, Depends(identity)],
        limit: int = Query(default=25, ge=1, le=100),
        cursor: str | None = Query(default=None, max_length=256),
    ):
        response.headers["Cache-Control"] = "no-store, private"
        return await service.list(who, limit=limit, cursor=cursor)
