"""Bounded source evidence trial and owner attribution; no trade or cash postings.

The trial importer is intentionally not a production/API import permission. Its
expected source identity/hash must come from a separately verified export.
"""

import hashlib
import json
import re
import secrets
from datetime import datetime
from uuid import UUID

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .broker_accounts import broker_account, serialize_brokers
from .fee_plans import fee_limit
from .fee_rules import number
from .security import digest, lock_mutation_identity


def fingerprint(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def trade_fingerprint(row):
    return fingerprint(
        {
            k: row[k]
            for k in (
                "owner_id",
                "record_id",
                "account_id",
                "side",
                "quantity",
                "price",
                "amount",
                "fees",
                "occurred_at",
            )
        }
    )


def identifier(value):
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 200
        or any(ord(c) < 32 or ord(c) == 127 for c in value)
    ):
        raise ValueError("source_identifier_invalid")
    return value


def normalized_snapshot(raw):
    if (
        not isinstance(raw, dict)
        or set(raw) != {"version", "sourceInstance", "sourceOwner", "complete", "orders"}
        or type(raw["version"]) is not int
        or raw["version"] != 1
        or type(raw["complete"]) is not bool
    ):
        raise ValueError("source_snapshot_invalid")
    identifier(raw["sourceInstance"])
    identifier(raw["sourceOwner"])
    if not isinstance(raw["orders"], list) or len(raw["orders"]) > 10000:
        raise ValueError("source_order_scope_invalid")
    seen = set()
    mapped = set()
    for entry in raw["orders"]:
        if not isinstance(entry, dict) or set(entry) != {
            "id",
            "recordId",
            "status",
            "revision",
            "recordRevision",
            "originalBrokerAccountId",
            "brokerAccountId",
            "tradeId",
            "feeAuthority",
            "cashAttribution",
            "input",
        }:
            raise ValueError("source_order_invalid")
        oid = identifier(entry["id"])
        identifier(entry["recordId"])
        if (
            entry["status"] not in ("filled", "pending", "cancelled", "canceled", "expired", "rejected")
            or type(entry["revision"]) is not int
            or entry["revision"] < 1
            or (
                entry["recordRevision"] is not None
                and (type(entry["recordRevision"]) is not int or entry["recordRevision"] < 1)
            )
        ):
            raise ValueError("source_order_version_or_status_invalid")
        if oid in seen:
            raise ValueError("source_order_duplicate")
        seen.add(oid)
        for key in ("originalBrokerAccountId", "brokerAccountId"):
            if entry[key] is not None:
                identifier(entry[key])
        if entry["originalBrokerAccountId"] is None and (
            entry["brokerAccountId"] is not None or entry["tradeId"] is not None
        ):
            raise ValueError("unassigned_original_cannot_be_guessed")
        if entry["tradeId"] is not None:
            if entry["status"] != "filled":
                raise ValueError("nonfilled_order_cannot_map_to_a_fill")
            tid = str(UUID(entry["tradeId"]))
            if tid in mapped or entry["brokerAccountId"] is None:
                raise ValueError("source_trade_mapping_invalid")
            mapped.add(tid)
        if entry["feeAuthority"] not in (
            "legacy_import_zero",
            "unverified_legacy",
            "owner_recorded",
            "broker_reported",
        ):
            raise ValueError("fee_authority_unknown")
        cash = entry["cashAttribution"]
        if (
            not isinstance(cash, dict)
            or set(cash) != {"scope", "brokerAccountId", "currency", "postingId", "alreadyReflected"}
            or cash["scope"] not in ("broker", "unallocated", "unknown")
            or (cash["alreadyReflected"] is not None and type(cash["alreadyReflected"]) is not bool)
        ):
            raise ValueError("source_cash_authority_invalid")
        for key in ("brokerAccountId", "postingId"):
            if cash[key] is not None:
                identifier(cash[key])
        if cash["currency"] is not None and (
            not isinstance(cash["currency"], str) or not re.fullmatch("[A-Z]{3}", cash["currency"])
        ):
            raise ValueError("source_cash_currency_unknown")
        if (
            cash["scope"] == "broker"
            and cash["brokerAccountId"] is None
            or cash["scope"] == "unallocated"
            and cash["brokerAccountId"] is not None
        ):
            raise ValueError("source_cash_attribution_mismatch")
        data = entry["input"]
        if not isinstance(data, dict) or set(data) != {
            "side",
            "quantity",
            "price",
            "amount",
            "fees",
            "currency",
            "settlementCurrency",
            "settlementAmount",
            "occurredAt",
            "market",
            "code",
            "accountKind",
        }:
            raise ValueError("source_input_invalid")
        if (
            data["side"] not in ("buy", "sell", "dividend")
            or data["accountKind"] not in ("real", "simulated", None)
            or data["market"] not in ("US", "HK", "CN", None)
        ):
            raise ValueError("source_identity_invalid")
        if data["code"] is not None:
            identifier(data["code"])
        for key in ("currency", "settlementCurrency"):
            if data[key] is not None and (
                not isinstance(data[key], str) or not re.fullmatch("[A-Z]{3}", data[key])
            ):
                raise ValueError("source_currency_unknown")
        for key in ("quantity", "price", "amount"):
            if data[key] is not None:
                number(data[key])
        if data["fees"] is not None:
            number(data["fees"])
        elif entry["feeAuthority"] != "unverified_legacy":
            raise ValueError("missing_fee_is_not_zero")
        if data["settlementAmount"] is not None:
            number(data["settlementAmount"])
        if data["occurredAt"] is not None:
            when = datetime.fromisoformat(data["occurredAt"])
            if when.tzinfo is None:
                raise ValueError("source_timestamp_timezone_missing")
    return json.loads(json.dumps(raw, default=str))


async def inventory(conn, owner):
    head = await (
        await conn.execute(
            "SELECT h.revision,s.* FROM fee_legacy_inventory_heads h JOIN fee_legacy_inventory_snapshots s ON s.owner_id=h.owner_id AND s.source_digest=h.source_digest WHERE h.owner_id=%s",
            (owner,),
        )
    ).fetchone()
    if not head:
        return {"head": None, "orders": [], "attributions": []}
    from .source_authority import verified_inventory_head
    head = await verified_inventory_head(conn, head)
    orders = await (
        await conn.execute(
            "SELECT * FROM fee_legacy_inventory_orders WHERE owner_id=%s AND source_digest=%s ORDER BY original_order_id",
            (owner, head["source_digest"]),
        )
    ).fetchall()
    attributions = await (
        await conn.execute(
            "SELECT * FROM fee_legacy_attributions WHERE owner_id=%s AND source_digest=%s ORDER BY original_order_id",
            (owner, head["source_digest"]),
        )
    ).fetchall()
    from .financial_mapping import overlay_inventory_mappings
    head, orders = await overlay_inventory_mappings(conn, owner, head, orders)
    from .registered_inventory import overlay_registered_accounts
    head, orders = await overlay_registered_accounts(conn,owner,head,orders)
    return {"head": head, "orders": orders, "attributions": attributions}


class FeeSourceInventory:
    def __init__(self, db):
        self.db = db

    async def lock(self, conn, who):
        await serialize_brokers(conn, who.id)
        await lock_mutation_identity(conn, who, require_admin=False)
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("fee-source:" + who.id,))

    async def import_trial(
        self,
        who,
        raw,
        *,
        request_id,
        expected_database,
        expected_source_owner,
        expected_source_digest,
        expected_revision=0,
    ):
        if self.db.settings.environment != "test":
            raise HTTPException(403, "原账试导入仅允许独立测试库")
        try:
            data = normalized_snapshot(raw)
            request_id = str(UUID(request_id))
            if type(expected_revision) is not int or expected_revision < 0:
                raise ValueError()
            source_hash = fingerprint(data)
            if data["sourceOwner"] != expected_source_owner or source_hash != expected_source_digest:
                raise ValueError("verified_source_identity_or_hash_mismatch")
        except (ValueError, TypeError, KeyError):
            raise HTTPException(422, "须提供完整、精确且独立核对的原账证据") from None
        operation_hash = fingerprint(
            {"kind": "source_inventory", "source": source_hash, "revision": expected_revision}
        )
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            actual = await (await conn.execute("SELECT current_database() AS name")).fetchone()
            if actual["name"] != expected_database or not expected_database.startswith("alcor_test_"):
                raise HTTPException(403, "试导入目标库身份不符")
            old = await (
                await conn.execute(
                    "SELECT * FROM fee_legacy_inventory_receipts WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if old:
                if old["fingerprint"] != operation_hash:
                    raise HTTPException(409, "请求编号已用于其他证据操作")
                return old["result"]
            current = await inventory(conn, who.id)
            head = current["head"]
            if (head["revision"] if head else 0) != expected_revision:
                raise HTTPException(409, "原账清单版本已变化")
            if head and (
                head["source_instance"] != data["sourceInstance"]
                or head["source_owner"] != data["sourceOwner"]
            ):
                raise HTTPException(409, "不能合并不同原账身份")
            for entry in data["orders"]:
                if entry["brokerAccountId"] is not None:
                    await broker_account(conn, who.id, entry["brokerAccountId"])
                if entry["tradeId"] is not None:
                    await self.check_mapping(conn, who, entry)
            await conn.execute(
                "INSERT INTO fee_legacy_inventory_snapshots(owner_id,source_digest,source_instance,source_owner,complete,order_count,payload) VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                (
                    who.id,
                    source_hash,
                    data["sourceInstance"],
                    data["sourceOwner"],
                    data["complete"],
                    len(data["orders"]),
                    Jsonb(data),
                ),
            )
            for entry in data["orders"]:
                await conn.execute(
                    "INSERT INTO fee_legacy_inventory_orders VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                    (
                        who.id,
                        source_hash,
                        entry["id"],
                        entry["recordId"],
                        entry["originalBrokerAccountId"],
                        entry["brokerAccountId"],
                        entry["tradeId"],
                        entry["feeAuthority"],
                        fingerprint(entry["input"]),
                        Jsonb(entry),
                    ),
                )
            revision = expected_revision + 1
            await conn.execute(
                "INSERT INTO fee_legacy_inventory_heads VALUES(%s,%s,%s) ON CONFLICT(owner_id) DO UPDATE SET source_digest=excluded.source_digest,revision=excluded.revision",
                (who.id, source_hash, revision),
            )
            result = {
                "requestId": request_id,
                "kind": "fee_source_inventory",
                "state": "completed",
                "revision": revision,
                "sourceDigest": source_hash,
                "orders": len(data["orders"]),
                "complete": data["complete"],
                "financialApplied": False,
                "ledgerWrites": 0,
                "authority": "isolated_trial_source_evidence",
            }
            await conn.execute(
                "INSERT INTO fee_legacy_inventory_receipts VALUES(%s,%s,%s,%s)",
                (who.id, request_id, operation_hash, Jsonb(result)),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'fees.source_inventory',%s)",
                (who.id, request_id),
            )
            return result

    async def check_mapping(self, conn, who, entry):
        row = await (
            await conn.execute(
                "SELECT * FROM trade_ledger WHERE owner_id=%s AND id=%s", (who.id, entry["tradeId"])
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "原账对应的本人成交不存在")
        record = await (
            await conn.execute(
                "SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s", (who.id, row["record_id"])
            )
        ).fetchone()
        source = entry["input"]
        if (
            row["account_id"] != entry["brokerAccountId"]
            or row["source"] != entry["feeAuthority"]
            or row["account_kind"] != source["accountKind"]
            or record["market"] != source["market"]
            or record["code"] != source["code"]
        ):
            raise HTTPException(409, "原始证券、费用权威或券商归属不匹配")
        for source_key, field in [
            ("quantity", "quantity"),
            ("price", "price"),
            ("amount", "amount"),
            ("fees", "fees"),
            ("settlementAmount", "settlement_amount"),
        ]:
            if source[source_key] is None:
                if row[field] is not None:
                    raise HTTPException(409, "原输入缺失不能替换已知金额")
            elif number(source[source_key]) != row[field]:
                raise HTTPException(409, "原账金额与本人成交不匹配")
        if (
            source["side"] != row["side"]
            or source["currency"] != row["currency"]
            or source["settlementCurrency"] != row["settlement_currency"]
            or source["occurredAt"] is None
            or datetime.fromisoformat(source["occurredAt"]) != row["occurred_at"]
        ):
            raise HTTPException(409, "原始成交口径不匹配")
        cash_source = entry["cashAttribution"]
        if (
            cash_source["scope"] != "broker"
            or cash_source["alreadyReflected"] is not True
            or cash_source["postingId"] is None
            or cash_source["brokerAccountId"] != entry["originalBrokerAccountId"]
            or cash_source["currency"] != row["settlement_currency"]
        ):
            raise HTTPException(409, "须证明原现金已入账且保留成交当时券商归属")
        posting = await (
            await conn.execute(
                "SELECT * FROM cash_ledger_entries WHERE owner_id=%s AND id=%s",
                (who.id, row["cash_entry_id"]),
            )
        ).fetchone()
        if (
            not posting
            or posting["source_trade_id"] != row["id"]
            or posting["account_id"] != row["account_id"]
            or posting["amount"] != row["cash_delta"]
            or posting["account_kind"] != row["account_kind"]
            or posting["currency"] != row["settlement_currency"]
        ):
            raise HTTPException(409, "原始现金归属证据不完整")
        detail = {
            "feeAuthority": entry["feeAuthority"],
            "originalOrderId": entry["id"],
            "sourceInputHash": fingerprint(source),
            "originalBrokerAccountId": entry["originalBrokerAccountId"],
            "mappedBrokerAccountId": entry["brokerAccountId"],
            "sourceCashAttribution": cash_source,
        }
        previous = await (
            await conn.execute(
                "SELECT * FROM trade_fee_import_evidence WHERE owner_id=%s AND trade_id=%s",
                (who.id, row["id"]),
            )
        ).fetchone()
        if previous:
            if previous["input_fingerprint"] != trade_fingerprint(row) or previous["detail"] != detail:
                raise HTTPException(409, "既有原账证据不能覆盖")
        else:
            await conn.execute(
                "INSERT INTO trade_fee_import_evidence VALUES(%s,%s,%s,%s)",
                (who.id, row["id"], trade_fingerprint(row), Jsonb(detail)),
            )

    async def receipt(self, who, request_id):
        async with self.db.connection() as conn:
            row = await (
                await conn.execute(
                    "SELECT result FROM fee_legacy_inventory_receipts WHERE owner_id=%s AND request_id=%s",
                    (who.id, str(UUID(str(request_id)))),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "原请求回执不存在")
            return row["result"]


def attribution_input(raw):
    keys = {
        "requestId",
        "sourceRevision",
        "sourceDigest",
        "orderId",
        "recordId",
        "recordRevision",
        "brokerAccountId",
        "brokerRevision",
        "basis",
    }
    try:
        if not isinstance(raw, dict) or set(raw) != keys:
            raise ValueError()
        value = dict(raw)
        value["requestId"] = str(UUID(raw["requestId"]))
        for key in ("sourceRevision", "recordRevision", "brokerRevision"):
            if type(raw[key]) is not int or raw[key] < 1:
                raise ValueError()
        for key in ("orderId", "recordId", "brokerAccountId"):
            identifier(raw[key])
        if not re.fullmatch("[a-f0-9]{64}", raw["sourceDigest"]):
            raise ValueError()
        basis = raw["basis"]
        if (
            not isinstance(basis, dict)
            or set(basis) != {"documentDigest", "historicalAccountConfirmed", "completeOrderHistoryConfirmed"}
            or not re.fullmatch("[a-f0-9]{64}", basis["documentDigest"])
            or basis["historicalAccountConfirmed"] is not True
            or basis["completeOrderHistoryConfirmed"] is not True
        ):
            raise ValueError()
    except (ValueError, TypeError, KeyError):
        raise HTTPException(422, "须逐笔确认来源材料、历史账户及完整订单范围") from None
    return value


class FeeSourceAttributions(FeeSourceInventory):
    async def listing(self,who,*,limit=100,offset=0,source_revision=None,inventory_revision=None):
        if type(limit) is not int or not 1<=limit<=200 or type(offset) is not int or not 0<=offset<=1000000:
            raise HTTPException(400,'原订单分页无效')
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            await self.lock(conn,who)
            state=await inventory(conn,who.id)
            head=state['head']
            if not head:
                return {'state':'unavailable','sourceRevision':None,'sourceDigest':None,'sourceVerified':False,'orders':[],'accounts':[],'records':[],'pagination':{'offset':0,'limit':limit,'total':None,'nextOffset':None}}
            if offset and source_revision is None or source_revision is not None and source_revision!=head['revision']:
                raise HTTPException(409,'原账证据已变化，请从首批重新读取')
            attributed={row['original_order_id'] for row in state['attributions']}
            candidates=[row for row in state['orders'] if row['original_broker_id'] is None and row['trade_id'] is None and row['original_order_id'] not in attributed]
            revision=fingerprint([head['revision'],head['source_digest'],bool(head.get('sourceVerified')),
                                  [(row['original_order_id'],str(row['request_id'])) for row in state['attributions']]])
            if offset and inventory_revision!=revision:
                raise HTTPException(409,'原订单归属列表已变化，请从首批重新读取')
            page=candidates[offset:offset+limit]
            accounts=await (await conn.execute("SELECT id,name,account_kind,holding_source,revision FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 10001",(who.id,))).fetchall()
            records=await (await conn.execute("SELECT id,name,market,code,broker_account_id,revision FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 10001",(who.id,))).fetchall()
            if len(accounts)>10000 or len(records)>10000:raise HTTPException(409,'本人账户或证券候选超出本次完整核对预算')
            identities={(row['payload']['input']['market'],row['payload']['input']['code']) for row in page}
            projected=[]
            for row in page:
                original=row['payload']
                projected.append({'orderId':row['original_order_id'],'originalRecordId':row['original_record_id'],
                    'input':original['input'],'status':original['status'],'feeAuthority':original.get('feeAuthority'),
                    'sourceInputHash':row['input_hash'],'originalCashAttribution':original['cashAttribution']})
            return {'state':'available' if head.get('sourceVerified') else 'retained_unavailable',
                'inventoryRevision':revision,'sourceRevision':head['revision'],'sourceDigest':head['source_digest'],
                'sourceOwner':head['source_owner'],'sourceInstance':head['source_instance'],
                'sourceVerified':bool(head.get('sourceVerified')),'sourceComplete':bool(head['complete']),
                'orders':projected,'accounts':[{'id':r['id'],'name':r['name'],'accountKind':r['account_kind'],'holdingSource':r['holding_source'],'revision':r['revision']} for r in accounts],
                'records':[{'id':r['id'],'name':r['name'],'market':r['market'],'code':r['code'],'brokerAccountId':r['broker_account_id'],'revision':r['revision']} for r in records if (r['market'],r['code']) in identities],
                'pagination':{'offset':offset,'limit':limit,'total':len(candidates),'nextOffset':offset+len(page) if offset+len(page)<len(candidates) else None},
                'financialApplied':False,'cashEffect':None,'ledgerWrites':0}

    async def check(self, conn, who, data):
        state = await inventory(conn, who.id)
        head = state["head"]
        if head and not head.get("sourceVerified"):
            raise HTTPException(409, "来源授权未生效或已撤销，不能新增原订单归属")
        if (
            not head
            or head["revision"] != data["sourceRevision"]
            or head["source_digest"] != data["sourceDigest"]
        ):
            raise HTTPException(409, "原账证据已变化")
        order = next((r for r in state["orders"] if r["original_order_id"] == data["orderId"]), None)
        if not order:
            raise HTTPException(404, "原始订单不存在")
        if order["original_broker_id"] is not None or order["trade_id"] is not None:
            raise HTTPException(409, "此订单已有原始归属，不允许重新分配")
        if any(r["original_order_id"] == data["orderId"] for r in state["attributions"]):
            raise HTTPException(409, "该原订单已有归属确认，请查询原回执")
        await conn.execute(
            "SELECT id FROM broker_accounts WHERE owner_id=%s AND id=%s FOR SHARE",
            (who.id, data["brokerAccountId"]),
        )
        account = await broker_account(conn, who.id, data["brokerAccountId"])
        record = await (
            await conn.execute(
                "SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s AND deleted_at IS NULL FOR SHARE",
                (who.id, data["recordId"]),
            )
        ).fetchone()
        if not record:
            raise HTTPException(404, "本人记录不存在")
        source = order["payload"]["input"]
        if account["holding_source"] != "manual" or source["accountKind"] is not None and account["account_kind"] != source["accountKind"]:
            raise HTTPException(409, "不能跨官方、真实或模拟来源归账")
        if account["revision"] != data["brokerRevision"] or record["revision"] != data["recordRevision"]:
            raise HTTPException(409, "账户或记录版本已变化")
        if (
            record["market"] != source["market"]
            or record["code"] != source["code"]
            or record["broker_account_id"] not in (None, account["id"])
        ):
            raise HTTPException(409, "证券身份或当前账户不匹配")
        return state, order, account, record

    async def preview(self, who, raw):
        await fee_limit(self.db, who)
        data = attribution_input(raw)
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            state, order, account, record = await self.check(conn, who, data)
            token = secrets.token_urlsafe(32)
            proof = await (
                await conn.execute(
                    "INSERT INTO fee_legacy_attribution_previews(token_hash,owner_id,session_hash,payload_hash,source_revision,broker_revision,record_revision) VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING expires_at",
                    (
                        digest(token),
                        who.id,
                        who.token_hash,
                        fingerprint(data),
                        state["head"]["revision"],
                        account["revision"],
                        record["revision"],
                    ),
                )
            ).fetchone()
            return {
                "preview": token,
                "expiresAt": proof["expires_at"].isoformat(),
                "orderId": data["orderId"],
                "originalBrokerAccountId": None,
                "proposedBrokerAccountId": account["id"],
                "recordId": record["id"],
                "sourceInputHash": order["input_hash"],
                "financialApplied": False,
                "cashEffect": None,
                "ledgerWrites": 0,
                "confirmationAuthority": "owner_asserted_source_documents",
                        "originalAccountKind": order["payload"]["input"]["accountKind"],
                        "targetAccountKind": account["account_kind"],
                        "originalCashAttribution": order["payload"]["cashAttribution"],
                "nextStage": "full_history_financial_import_reconciliation",
            }

    async def submit(self, who, raw, preview):
        await fee_limit(self.db, who)
        data = attribution_input(raw)
        hashed = fingerprint({"kind": "source_attribution", "data": data})
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            old = await (
                await conn.execute(
                    "SELECT * FROM fee_legacy_inventory_receipts WHERE owner_id=%s AND request_id=%s",
                    (who.id, data["requestId"]),
                )
            ).fetchone()
            if old:
                if old["fingerprint"] != hashed:
                    raise HTTPException(409, "请求编号已用于其他证据操作")
                return old["result"]
            try:
                async with conn.transaction():
                    state, order, account, record = await self.check(conn, who, data)
                    proof = await (
                        await conn.execute(
                            "SELECT * FROM fee_legacy_attribution_previews WHERE token_hash=%s AND owner_id=%s AND session_hash=%s AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
                            (digest(preview), who.id, who.token_hash),
                        )
                    ).fetchone()
                    if (
                        not proof
                        or proof["payload_hash"] != fingerprint(data)
                        or (proof["source_revision"], proof["broker_revision"], proof["record_revision"])
                        != (state["head"]["revision"], account["revision"], record["revision"])
                    ):
                        raise HTTPException(409, "归属预览已失效，请重新核对")
                    evidence = {
                        "inputHash": order["input_hash"],
                        "originalBrokerAccountId": None,
                        "confirmationAuthority": "owner_asserted_source_documents",
                        "financialApplied": False,
                        "originalAccountKind": order["payload"]["input"]["accountKind"],
                        "targetAccountKind": account["account_kind"],
                        "originalCashAttribution": order["payload"]["cashAttribution"],
                        "basis": data["basis"],
                        "sourceRevision": state["head"]["revision"],
                        "recordRevision": record["revision"],
                        "brokerRevision": account["revision"],
                    }
                    await conn.execute(
                        "INSERT INTO fee_legacy_attributions(owner_id,source_digest,original_order_id,account_id,record_id,request_id,evidence) VALUES(%s,%s,%s,%s,%s,%s,%s)",
                        (
                            who.id,
                            data["sourceDigest"],
                            data["orderId"],
                            account["id"],
                            record["id"],
                            data["requestId"],
                            Jsonb(evidence),
                        ),
                    )
                    await conn.execute(
                        "UPDATE fee_legacy_attribution_previews SET consumed_at=clock_timestamp() WHERE token_hash=%s",
                        (digest(preview),),
                    )
                    await conn.execute(
                        "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'fees.source_attribution',%s)",
                        (who.id, data["requestId"]),
                    )
                    result = {
                        "requestId": data["requestId"],
                        "kind": "legacy_fee_source_attribution",
                        "state": "completed",
                        "orderId": data["orderId"],
                        "brokerAccountId": account["id"],
                        "recordId": record["id"],
                        "financialApplied": False,
                        "cashEffect": None,
                        "ledgerWrites": 0,
                        "nextStage": "full_history_financial_import_reconciliation",
                    }
            except HTTPException as error:
                result = {
                    "requestId": data["requestId"],
                    "kind": "legacy_fee_source_attribution",
                    "state": "failed",
                    "status": error.status_code,
                    "message": str(error.detail),
                    "financialApplied": False,
                    "ledgerWrites": 0,
                }
            await conn.execute(
                "INSERT INTO fee_legacy_inventory_receipts VALUES(%s,%s,%s,%s)",
                (who.id, data["requestId"], hashed, Jsonb(result)),
            )
            return result
