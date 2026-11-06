"""Atomic account assignment for verified empty records; financial transfers are separate."""

from uuid import UUID, uuid4

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from psycopg.types.json import Jsonb

from .broker_accounts import broker_account
from .broker_metadata import BrokerMetadata, fingerprint
from .portfolio_records import TEXT_LIMITS, PortfolioRecords, normalize, record_dto
from .scope_coverage import record_status


def command(raw):
    if not isinstance(raw, dict) or set(raw) != {
        "kind",
        "accountId",
        "data",
        "expectedCollectionRevision",
        "expectedRecordCollectionRevision",
    }:
        raise HTTPException(422, "归属预览字段无效")
    if (
        raw["kind"] not in ("bind", "unbind")
        or not isinstance(raw["accountId"], str)
        or not 1 <= len(raw["accountId"]) <= 100
    ):
        raise HTTPException(422, "归属操作无效")
    if any(
        type(raw[k]) is not int or raw[k] < 0
        for k in ("expectedCollectionRevision", "expectedRecordCollectionRevision")
    ):
        raise HTTPException(422, "归属目录版本无效")
    data = raw["data"]
    if (
        not isinstance(data, dict)
        or set(data) - {"requestId", "revision", "accountKind", "records", "allowReassign"}
        or not {"requestId", "revision", "accountKind", "records"} <= set(data)
    ):
        raise HTTPException(422, "归属请求字段无效")
    try:
        request_id = str(UUID(data["requestId"]))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, "归属请求编号无效") from None
    if (
        type(data["revision"]) is not int
        or data["revision"] < 1
        or data["accountKind"] not in ("real", "simulated")
        or type(data.get("allowReassign", False)) is not bool
    ):
        raise HTTPException(422, "账户版本或账本类型无效")
    rows = data["records"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= 2000:
        raise HTTPException(422, "请选择1至2000条记录")
    for row in rows:
        if (
            not isinstance(row, dict)
            or set(row) != {"id", "revision"}
            or not isinstance(row["id"], str)
            or not 1 <= len(row["id"]) <= 100
            or type(row["revision"]) is not int
            or row["revision"] < 1
        ):
            raise HTTPException(422, "记录编号或版本无效")
    if len({r["id"] for r in rows}) != len(rows):
        raise HTTPException(422, "记录不能重复")
    return {
        "kind": raw["kind"],
        "accountId": raw["accountId"],
        "data": {
            **data,
            "requestId": request_id,
            "records": sorted(rows, key=lambda r: r["id"]),
            "allowReassign": data.get("allowReassign", False),
        },
        "expectedCollectionRevision": raw["expectedCollectionRevision"],
        "expectedRecordCollectionRevision": raw["expectedRecordCollectionRevision"],
    }


class BrokerBindings(BrokerMetadata):
    def __init__(self, db):
        super().__init__(db)
        self.records = PortfolioRecords(db)

    async def state(self, who):
        async with self.context(who) as conn:
            collection, records = await self.versions(conn, who.id)
            accounts = await (
                await conn.execute(
                    "SELECT id FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL ORDER BY created_at,id LIMIT 101",
                    (who.id,),
                )
            ).fetchall()
            rows = await (
                await conn.execute(
                    "SELECT r.*,c.account_kind AS account_kind_claim FROM portfolio_records r LEFT JOIN broker_record_scope_claims c ON c.owner_id=r.owner_id AND c.record_id=r.id WHERE r.owner_id=%s AND r.deleted_at IS NULL ORDER BY r.id LIMIT 201",
                    (who.id,),
                )
            ).fetchall()
            return jsonable_encoder(
                {
                    "collectionRevision": collection,
                    "recordCollectionRevision": records,
                    "accounts": [await broker_account(conn, who.id, r["id"]) for r in accounts[:100]],
                    "records": [
                        {
                            **record_dto(r),
                            "historyState": r["history_state"],
                            "accountKindClaim": r["account_kind_claim"],
                        }
                        for r in rows[:200]
                    ],
                    "partial": len(rows) > 200 or len(accounts) > 100,
                    "coverageScope": "platform_owned_records",
                    "historicalCoverageKnown": False,
                    "financialTransferSupported": False,
                }
            )

    async def plan(self, conn, who, payload):
        data = payload["data"]
        target = await broker_account(conn, who.id, payload["accountId"])
        if target["revision"] != data["revision"] or target["account_kind"] != data["accountKind"]:
            raise HTTPException(409, "账户版本或账本归属已变化")
        if target["holding_source"] != "manual":
            raise HTTPException(409, "官方来源账户不能手动调整归属")
        plan = []
        for selected in data["records"]:
            old = await self.records.get(conn, who.id, selected["id"])
            if not old or old["revision"] != selected["revision"]:
                raise HTTPException(409, "记录已变化，请重新选择")
            if old.get("position_transfer_id"):
                raise HTTPException(409, "记录已有转仓凭证，请继续使用显式转仓，不能重写原归属")
            if old["history_state"] != "empty" or old["qty"] is not None and old["qty"] != 0:
                raise HTTPException(409, "历史未核对或记录仍有数量，须单独核对转仓")
            if not await record_status(conn, who.id, old["id"]):
                raise HTTPException(409, "原始来源尚未完整核对")
            if payload["kind"] == "unbind" and old["broker_account_id"] != target["id"]:
                raise HTTPException(404, "记录不属于当前账户")
            if payload["kind"] == "bind":
                if old["broker_account_id"] == target["id"]:
                    raise HTTPException(409, "记录已属于当前账户")
                if old["broker_account_id"] and not data["allowReassign"]:
                    raise HTTPException(409, "已有账户归属，须明确确认调整")
            patch = {
                "brokerAccountId": target["id"] if payload["kind"] == "bind" else "",
                "group": target["name"] if payload["kind"] == "bind" else "",
            }
            before = record_dto(old)
            # A binding changes only ownership metadata. Feed the shared record
            # normalizer the locked original values, including unknown amounts.
            original = {key: before[key] for key in (*TEXT_LIMITS, "price", "cost", "qty")}
            normalized = normalize({**original, **patch}, old)
            if any(normalized[k] != before[k] for k in normalized if k not in ("brokerAccountId", "group")):
                raise HTTPException(409, "证券身份或其他字段须先核对，不能随归属改写")
            dependencies = await self.records.check(conn, who.id, "update", old, normalized)
            before_account_name = None
            if old["broker_account_id"]:
                before_account_name = (
                    target["name"]
                    if old["broker_account_id"] == target["id"]
                    else (await broker_account(conn, who.id, old["broker_account_id"]))["name"]
                )
            plan.append(
                {
                    "recordId": old["id"],
                    "revision": old["revision"],
                    "beforeAccountId": old["broker_account_id"],
                    "beforeGroup": old["group_name"],
                    "beforeAccountName": before_account_name,
                    "data": normalized,
                    "dependencies": dependencies,
                }
            )
        if payload["kind"] == "bind":
            ids = [r["recordId"] for r in plan]
            existing = await (
                await conn.execute(
                    "SELECT market,code,account_market FROM portfolio_records WHERE owner_id=%s AND broker_account_id=%s AND deleted_at IS NULL AND NOT(id=ANY(%s))",
                    (who.id, target["id"], ids),
                )
            ).fetchall()
            keys = {(r["market"], r["code"], r["account_market"] or r["market"]) for r in existing}
            for row in plan:
                value = row["data"]
                key = (value["market"], value["code"], value["accountMarket"] or value["market"])
                if key in keys:
                    raise HTTPException(409, "同一账户已有重复证券，请先核对")
                keys.add(key)
        return plan

    async def preview(self, who, raw, *, connection=None):
        payload = command(raw)
        async with self.context(who, connection=connection) as conn:
            versions = await self.versions(conn, who.id)
            if versions != (
                payload["expectedCollectionRevision"],
                payload["expectedRecordCollectionRevision"],
            ):
                raise HTTPException(409, "账户或记录目录已变化")
            previous = await (
                await conn.execute(
                    "SELECT 1 FROM broker_account_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, payload["data"]["requestId"]),
                )
            ).fetchone()
            if previous:
                raise HTTPException(409, "请求已有结果，请查询原编号")
            plan = await self.plan(conn, who, payload)
            identifier = uuid4()
            row = await (
                await conn.execute(
                    "INSERT INTO broker_binding_previews(owner_id,id,request_id,kind,account_id,account_kind,payload,fingerprint,authorization_binding,collection_revision,record_collection_revision,plan,plan_fingerprint) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING expires_at",
                    (
                        who.id,
                        identifier,
                        payload["data"]["requestId"],
                        payload["kind"],
                        payload["accountId"],
                        payload["data"]["accountKind"],
                        Jsonb(payload),
                        fingerprint(payload),
                        await self.binding(conn, who),
                        *versions,
                        Jsonb(plan),
                        fingerprint(plan),
                    ),
                )
            ).fetchone()
            return jsonable_encoder(
                {
                    "previewId": str(identifier),
                    "requestId": payload["data"]["requestId"],
                    "kind": payload["kind"],
                    "accountId": payload["accountId"],
                    "accountKind": payload["data"]["accountKind"],
                    "records": plan,
                    "expiresAt": row["expires_at"],
                    "financialTransfer": False,
                }
            )

    async def submit(self, who, raw, *, connection=None, project=None, legacy_request_hash=None):
        if not isinstance(raw, dict) or set(raw) != {"previewId", "command"}:
            raise HTTPException(422, "归属确认字段无效")
        payload = command(raw["command"])
        request_id = payload["data"]["requestId"]
        expected = fingerprint(payload)
        try:
            identifier = UUID(raw["previewId"])
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, "归属预览编号无效") from None
        async with self.context(who, connection=connection) as conn:
            previous = await (
                await conn.execute(
                    "SELECT fingerprint,result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
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
                    "SELECT *,expires_at>clock_timestamp() AS valid FROM broker_binding_previews WHERE owner_id=%s AND id=%s",
                    (who.id, identifier),
                )
            ).fetchone()
            if (
                not preview
                or not preview["valid"]
                or preview["authorization_binding"] != await self.binding(conn, who)
            ):
                raise HTTPException(409, "归属预览已失效")
            if preview["fingerprint"] != expected or str(preview["request_id"]) != request_id:
                raise HTTPException(409, "归属预览内容已变化")
            if await self.versions(conn, who.id) != (
                preview["collection_revision"],
                preview["record_collection_revision"],
            ):
                raise HTTPException(409, "账户或记录目录已变化")
            plan = await self.plan(conn, who, payload)
            if fingerprint(plan) != preview["plan_fingerprint"]:
                raise HTTPException(409, "来源或归属已变化，请重新预览")
            for selected in plan:
                old = await self.records.get(conn, who.id, selected["recordId"])
                await self.records.apply_metadata_on_connection(
                    conn, who.id, selected["recordId"], old, selected["data"]
                )
            await conn.execute(
                "UPDATE broker_accounts SET revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s",
                (who.id, payload["accountId"]),
            )
            await conn.execute(
                "INSERT INTO broker_account_collections(owner_id,revision) VALUES(%s,1) ON CONFLICT(owner_id) DO UPDATE SET revision=broker_account_collections.revision+1",
                (who.id,),
            )
            current, records = await self.versions(conn, who.id)
            result = {
                "request_id": request_id,
                "kind": payload["kind"],
                "account_id": payload["accountId"],
                "state": "completed",
                "error": None,
                "data": {
                    "recordIds": [r["recordId"] for r in plan],
                    "accountKind": payload["data"]["accountKind"],
                    "financialTransfer": False,
                },
                "collection_revision": current,
                "record_collection_revision": records,
            }
            if legacy_request_hash is not None:
                result["legacy_request_hash"] = legacy_request_hash
            if project is not None:
                result["legacy_snapshot"] = jsonable_encoder(await project(conn, who.id, payload["accountId"]))
            await conn.execute(
                "INSERT INTO broker_account_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (who.id, request_id, expected, Jsonb(result)),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
                (who.id, "broker." + payload["kind"], payload["accountId"], request_id),
            )
            return result

    async def legacy_apply(self, who, kind, account_id, data, *, record_collection_revision, project=None):
        if (kind not in ("bind", "unbind") or not isinstance(data, dict)
                or set(data) - {"requestId", "revision", "recordIds", "allowReassign"}
                or not {"requestId", "revision", "recordIds"} <= set(data)):
            raise HTTPException(422, "归属操作无效")
        ids = data.get("recordIds")
        if (not isinstance(ids, list) or not 1 <= len(ids) <= 2000 or any(not isinstance(x, str) or not 1 <= len(x) <= 100 for x in ids)
                or len(set(ids)) != len(ids) or type(record_collection_revision) is not int or record_collection_revision < 0):
            raise HTTPException(422, "记录选择或集合版本无效")
        legacy_hash = fingerprint({"kind": kind, "accountId": account_id, "data": data, "recordCollectionRevision": record_collection_revision})
        try:
            original_request = UUID(data.get("requestId"))
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, "原操作编号无效") from None
        async with self.context(who) as conn:
            previous = await (await conn.execute("SELECT result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s", (who.id, original_request))).fetchone()
            if previous:
                if previous["result"].get("state") != "closed" and previous["result"].get("legacy_request_hash") != legacy_hash:
                    raise HTTPException(409, "原操作编号已用于其他请求，请查询原回执")
                return previous["result"]
            account = await broker_account(conn, who.id, account_id)
            if account["account_kind"] not in ("real", "simulated"):
                raise HTTPException(409, "账本类型尚未核实，不能推断记录归属")
            versions = await self.versions(conn, who.id)
            if versions[1] != record_collection_revision:
                raise HTTPException(409, "持仓记录已变化，请重新读取")
            rows = await (await conn.execute("SELECT id,revision FROM portfolio_records WHERE owner_id=%s AND id=ANY(%s) AND deleted_at IS NULL ORDER BY id FOR UPDATE", (who.id, ids))).fetchall()
            if len(rows) != len(ids):
                raise HTTPException(404, "本人记录不存在或已移除")
            payload = command({"kind": kind, "accountId": account_id, "data": {
                "requestId": data.get("requestId"), "revision": data.get("revision"), "accountKind": account["account_kind"],
                "records": rows, "allowReassign": data.get("allowReassign", False)},
                "expectedCollectionRevision": versions[0], "expectedRecordCollectionRevision": record_collection_revision})
            prior = await (await conn.execute("SELECT fingerprint,result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s", (who.id, payload["data"]["requestId"]))).fetchone()
            if prior:
                if prior["result"].get("state") != "closed" and prior["fingerprint"] != fingerprint(payload):
                    raise HTTPException(409, "原编号已有不同请求，请查询原回执")
                return prior["result"]
            preview = await self.preview(who, payload, connection=conn)
            return await self.submit(who, {"previewId": preview["previewId"], "command": payload}, connection=conn, project=project, legacy_request_hash=legacy_hash)


async def purge_broker_binding_previews(conn, owner):
    installed = (
        await (
            await conn.execute(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name='0092_broker_record_bindings.sql') AS installed"
            )
        ).fetchone()
    )["installed"]
    if not installed:
        present = await (
            await conn.execute("SELECT to_regclass('public.broker_binding_previews') AS relation")
        ).fetchone()
        if present["relation"] is None:
            return
        raise HTTPException(503, "记录归属结构尚未完整核对")
    await conn.execute("DELETE FROM broker_binding_previews WHERE owner_id=%s", (owner,))
