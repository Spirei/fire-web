"""Owner-scoped account operation history and serialized unknown-request closure."""

import hashlib
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from psycopg.types.json import Jsonb

from .client_auth import recent
from .legacy_admin_route import AccountAdminRoute
from .models import InputModel
from .security import Identity, administrator, lock_mutation_identity

router = APIRouter(prefix="/users/receipts", tags=["accounts"], route_class=AccountAdminRoute)
Admin = Annotated[Identity, Depends(administrator)]


class CloseAccountAction(InputModel):
    expected_kind: Literal["account-action"]


def require_open(row):
    if row and row["closed"]:
        raise HTTPException(409, "原账号操作已关闭，未执行；请读取原编号回执")


async def projected_account_receipt(conn, result):
    """Retirement-aware delivery of immutable evidence, without rewriting it."""
    target = result.get("user") or result.get("profile")
    if not isinstance(target, dict) or not isinstance(target.get("id"), str):
        return result
    user = await (
        await conn.execute("SELECT id,uid,deleted_at FROM users WHERE id=%s", (target["id"],))
    ).fetchone()
    if not user:
        return {
            **{key: value for key, value in result.items() if key not in {"user", "profile"}},
            "user": {"id": target["id"], "uid": None, "active": None, "deleted": None},
            "retired": None,
            "redacted": True,
            "snapshot_state": "redacted_target_unavailable",
        }
    if user["deleted_at"] is None:
        return result
    return {
        **{key: value for key, value in result.items() if key not in {"user", "profile"}},
        "user": {"id": user["id"], "uid": user["uid"], "active": False, "deleted": True},
        "retired": True,
        "redacted": True,
        "snapshot_state": "redacted_after_retirement",
    }


@router.get("")
async def history(
    request: Request,
    who: Admin,
    after: UUID | None = None,
    limit: int = Query(default=20, ge=1, le=50),
):
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who)
        args = [who.id]
        condition = ""
        if after is not None:
            cursor = await (
                await conn.execute(
                    "SELECT created_at FROM account_actions WHERE owner_id=%s AND request_id=%s",
                    (who.id, after),
                )
            ).fetchone()
            if not cursor:
                raise HTTPException(404, "原账号操作分页标记不存在")
            condition = " AND (created_at,request_id)<(%s,%s)"
            args.extend([cursor["created_at"], after])
        args.append(limit + 1)
        rows = await (
            await conn.execute(
                "SELECT request_id,created_at,result FROM account_actions WHERE owner_id=%s"
                + condition
                + " ORDER BY created_at DESC,request_id DESC LIMIT %s",
                args,
            )
        ).fetchall()
        for row in rows:
            row["result"] = await projected_account_receipt(conn, row["result"])
    more = len(rows) > limit
    items = rows[:limit]
    return {"items": items, "next_after": str(items[-1]["request_id"]) if more else None}


@router.post("/{request_id}/close")
async def close(request_id: UUID, data: CloseAccountAction, request: Request, who: Admin):
    db = request.app.state.db
    for key, maximum in (("account-action-close:" + who.id, 60), ("account-action-close-global", 600)):
        if not await request.app.state.rate_limit(db, key, maximum, window_seconds=900):
            raise HTTPException(429, "尝试过于频繁，请稍后再试")
    async with db.connection() as conn, conn.transaction():
        # Every profile, privilege, delete and credential action acquires this first.
        # A late original mutation either commits first or observes this tombstone.
        await conn.execute("SELECT pg_advisory_xact_lock(67132005)")
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await lock_mutation_identity(conn, who)
        await recent(conn, who)
        previous = await (
            await conn.execute(
                "SELECT result FROM account_actions WHERE owner_id=%s AND request_id=%s",
                (who.id, request_id),
            )
        ).fetchone()
        if previous:
            return await projected_account_receipt(conn, previous["result"])
        result = {"request_id": str(request_id), "closed": True, "executed": False}
        await conn.execute(
            "INSERT INTO account_actions(owner_id,request_id,fingerprint,result,closed) VALUES(%s,%s,%s,%s,true)",
            (who.id, request_id, hashlib.sha256(b"closed-account-action-v1").hexdigest(), Jsonb(result)),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'account.operation.closed',%s,%s)",
            (who.id, who.id, request_id),
        )
        return result
