"""Prepared self-closure and a minimal read/close capability surviving logout."""

import hashlib
import json
import re
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from psycopg.types.json import Jsonb
from pydantic import Field, SecretStr, field_validator

from .models import InputModel
from .profile_http import bounded_body
from .resource_api import no_duplicate_object
from .security import Identity, digest, identity, lock_mutation_identity, trusted_origin

Member = Annotated[Identity, Depends(identity)]


class ReceiptCapability(InputModel):
    receipt_token: SecretStr = Field(min_length=47, max_length=47)

    @field_validator("receipt_token")
    @classmethod
    def valid_capability(cls, value):
        if not re.fullmatch(r"acr_[A-Za-z0-9_-]{43}", value.get_secret_value()):
            raise ValueError("invalid_closure_capability")
        return value


class PrepareClosure(ReceiptCapability):
    request_id: UUID
    revision: UUID


class ClosureRoute(APIRoute):
    def get_route_handler(self):
        native = super().get_route_handler()

        async def handle(request):
            if request.method == "POST":
                try:

                    def invalid_constant(_):
                        raise ValueError()

                    body = json.loads(
                        await bounded_body(request, 4096),
                        object_pairs_hook=no_duplicate_object,
                        parse_constant=invalid_constant,
                    )
                    if not isinstance(body, dict):
                        raise TypeError()
                except (ValueError, TypeError, UnicodeError):
                    raise HTTPException(422, "注销请求格式无效") from None
            return await native(request)

        return handle


router = APIRouter(prefix="/account/closure", tags=["account-closure"], route_class=ClosureRoute)


def response(value):
    return JSONResponse(value, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})


async def budget(request, category, maximum):
    address = request.client.host if request.client else "unknown"
    for key, limit in (
        (digest("closure-" + category + ":" + address), maximum),
        ("closure-" + category + "-global", maximum * 10),
    ):
        if not await request.app.state.rate_limit(request.app.state.db, key, limit, window_seconds=3600):
            raise HTTPException(429, "操作过于频繁，请稍后再试")


async def serialize(conn, owner=None):
    await conn.execute("SELECT pg_advisory_xact_lock(67132005)")
    if owner:
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + owner,)
        )


def prepared_projection(row):
    return {
        "request_id": str(row["request_id"]),
        "state": row["state"],
        "revision": str(row["revision"]),
        "prepared_until": row["prepared_until"].isoformat(),
        "expires_at": row["expires_at"].isoformat(),
        "scope": "account-closure-only",
    }


async def receipt_projection(conn, row):
    value = {"request_id": str(row["request_id"]), "state": row["state"], "scope": "account-closure-only"}
    if row["state"] == "prepared":
        return prepared_projection(row)
    action = await (
        await conn.execute(
            "SELECT result,closed FROM account_actions WHERE owner_id=%s AND request_id=%s",
            (row["owner_id"], row["request_id"]),
        )
    ).fetchone()
    if not action:
        raise HTTPException(503, "原注销回执不可用")
    result = action["result"]
    if not isinstance(result, dict) or result.get("request_id") != str(row["request_id"]):
        raise HTTPException(503, "原注销回执编号不一致")
    if row["state"] == "closed":
        if not action["closed"] or result.get("executed") is not False or result.get("closed") is not True:
            raise HTTPException(503, "原注销回执状态不一致")
        return {**value, "closed": True, "executed": False}
    if action["closed"] or result.get("deleted") is not True or result.get("user_id") != row["owner_id"]:
        raise HTTPException(503, "原注销回执状态不一致")
    return {**value, "deleted": True}


def capability_hash(instance_id, token):
    return digest("account-closure-only:v1:" + str(instance_id) + ":" + token)


async def capability_row(conn, request_id, token, *, instance_id, owner=None, lock=False):
    condition = " AND owner_id=%s" if owner else ""
    args = [request_id, capability_hash(instance_id, token)] + ([owner] if owner else [])
    row = await (
        await conn.execute(
            "SELECT * FROM account_closure_intents WHERE request_id=%s AND token_hash=%s "
            "AND expires_at>clock_timestamp()" + condition + (" FOR UPDATE" if lock else ""),
            args,
        )
    ).fetchone()
    if not row:
        raise HTTPException(404, "未查到原注销请求，请保留原编号")
    return row


@router.get("/config")
async def config(request: Request):
    async with request.app.state.db.connection():
        pass  # Database.connection verifies the exact instance and schema identity.
    return response(
        {"instance_id": str(request.app.state.db.settings.instance_id), "scope": "account-closure-only"}
    )


@router.post("/prepare")
async def prepare(data: PrepareClosure, request: Request, who: Member):
    await budget(request, "prepare", 20)
    db = request.app.state.db
    async with db.connection() as conn, conn.transaction():
        await serialize(conn, who.id)
        await lock_mutation_identity(conn, who, require_admin=False)
        user = await (
            await conn.execute("SELECT revision FROM users WHERE id=%s FOR UPDATE", (who.id,))
        ).fetchone()
        previous = await (
            await conn.execute(
                "SELECT * FROM account_closure_intents WHERE owner_id=%s AND request_id=%s",
                (who.id, data.request_id),
            )
        ).fetchone()
        if previous:
            if (
                previous["token_hash"]
                != capability_hash(
                    request.app.state.db.settings.instance_id, data.receipt_token.get_secret_value()
                )
                or previous["revision"] != data.revision
                or previous["prepared_session_hash"] != who.token_hash
            ):
                raise HTTPException(409, "原注销编号已绑定其他准备请求")
            return response(await receipt_projection(conn, previous))
        if user["revision"] != data.revision:
            raise HTTPException(409, "账号已更新，请重新读取")
        used = await (
            await conn.execute(
                "SELECT 1 FROM account_actions WHERE owner_id=%s AND request_id=%s UNION ALL "
                "SELECT 1 FROM account_closure_intents WHERE token_hash=%s",
                (
                    who.id,
                    data.request_id,
                    capability_hash(
                        request.app.state.db.settings.instance_id, data.receipt_token.get_secret_value()
                    ),
                ),
            )
        ).fetchone()
        if used:
            raise HTTPException(409, "注销编号或查询凭证已使用")
        row = await (
            await conn.execute(
                "INSERT INTO account_closure_intents(owner_id,request_id,token_hash,prepared_session_hash,revision) "
                "VALUES(%s,%s,%s,%s,%s) RETURNING *",
                (
                    who.id,
                    data.request_id,
                    capability_hash(
                        request.app.state.db.settings.instance_id, data.receipt_token.get_secret_value()
                    ),
                    who.token_hash,
                    data.revision,
                ),
            )
        ).fetchone()
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'account.closure.prepared',%s,%s)",
            (who.id, who.id, request.state.request_id),
        )
        return response(prepared_projection(row))


@router.post("/abort")
async def abort_prepare(data: PrepareClosure, request: Request, who: Member):
    await budget(request, "close", 60)
    async with request.app.state.db.connection() as conn, conn.transaction():
        await serialize(conn, who.id)
        await lock_mutation_identity(conn, who, require_admin=False)
        row = await (
            await conn.execute(
                "SELECT * FROM account_closure_intents WHERE owner_id=%s AND request_id=%s FOR UPDATE",
                (who.id, data.request_id),
            )
        ).fetchone()
        token_hash = capability_hash(
            request.app.state.db.settings.instance_id, data.receipt_token.get_secret_value()
        )
        if row:
            if row["token_hash"] != token_hash or row["revision"] != data.revision:
                raise HTTPException(409, "原注销编号与查询凭证不符")
        else:
            used = await (
                await conn.execute(
                    "SELECT 1 FROM account_actions WHERE owner_id=%s AND request_id=%s UNION ALL SELECT 1 FROM account_closure_intents WHERE token_hash=%s",
                    (who.id, data.request_id, token_hash),
                )
            ).fetchone()
            if used:
                raise HTTPException(409, "注销编号或查询凭证已使用")
            row = await (
                await conn.execute(
                    "INSERT INTO account_closure_intents(owner_id,request_id,token_hash,prepared_session_hash,revision) VALUES(%s,%s,%s,%s,%s) RETURNING *",
                    (who.id, data.request_id, token_hash, who.token_hash, data.revision),
                )
            ).fetchone()
        return response(await close_row(conn, row, request.state.request_id))


@router.post("/{request_id}/receipt")
async def receipt(request_id: UUID, data: ReceiptCapability, request: Request):
    trusted_origin(request)
    await budget(request, "receipt", 120)
    async with request.app.state.db.connection() as conn, conn.transaction():
        row = await capability_row(
            conn,
            request_id,
            data.receipt_token.get_secret_value(),
            instance_id=request.app.state.db.settings.instance_id,
        )
        return response(await receipt_projection(conn, row))


@router.post("/{request_id}/close")
async def close_pending(request_id: UUID, data: ReceiptCapability, request: Request):
    trusted_origin(request)
    await budget(request, "close", 60)
    async with request.app.state.db.connection() as conn, conn.transaction():
        await serialize(conn)
        row = await capability_row(
            conn,
            request_id,
            data.receipt_token.get_secret_value(),
            instance_id=request.app.state.db.settings.instance_id,
            lock=True,
        )
        return response(await close_row(conn, row, request.state.request_id))


async def close_row(conn, row, audit_id):
    request_id = row["request_id"]
    if row["state"] != "prepared":
        return await receipt_projection(conn, row)
    previous = await (
        await conn.execute(
            "SELECT 1 FROM account_actions WHERE owner_id=%s AND request_id=%s",
            (row["owner_id"], request_id),
        )
    ).fetchone()
    if previous:
        raise HTTPException(503, "原注销请求状态不一致")
    result = {"request_id": str(request_id), "closed": True, "executed": False}
    await conn.execute(
        "INSERT INTO account_actions(owner_id,request_id,fingerprint,result,closed) VALUES(%s,%s,%s,%s,true)",
        (
            row["owner_id"],
            request_id,
            hashlib.sha256(b"closed-account-action-v1").hexdigest(),
            Jsonb(result),
        ),
    )
    await conn.execute(
        "UPDATE account_closure_intents SET state='closed',finished_at=clock_timestamp() WHERE owner_id=%s AND request_id=%s",
        (row["owner_id"], request_id),
    )
    await conn.execute(
        "INSERT INTO audit_events(action,target_id,request_id) VALUES('account.closure.request_closed',%s,%s)",
        (row["owner_id"], audit_id),
    )
    return {
        "request_id": str(request_id),
        "state": "closed",
        "scope": "account-closure-only",
        "closed": True,
        "executed": False,
    }


async def finalize(data, request, who):
    from .account_admin import retire_account

    await budget(request, "confirm", 10)
    async with request.app.state.db.connection() as conn, conn.transaction():
        await serialize(conn, who.id)
        await lock_mutation_identity(conn, who, require_admin=False)
        row = await capability_row(
            conn,
            data.request_id,
            data.receipt_token.get_secret_value(),
            instance_id=request.app.state.db.settings.instance_id,
            owner=who.id,
            lock=True,
        )
        if row["state"] != "prepared":
            raise HTTPException(409, "原注销请求已受理或关闭，请查询原编号")
        if row["prepared_session_hash"] != who.token_hash or row["revision"] != data.revision:
            raise HTTPException(409, "原注销准备与当前会话或账号版本不符")
        deadline = await (
            await conn.execute("SELECT clock_timestamp()<%s AS valid", (row["prepared_until"],))
        ).fetchone()
        if not deadline["valid"]:
            raise HTTPException(409, "原注销准备已过期，请先关闭原编号")
        user = await request.app.state.native_passkeys.step_up(
            conn, who, data.current_password.get_secret_value(), data.code
        )
        if user["revision"] != row["revision"]:
            raise HTTPException(409, "账号已更新，请重新核对原注销请求")
        await lock_mutation_identity(conn, who, require_admin=False)
        deadline = await (
            await conn.execute("SELECT clock_timestamp()<%s AS valid", (row["prepared_until"],))
        ).fetchone()
        if not deadline["valid"]:
            raise HTTPException(409, "原注销准备已过期，请先关闭原编号")
        result = await retire_account(conn, who, who.id, data, request.state.request_id, self_close=True)
        await conn.execute(
            "UPDATE account_closure_intents SET state='completed',finished_at=clock_timestamp() WHERE owner_id=%s AND request_id=%s",
            (who.id, data.request_id),
        )
        return result
