"""Owner-scoped broker directory; provider connections and financial ledgers are separate domains."""

import hashlib
import json
import secrets
from contextlib import asynccontextmanager
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from psycopg.types.json import Jsonb
from pydantic import Field, field_validator, model_validator

from .models import InputModel
from .security import Identity, identity, lock_mutation_identity

CURRENCIES = (
    "USD",
    "EUR",
    "HKD",
    "CNY",
    "JPY",
    "KRW",
    "SGD",
    "GBP",
    "AUD",
    "CAD",
    "TWD",
    "MOP",
    "INR",
    "BRL",
    "CHF",
)
PROVIDERS = frozenset(
    (
        "longbridge",
        "ibkr",
        "futu",
        "tiger",
        "trading212",
        "moomoo",
        "robinhood",
        "huatai",
        "schwab",
        "usmart",
        "eastmoney",
        "ths",
    )
)
router = APIRouter(prefix="/api/broker-accounts", tags=["broker-accounts"])
async def broker_identity(request: Request):
    if "authorization" in request.headers:
        raise HTTPException(403, "请使用当前网页登录会话")
    if request.query_params:
        raise HTTPException(400, "不支持查询参数")
    return await identity(request)


Member = Annotated[Identity, Depends(broker_identity)]


class BrokerFields(InputModel):
    name: str = Field(min_length=1, max_length=60)
    currency: str
    currencies: list[str] = Field(min_length=1, max_length=15)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        if any(ord(c) < 32 or ord(c) == 127 for c in value) or not value.strip():
            raise ValueError("账户名称无效")
        # Match the old UTF-16 limit rather than accepting twice as many supplementary characters.
        if len(value.strip().encode("utf-16-le")) // 2 > 60:
            raise ValueError("账户名称过长")
        return value.strip()

    @model_validator(mode="after")
    def currencies_valid(self):
        if (
            self.currency not in CURRENCIES
            or self.currency not in self.currencies
            or len(set(self.currencies)) != len(self.currencies)
            or any(c not in CURRENCIES for c in self.currencies)
        ):
            raise ValueError("币种无效或默认币种不在已选集合内")
        self.currencies = [c for c in CURRENCIES if c in self.currencies]
        return self


class BrokerCreate(BrokerFields):
    request_id: UUID
    provider_id: str | None
    account_kind: Literal["real", "simulated"]

    @field_validator("provider_id")
    @classmethod
    def provider_valid(cls, value):
        if value is not None and value not in PROVIDERS:
            raise ValueError("机构无效")
        return value


class LegacyBrokerCreate(BrokerCreate):
    """Only the old contract lacks a ledger-kind claim; never infer a real account."""
    account_kind: Literal["unknown"] = "unknown"


class BrokerUpdate(BrokerFields):
    request_id: UUID
    revision: int = Field(ge=1, strict=True)


class BrokerDelete(InputModel):
    request_id: UUID
    revision: int = Field(ge=1, strict=True)


async def serialize_brokers(conn, owner, *, shared_read=False):
    """Same owner domains: explicit readers share; all writers remain exclusive."""
    function = 'pg_advisory_xact_lock_shared' if shared_read else 'pg_advisory_xact_lock'
    await conn.execute(
        f"SELECT {function}(hashtextextended(%s,0))", ("identity-management:" + owner,)
    )
    await conn.execute(f"SELECT {function}(hashtextextended(%s,0))", ("broker-accounts:" + owner,))


async def broker_account(conn, owner, account_id, *, include_deleted=False):
    row = await (
        await conn.execute("SELECT * FROM broker_accounts WHERE owner_id=%s AND id=%s", (owner, account_id))
    ).fetchone()
    if not row or (row["deleted_at"] is not None and not include_deleted):
        raise HTTPException(404, "账户不存在")
    references = await (
        await conn.execute(
            "SELECT kind,currency,count(*) AS count FROM broker_account_references "
            "WHERE owner_id=%s AND account_id=%s GROUP BY kind,currency",
            (owner, account_id),
        )
    ).fetchall()
    return {
        **row,
        "currency_usage": {
            "complete": all(r["currency"] is not None for r in references),
            "used_currencies": sorted({r["currency"] for r in references if r["currency"] is not None}),
            "reference_count": sum(r["count"] for r in references),
        },
    }


async def broker_collection(conn, owner):
    row = await (
        await conn.execute("SELECT revision FROM broker_account_collections WHERE owner_id=%s", (owner,))
    ).fetchone()
    return row["revision"] if row else 0


async def validate_broker_change(conn, who, kind, account_id, data):
    """One set of directory rules for previews and committed mutations."""
    current = None
    if kind == "create":
        count = await (
            await conn.execute(
                "SELECT count(*) AS count FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL",
                (who.id,),
            )
        ).fetchone()
        if count["count"] >= 100:
            raise HTTPException(409, "账户数已达上限")
    else:
        await conn.execute(
            "SELECT id FROM broker_accounts WHERE owner_id=%s AND id=%s FOR UPDATE", (who.id, account_id)
        )
        current = await broker_account(conn, who.id, account_id)
        if current["revision"] != data.revision:
            raise HTTPException(409, "账户已变化，请重新读取")
    if kind in {"create", "update"}:
        duplicate = await (
            await conn.execute(
                "SELECT 1 FROM broker_accounts WHERE owner_id=%s AND lower(name)=lower(%s) AND id<>%s AND deleted_at IS NULL",
                (who.id, data.name, account_id),
            )
        ).fetchone()
        if duplicate:
            raise HTTPException(409, "账户名称已使用")
    if kind == "update":
        usage = current["currency_usage"]
        removed = (set(current["currencies"]) | set(usage["used_currencies"])) - set(data.currencies)
        if removed and (not usage["complete"] or set(usage["used_currencies"]) - set(data.currencies)):
            raise HTTPException(409, "币种仍被使用或来源不完整，不能移除")
        if removed:
            from .scope_coverage import account_status

            for currency in sorted(removed):
                if not await account_status(conn, who.id, account_id, currency):
                    raise HTTPException(409, "历史来源尚未完整核对，不能移除币种")
    elif kind == "delete":
        if current["holding_source"] == "official":
            raise HTTPException(409, "官方来源账户须先核对来源及历史，不能直接删除")
        if current["currency_usage"]["reference_count"]:
            raise HTTPException(409, "账户仍有业务引用，不能删除")
        from .scope_coverage import account_status

        if not await account_status(conn, who.id, account_id) or not all(
            [await account_status(conn, who.id, account_id, currency) for currency in current["currencies"]]
        ):
            raise HTTPException(409, "历史来源尚未完整核对，不能删除账户")
    elif kind != "create":
        raise ValueError("unsupported broker mutation")
    return current


@asynccontextmanager
async def broker_connection(db, connection):
    if connection is not None:
        yield connection
    else:
        async with db.connection() as conn:
            yield conn


async def mutate_broker(db, who, kind, account_id, data, *, connection=None, project=None):
    payload = {"kind": kind, "account_id": account_id, "body": data.model_dump(mode="json")}
    fingerprint = hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()
    ).hexdigest()
    async with broker_connection(db, connection) as conn, conn.transaction():
        await serialize_brokers(conn, who.id)
        await lock_mutation_identity(conn, who, require_admin=False)
        previous = await (
            await conn.execute(
                "SELECT fingerprint,result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s",
                (who.id, data.request_id),
            )
        ).fetchone()
        if previous:
            if previous["result"].get("state") == "closed":
                return previous["result"]
            if previous["fingerprint"] != fingerprint:
                raise HTTPException(409, "请求编号已用于其他操作")
            return previous["result"]
        result_data = None
        error = None
        # Business rejection is a durable result; unexpected faults roll back receipt and effects together.
        try:
            async with conn.transaction():
                before = await validate_broker_change(conn, who, kind, account_id, data)
                if kind == "create":
                    account_id = "ba-" + secrets.token_hex(12)
                if kind == "create":
                    await conn.execute(
                        "INSERT INTO broker_accounts(id,owner_id,name,provider_id,account_kind,currency,currencies) "
                        "VALUES(%s,%s,%s,%s,%s,%s,%s)",
                        (
                            account_id,
                            who.id,
                            data.name,
                            data.provider_id,
                            data.account_kind,
                            data.currency,
                            data.currencies,
                        ),
                    )
                elif kind == "update":
                    await conn.execute(
                        "UPDATE broker_accounts SET name=%s,currency=%s,currencies=%s,revision=revision+1,"
                        "updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s",
                        (data.name, data.currency, data.currencies, who.id, account_id),
                    )
                    if before["name"] != data.name:
                        await conn.execute(
                            "UPDATE portfolio_records SET group_name=%s,updated_at=clock_timestamp() WHERE owner_id=%s AND broker_account_id=%s AND deleted_at IS NULL AND group_name IS DISTINCT FROM %s",
                            (data.name, who.id, account_id, data.name),
                        )
                elif kind == "delete":
                    await conn.execute(
                        "UPDATE broker_accounts SET deleted_at=clock_timestamp(),updated_at=clock_timestamp(),"
                        "revision=revision+1 WHERE owner_id=%s AND id=%s",
                        (who.id, account_id),
                    )
                else:
                    raise ValueError("unsupported broker mutation")
                result_data = await broker_account(conn, who.id, account_id, include_deleted=True)
                await conn.execute(
                    "INSERT INTO broker_account_collections(owner_id,revision) VALUES(%s,1) "
                    "ON CONFLICT(owner_id) DO UPDATE SET revision=broker_account_collections.revision+1",
                    (who.id,),
                )
                await conn.execute(
                    "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
                    (who.id, "broker." + kind, account_id, data.request_id),
                )
        except HTTPException as exc:
            error = {"status": exc.status_code, "message": exc.detail}
        result = jsonable_encoder(
            {
                "request_id": data.request_id,
                "kind": kind,
                "account_id": account_id,
                "state": "failed" if error else "completed",
                "error": error,
                "data": result_data,
                "collection_revision": await broker_collection(conn, who.id),
            }
        )
        if project is not None and not error:
            result["legacy_snapshot"] = jsonable_encoder(await project(conn, who.id, account_id))
        await conn.execute(
            "INSERT INTO broker_account_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
            (who.id, data.request_id, fingerprint, Jsonb(result)),
        )
        return result


def operation_response(result, *, created=False):
    from fastapi.responses import JSONResponse

    return JSONResponse(
        result, status_code=result["error"]["status"] if result["error"] else (201 if created else 200),
        headers={"Cache-Control": "no-store, private", "Vary": "Cookie"},
    )


@router.get("")
async def list_accounts(request: Request, who: Member):
    async with request.app.state.db.connection() as conn, conn.transaction():
        await serialize_brokers(conn, who.id)
        await lock_mutation_identity(conn, who, require_admin=False)
        rows = await (
            await conn.execute(
                "SELECT id FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL ORDER BY created_at,id",
                (who.id,),
            )
        ).fetchall()
        return {
            "items": [await broker_account(conn, who.id, row["id"]) for row in rows],
            "collection_revision": await broker_collection(conn, who.id),
        }


@router.get("/operations/{request_id}")
async def read_operation(request_id: UUID, request: Request, who: Member):
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who, require_admin=False)
        row = await (
            await conn.execute(
                "SELECT result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s",
                (who.id, request_id),
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "回执不存在")
        return row["result"]


@router.get("/{account_id}")
async def read_account(account_id: str, request: Request, who: Member):
    async with request.app.state.db.connection() as conn, conn.transaction():
        await serialize_brokers(conn, who.id)
        await lock_mutation_identity(conn, who, require_admin=False)
        return await broker_account(conn, who.id, account_id)


@router.post("")
async def create_account(data: BrokerCreate, request: Request, who: Member):
    return operation_response(
        await mutate_broker(request.app.state.db, who, "create", "", data), created=True
    )


@router.put("/{account_id}")
async def update_account(account_id: str, data: BrokerUpdate, request: Request, who: Member):
    return operation_response(await mutate_broker(request.app.state.db, who, "update", account_id, data))


@router.delete("/{account_id}")
async def delete_account(account_id: str, data: BrokerDelete, request: Request, who: Member):
    return operation_response(await mutate_broker(request.app.state.db, who, "delete", account_id, data))


def install_broker_accounts(app):
    app.include_router(router)
