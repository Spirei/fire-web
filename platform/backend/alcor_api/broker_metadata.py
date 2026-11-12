"""Account directory preview/CAS over the existing broker domain, not a financial ledger."""

import hashlib
import json
from contextlib import asynccontextmanager
from uuid import UUID, uuid4

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from .broker_accounts import (
    BrokerCreate,
    BrokerDelete,
    BrokerUpdate,
    broker_account,
    broker_collection,
    broker_connection,
    mutate_broker,
    serialize_brokers,
    validate_broker_change,
)
from .security import digest, lock_mutation_identity


def fingerprint(value):
    return hashlib.sha256(
        json.dumps(jsonable_encoder(value), sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()
    ).hexdigest()


def command(raw):
    if not isinstance(raw, dict) or set(raw) != {
        "kind",
        "accountId",
        "data",
        "expectedCollectionRevision",
        "expectedRecordCollectionRevision",
    }:
        raise HTTPException(422, "账户预览字段无效")
    kind = raw["kind"]
    identifier = raw["accountId"]
    if (
        kind not in ("create", "update", "delete")
        or not isinstance(identifier, str)
        or (kind == "create" and identifier != "")
    ):
        raise HTTPException(422, "账户操作无效")
    if any(
        type(raw[k]) is not int or raw[k] < 0
        for k in ("expectedCollectionRevision", "expectedRecordCollectionRevision")
    ):
        raise HTTPException(422, "账户目录版本无效")
    try:
        data = {"create": BrokerCreate, "update": BrokerUpdate, "delete": BrokerDelete}[kind].model_validate(
            raw["data"]
        )
    except ValidationError:
        raise HTTPException(422, "账户参数无效") from None
    return kind, identifier, data


async def purge_broker_metadata_previews(conn, owner):
    installed = (
        await (
            await conn.execute(
                "SELECT EXISTS(SELECT 1 FROM public.schema_migrations WHERE name='0088_broker_metadata_previews.sql') AS installed"
            )
        ).fetchone()
    )["installed"]
    if not installed:
        present = await (
            await conn.execute("SELECT to_regclass('public.broker_metadata_previews') AS relation")
        ).fetchone()
        if present["relation"] is None:
            return
        raise HTTPException(503, "账户预览结构尚未完整核对")
    await conn.execute("DELETE FROM broker_metadata_previews WHERE owner_id=%s", (owner,))


class BrokerMetadata:
    def __init__(self, db):
        self.db = db

    @asynccontextmanager
    async def context(self, who, *, connection=None, shared_read=False):
        async with broker_connection(self.db, connection) as conn, conn.transaction():
            await serialize_brokers(conn, who.id, shared_read=shared_read)
            if shared_read:
                from .security import lock_read_identity
                await lock_read_identity(conn, who, require_admin=False)
            else:
                await lock_mutation_identity(conn, who, require_admin=False)
            yield conn

    async def versions(self, conn, owner):
        records = await (
            await conn.execute(
                "SELECT revision FROM portfolio_record_collections WHERE owner_id=%s", (owner,)
            )
        ).fetchone()
        return await broker_collection(conn, owner), records["revision"] if records else 0

    async def binding(self, conn, who):
        instance = await (
            await conn.execute("SELECT instance_id FROM alcor_instance WHERE singleton")
        ).fetchone()
        return digest(
            "broker-metadata:"
            + str(instance["instance_id"])
            + ":"
            + who.id
            + ":"
            + who.role
            + ":"
            + who.token_hash
            + ":"
            + str(getattr(who, "grant_id", ""))
        )

    async def dependency(self, conn, who, kind, identifier, data):
        before = await validate_broker_change(conn, who, kind, identifier, data)
        return before, fingerprint(before)

    async def state(self, who):
        async with self.context(who) as conn:
            collection, records = await self.versions(conn, who.id)
            rows = await (
                await conn.execute(
                    "SELECT id FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL ORDER BY created_at,id LIMIT 101",
                    (who.id,),
                )
            ).fetchall()
            if len(rows) > 100:
                raise HTTPException(409, "账户目录超过上限，请核对来源")
            return jsonable_encoder(
                {
                    "collectionRevision": collection,
                    "recordCollectionRevision": records,
                    "accounts": [await broker_account(conn, who.id, r["id"]) for r in rows],
                    "coverageScope": "platform_owned_directory",
                    "historicalCoverageKnown": False,
                    "financialAuthority": False,
                }
            )

    async def preview(self, who, raw):
        kind, identifier, data = command(raw)
        payload = {"kind": kind, "account_id": identifier, "body": data.model_dump(mode="json")}
        async with self.context(who) as conn:
            current, records = await self.versions(conn, who.id)
            if (current, records) != (
                raw["expectedCollectionRevision"],
                raw["expectedRecordCollectionRevision"],
            ):
                raise HTTPException(409, "账户或持仓目录已变化，请重新读取")
            previous = await (
                await conn.execute(
                    "SELECT 1 FROM broker_account_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, data.request_id),
                )
            ).fetchone()
            if previous:
                raise HTTPException(409, "请求已有结果，请查询原编号")
            before, dependency = await self.dependency(conn, who, kind, identifier, data)
            identifier_preview = uuid4()
            row = await (
                await conn.execute(
                    "INSERT INTO broker_metadata_previews(owner_id,id,request_id,kind,account_id,payload,fingerprint,authorization_binding,collection_revision,record_collection_revision,account_dependency) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING expires_at",
                    (
                        who.id,
                        identifier_preview,
                        data.request_id,
                        kind,
                        identifier,
                        Jsonb(payload),
                        fingerprint(payload),
                        await self.binding(conn, who),
                        current,
                        records,
                        dependency,
                    ),
                )
            ).fetchone()
            return jsonable_encoder(
                {
                    "requestId": str(data.request_id),
                    "previewId": str(identifier_preview),
                    "kind": kind,
                    "accountId": identifier,
                    "state": "preview",
                    "before": before,
                    "after": None if kind == "delete" else data.model_dump(mode="json"),
                    "collectionRevision": current,
                    "recordCollectionRevision": records,
                    "expiresAt": row["expires_at"],
                }
            )

    async def submit(self, who, raw):
        if not isinstance(raw, dict) or set(raw) != {"previewId", "command"}:
            raise HTTPException(422, "账户确认字段无效")
        kind, identifier, data = command(raw["command"])
        try:
            preview_id = UUID(raw["previewId"])
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, "账户预览编号无效") from None
        payload = {"kind": kind, "account_id": identifier, "body": data.model_dump(mode="json")}
        expected = fingerprint(payload)
        async with self.context(who) as conn:
            previous = await (
                await conn.execute(
                    "SELECT fingerprint,result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, data.request_id),
                )
            ).fetchone()
            if previous:
                if previous["result"].get("state") == "closed":
                    return previous["result"]
                if previous["fingerprint"] != expected:
                    raise HTTPException(409, "请求编号已用于其他操作")
                return previous["result"]
            preview = await (
                await conn.execute(
                    "SELECT *,expires_at>clock_timestamp() AS valid FROM broker_metadata_previews WHERE owner_id=%s AND id=%s",
                    (who.id, preview_id),
                )
            ).fetchone()
            if (
                not preview
                or not preview["valid"]
                or preview["authorization_binding"] != await self.binding(conn, who)
            ):
                raise HTTPException(409, "账户预览已失效，请重新预览")
            if preview["fingerprint"] != expected or str(preview["request_id"]) != str(data.request_id):
                raise HTTPException(409, "账户预览内容已变化")
            if await self.versions(conn, who.id) != (
                preview["collection_revision"],
                preview["record_collection_revision"],
            ):
                raise HTTPException(409, "账户或持仓目录已变化，请重新预览")
            _before, dependency = await self.dependency(conn, who, kind, identifier, data)
            if dependency != preview["account_dependency"]:
                raise HTTPException(409, "账户引用或来源已变化，请重新预览")
            return await mutate_broker(self.db, who, kind, identifier, data, connection=conn)

    async def legacy_apply(self, who, kind, account_id, data, *, record_collection_revision=None, project=None):
        if kind not in ("create", "update", "delete"):
            raise HTTPException(422, "账户操作无效")
        async with self.context(who) as conn:
            prior = await (await conn.execute("SELECT fingerprint,result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s", (who.id, data.request_id))).fetchone()
            if prior:
                expected = fingerprint({"kind": kind, "account_id": account_id, "body": data.model_dump(mode="json")})
                if prior["result"].get("state") != "closed" and prior["fingerprint"] != expected:
                    raise HTTPException(409, "原操作编号已用于其他操作")
                return prior["result"]
            if kind == "update":
                if type(record_collection_revision) is not int or record_collection_revision < 0:
                    raise HTTPException(422, "记录集合版本无效")
                if (await self.versions(conn, who.id))[1] != record_collection_revision:
                    raise HTTPException(409, "持仓记录已变化，请重新读取")
            return await mutate_broker(self.db, who, kind, account_id, data, connection=conn, project=project)

    async def receipt(self, who, request_id):
        async with self.context(who) as conn:
            row = await (
                await conn.execute(
                    "SELECT result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "回执不存在")
            return row["result"]

    async def close(self, who, request_id):
        async with self.context(who) as conn:
            row = await (
                await conn.execute(
                    "SELECT result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if row:
                return row["result"]
            result = {
                "request_id": str(request_id),
                "kind": "closed",
                "account_id": None,
                "state": "closed",
                "executed": False,
                "error": None,
                "data": None,
                "collection_revision": await broker_collection(conn, who.id),
            }
            await conn.execute(
                "INSERT INTO broker_account_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (who.id, request_id, fingerprint({"closed": str(request_id)}), Jsonb(result)),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'broker.request.closed',%s)",
                (who.id, request_id),
            )
            return result
