"""Append-only historical fee correction candidate; original fills and postings survive."""

import hashlib
import json
import re
import secrets
from datetime import UTC, datetime
from decimal import Decimal, localcontext
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg import Error as PostgreSQLError
from psycopg.types.json import Jsonb

from .broker_accounts import broker_account
from .fee_plans import fee_limit
from .fee_repair_model import candidate, effective_trades, eligibility, replay
from .fee_rules import VERSION, plan
from .fee_source_inventory import inventory, trade_fingerprint
from .security import digest
from .trade_accounting import apply_filled_trade, replay_economic_trades
from .trading import Trading


def hashed(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def json_value(value):
    return json.loads(json.dumps(value, default=str))


def parse(raw):
    keys = {
        "requestId",
        "accountId",
        "brokerAccountId",
        "providerId",
        "brokerRevision",
        "snapshotRevision",
        "ruleVersion",
        "plan",
        "orders",
    }
    if not isinstance(raw, dict) or set(raw) != keys:
        raise HTTPException(422, "历史费用参数无效")
    data = dict(raw)
    try:
        data["requestId"] = str(UUID(raw["requestId"]))
        if (
            not isinstance(data["accountId"], str)
            or not isinstance(data["brokerAccountId"], str)
            or not re.fullmatch(r"ba-[a-f0-9]{24}", data["brokerAccountId"])
        ):
            raise ValueError()
        if data["ruleVersion"] != VERSION or data["providerId"] not in ("longbridge", "huatai"):
            raise ValueError()
        if type(data["brokerRevision"]) is not int or data["brokerRevision"] < 1:
            raise ValueError()
        if not isinstance(data["snapshotRevision"], str) or not re.fullmatch(
            r"[a-f0-9]{64}", data["snapshotRevision"]
        ):
            raise ValueError()
        data["plan"] = plan(data["plan"], data["providerId"])
        if not isinstance(data["orders"], list) or not 1 <= len(data["orders"]) <= 500:
            raise ValueError()
        ids = set()
        for selection in data["orders"]:
            if not isinstance(selection, dict) or set(selection) - {
                "orderId",
                "revision",
                "recordRevision",
                "instrumentKind",
                "wholeOrderConfirmed",
                "brokerOwnershipConfirmed",
                "legacyImportConfirmed",
            }:
                raise ValueError()
            identifier = selection["orderId"]
            if (
                not isinstance(identifier, str)
                or not 1 <= len(identifier) <= 200
                or any(ord(c) < 32 or ord(c) == 127 for c in identifier)
            ):
                raise ValueError()
            if (
                identifier in ids
                or type(selection["revision"]) is not int
                or selection["revision"] < 1
                or type(selection["recordRevision"]) is not int
                or selection["recordRevision"] < 1
            ):
                raise ValueError()
            ids.add(identifier)
            if (
                selection["instrumentKind"] not in ("us_domestic_equity", "us_etf", "cn_a_equity", "unknown")
                or type(selection["wholeOrderConfirmed"]) is not bool
                or type(selection["brokerOwnershipConfirmed"]) is not bool
            ):
                raise ValueError()
            if "legacyImportConfirmed" in selection and selection["legacyImportConfirmed"] is not True:
                raise ValueError()
        data["orders"] = sorted(data["orders"], key=lambda x: x["orderId"])
    except (ValueError, KeyError, TypeError):
        raise HTTPException(422, "须明确逐笔归属、期间及核对结果") from None
    return data


class FeeRepairs:
    parse_command = staticmethod(parse)
    operation_kind = 'historical_fee_repair'
    operation_source = 'owner_reconstructed'
    audit_action = 'fees.repair'
    cash_note = 'Historical fee reconstruction'
    failure_message = '费用更正未完成，请查询原UUID回执'

    def correction_detail(self,item,data):
        return {**item,'plan':data['plan'],'ruleVersion':VERSION}

    async def before_post(self,conn,who,data,state,value):
        pass

    async def decorate_failure(self,conn,who,data,result):
        return result

    def completed_result(self,data,value,revision):
        return {'requestId':data['requestId'],'state':'completed','kind':self.operation_kind,
                'source':self.operation_source,'data':value,'cashRevision':revision+1}

    async def consume_budget(self,who):
        await fee_limit(self.db,who)

    def __init__(self, db):
        self.db = db
        self.trading = Trading(db)

    async def state(self, conn, who, account_id):
        account = await broker_account(conn, who.id, account_id)

        async def rows(table, order):
            return await (
                await conn.execute(
                    f"SELECT * FROM {table} WHERE owner_id=%s ORDER BY {order} LIMIT 10001", (who.id,)
                )
            ).fetchall()

        fills = await rows("trade_ledger", "id")
        from .trade_amendment_history import attach_amendments
        await attach_amendments(conn,who.id,fills)
        from .actual_projection import pending_fee_rows
        pending={row['id']:row['calculated'] for row in await pending_fee_rows(conn,who.id)}
        for row in fills:
            row['actual_fee_pending']=row['id'] in pending
            row['calculated_fee_pending']=pending.get(row['id'],False)
        records = await rows("portfolio_records", "id")
        from .position_transfer_checkpoint import attach_openings
        await attach_openings(conn,who.id,records)
        if len(fills) > 10000 or len(records) > 10000:
            raise HTTPException(409, "完整历史超出本次范围")
        corrections = await rows("trade_fee_corrections", "id")
        from .actual_projection import confirmed_actual_fees
        actual_confirmations = await confirmed_actual_fees(conn,who.id)
        projections = await rows("trade_fee_projections", "id")
        evidence = await rows("trade_fee_import_evidence", "trade_id")
        cash = await rows("cash_ledger_entries", "id")
        openings = await rows("cash_ledger_accounts", "account_id,currency")
        if any(len(values) > 10000 for values in (corrections, projections, evidence, cash, openings)):
            raise HTTPException(409, "完整证据或现金范围超限")
        revision = await (
            await conn.execute("SELECT revision FROM cash_ledger_collections WHERE owner_id=%s", (who.id,))
        ).fetchone()
        collection = await (
            await conn.execute(
                "SELECT revision FROM portfolio_record_collections WHERE owner_id=%s", (who.id,)
            )
        ).fetchone()
        source_inventory = await inventory(conn, who.id)
        state = {
            "sourceInventory": source_inventory,
            "collectionRevision": collection["revision"] if collection else 0,
            "account": account,
            "fills": fills,
            "records": records,
            "corrections": corrections,
            "actualConfirmations": actual_confirmations,
            "projections": projections,
            "evidence": evidence,
            "cash": cash,
            "openings": openings,
            "cashRevision": revision["revision"] if revision else 0,
        }
        state["snapshotRevision"] = hashed(state)
        return state

    async def snapshot(self, who, account_id):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            state = await self.state(conn, who, account_id)
        records = {r["id"]: r for r in state["records"]}
        account = state["account"]
        evidence = {r["trade_id"]: r for r in state["evidence"]}
        corrected = {r["trade_id"] for r in state["corrections"]}
        actual_confirmed={r["trade_id"]:r for r in state["actualConfirmations"]}
        effective_fees = {r["trade_id"]: r["new_fees"] for r in state["corrections"]}
        currency = (
            "USD"
            if account["provider_id"] == "longbridge"
            else "CNY"
            if account["provider_id"] == "huatai"
            else None
        )
        checkpoints = [
            o["opening_at"]
            for o in state["openings"]
            if o["currency"] == currency and o["opening_basis"] == "allocate_verified_unallocated_checkpoint"
        ]
        items = []
        for row in state["fills"]:
            if row["account_id"] != account_id or row["record_id"] not in records:
                continue
            record = records[row["record_id"]]
            proof = evidence.get(row["id"])
            exclusion = eligibility(
                row,
                record,
                account,
                {
                    "legacyImportConfirmed": True,
                    "wholeOrderConfirmed": True,
                    "brokerOwnershipConfirmed": True,
                },
                proof,
                row["id"] in corrected,
                max(checkpoints) if checkpoints else None,
            )
            items.append(
                {
                    "orderId": str(row["id"]),
                    "recordId": row["record_id"],
                    "market": record["market"],
                    "code": record["code"],
                    "side": row["side"],
                    "status": "filled",
                    "qty": str(row["quantity"]),
                    "price": str(row["price"]),
                    "amount": str(row["amount"]),
                    "fees": None if row["actual_fee_pending"] else str(actual_confirmed[row["id"]]["actual_fee"] if row["id"] in actual_confirmed else row["fees"]),
                    "registeredFees":str(row["fees"]),
                    "actualFeeKnown":not row["actual_fee_pending"],
                    "feeAuthority":None if row["actual_fee_pending"] else "owner_recorded" if row["id"] in actual_confirmed else row["source"] if row["source"] in ("owner_recorded","broker_reported") else None,
                    "feeSource":"rule_calculated" if row["calculated_fee_pending"] else None,
                    "estimatedFees":str(row["fees"]) if row["calculated_fee_pending"] else str(effective_fees[row["id"]]) if row["id"] in effective_fees and row["id"] not in actual_confirmed else None,
                    "originalFees": str(row["fees"]),
                    "tradedAt": row["occurred_at"].isoformat(),
                    "source": row["source"],
                    "revision": 1,
                    "recordRevision": record["revision"],
                    "exclusion": exclusion,
                    "importProof": "verified_input"
                    if proof and proof["detail"].get("feeAuthority") == "legacy_import_zero"
                    else "unavailable",
                    "manualReviewRequired": not exclusion
                    and bool(proof and proof["detail"].get("feeAuthority") == "unverified_legacy"),
                }
            )
        source = state["sourceInventory"]
        head = source["head"]
        originals = source["orders"]
        mapped = {row["trade_id"] for row in originals if row["trade_id"] is not None}
        legacy_fills = [
            row
            for row in state["fills"]
            if row["source"] in ("legacy_import_zero", "unverified_legacy", "broker_reported")
        ]
        unmapped = [
            row["original_order_id"]
            for row in originals
            if row["original_broker_id"] is not None
            and row["trade_id"] is None
            and row["payload"]["status"] == "filled"
        ]
        complete = bool(
            head and head["complete"] and not unmapped and all(row["id"] in mapped for row in legacy_fills)
        )
        coverage = {
            "status": "complete" if complete else "partial" if head else "unavailable",
            "revision": head["revision"] if head else None,
            "sourceDigest": head["source_digest"] if head else None,
            "sourceOwner": head["source_owner"] if head else None,
            "sourceInstance": head["source_instance"] if head else None,
            "unmappedOrderIds": unmapped if head else None,
            "authority": "authorized_source_manifest_canonical_mapping" if head and head.get("mappingRevision") else "isolated_trial_source_evidence" if head else "unavailable",
            "newFinancialAuthorized": head.get("newFinancialAuthorized", head.get("sourceVerified", False)) if head else False,
            "mappingRevision": head.get("mappingRevision") if head else None,
        }
        source_only = []
        for row in originals:
            if (
                row["mapped_broker_id"] != account_id
                or row["trade_id"] is not None
                or row["payload"]["status"] == "filled"
            ):
                continue
            raw = row["payload"]
            data = raw["input"]
            source_only.append(
                {
                    "orderId": row["original_order_id"],
                    "recordId": row["original_record_id"],
                    "market": data["market"],
                    "code": data["code"],
                    "side": data["side"],
                    "status": raw["status"],
                    "qty": None if data["quantity"] is None else str(data["quantity"]),
                    "price": None if data["price"] is None else str(data["price"]),
                    "amount": None if data["amount"] is None else str(data["amount"]),
                    "fees": None if data["fees"] is None else str(data["fees"]),
                    "tradedAt": data["occurredAt"],
                    "revision": raw["revision"],
                    "recordRevision": raw["recordRevision"],
                    "exclusion": "not_filled_equity_trade",
                    "importProof": "unavailable",
                    "manualReviewRequired": False,
                    "source": "original_inventory_nonfill",
                }
            )
        items.extend(source_only)
        attributions = [
            {
                "orderId": row["original_order_id"],
                "brokerAccountId": row["account_id"],
                "recordId": row["record_id"],
                "requestId": str(row["request_id"]),
                "financialApplied": False,
            }
            for row in source["attributions"]
        ]
        unassigned = [
            {
                "orderId": row["original_order_id"],
                "recordId": row["original_record_id"],
                "input": row["payload"]["input"],
                "feeAuthority": row["fee_authority"],
                "cashAttribution": row["payload"]["cashAttribution"],
                "inputHash": row["input_hash"],
                "originalBrokerAccountId": None,
                "financialApplied": False,
            }
            for row in originals
            if row["original_broker_id"] is None
        ]
        return {
            "unassignedOrders": unassigned if head else None,
            "legacyCoverage": coverage,
            "sourceAttributions": attributions,
            "version": 1,
            "accountId": who.id,
            "brokerAccountId": account_id,
            "providerId": account["provider_id"],
            "brokerRevision": account["revision"],
            "snapshotRevision": state["snapshotRevision"],
            "globalCashRevision": state["cashRevision"],
            "collectionRevision": state["collectionRevision"],
            "asOf": datetime.now(UTC).isoformat(),
            "ruleVersion": VERSION,
            "ordersComplete": complete,
            "automaticZeroFeeRepair": False,
            "items": items,
            "unassignedOrderIds": [
                row["original_order_id"] for row in originals if row["original_broker_id"] is None
            ]
            if head
            else None,
            "supportedProviders": ["longbridge", "huatai"],
        }

    async def calculate(self, conn, who, data):
        if data["accountId"] != who.id:
            raise HTTPException(404, "本人账户不存在")
        state = await self.state(conn, who, data["brokerAccountId"])
        source_head = state["sourceInventory"]["head"]
        if source_head and source_head.get("mappingRevision") and not source_head.get("newFinancialAuthorized"):
            raise HTTPException(409, "来源授权已撤销；原映射仍可核对，不能开始新的费用更正")
        account = state["account"]
        if account["account_kind"] not in ("real", "simulated"):
            raise HTTPException(409, "账户真实或模拟身份未知")
        if account["holding_source"] != "manual":
            raise HTTPException(409, "官方费用只读")
        if (
            account["provider_id"] != data["providerId"]
            or account["revision"] != data["brokerRevision"]
            or state["snapshotRevision"] != data["snapshotRevision"]
        ):
            raise HTTPException(409, "账户、订单或资金已变化")
        records = {r["id"]: r for r in state["records"]}
        fills = {str(r["id"]): r for r in state["fills"]}
        actual_ids={row["trade_id"] for row in state["actualConfirmations"]}
        if any(fills.get(item["orderId"],{}).get("source") in ("legacy_import_zero","unverified_legacy") and fills[item["orderId"]]["fees"]==0 and fills[item["orderId"]]["id"] not in actual_ids for item in data["orders"]):
            raise HTTPException(409, "历史登记0的实付费用未知；须明确作费率估算，不能写作实际费用")
        corrections = {r["trade_id"]: r["new_fees"] for r in state["corrections"]}
        evidence = {r["trade_id"]: r for r in state["evidence"]}
        candidates = []
        excluded = []
        effects = []
        currency = "USD" if account["provider_id"] == "longbridge" else "CNY"
        from .scope_coverage import require_scope
        # Pure exclusions do not spend money. Funding gates apply only when
        # there are real posting candidates below.
        checkpoints = [
            o["opening_at"]
            for o in state["openings"]
            if o["currency"] == currency and o["opening_basis"] == "allocate_verified_unallocated_checkpoint"
        ]
        for selection in data["orders"]:
            row = fills.get(selection["orderId"])
            record = records.get(row["record_id"]) if row else None
            if row is None:
                original = next(
                    (
                        item
                        for item in state["sourceInventory"]["orders"]
                        if item["original_order_id"] == selection["orderId"]
                        and item["mapped_broker_id"] == account["id"]
                        and item["trade_id"] is None
                        and item["payload"]["status"] != "filled"
                    ),
                    None,
                )
                if original:
                    if (
                        original["payload"]["revision"] != selection["revision"]
                        or original["payload"]["recordRevision"] != selection["recordRevision"]
                    ):
                        raise HTTPException(409, "原订单或原记录版本已变化")
                    excluded.append({"orderId": selection["orderId"], "reason": "not_filled_equity_trade"})
                    continue
            if not row or not record or row["account_id"] != account["id"]:
                raise HTTPException(404, "本人券商订单不存在")
            if selection["revision"] != 1:
                raise HTTPException(409, "本人成交版本已变化")
            if record["revision"] != selection["recordRevision"]:
                raise HTTPException(409, "记录已变化")
            proof = evidence.get(row["id"])
            reason = eligibility(
                row,
                record,
                account,
                selection,
                proof,
                row["id"] in corrections,
                max(checkpoints) if checkpoints else None,
            )
            if not reason and proof and proof["input_fingerprint"] != trade_fingerprint(row):
                reason = "import_proof_changed"
            source_row = next(
                (item for item in state["sourceInventory"]["orders"] if item["trade_id"] == row["id"]), None
            )
            if not reason and (not source_row or source_row["payload"]["input"]["fees"] is None):
                reason = "original_fee_unknown_requires_reconciliation"
            if not reason:
                reason, value = candidate(row, record, account, selection, data["plan"])
            if reason:
                excluded.append({"orderId": str(row["id"]), "reason": reason})
            else:
                candidates.append(value)
        source = state["sourceInventory"]
        head = source["head"]
        mapped = {row["trade_id"] for row in source["orders"] if row["trade_id"] is not None}
        full = bool(
            head
            and head["complete"]
            and all(
                row["id"] in mapped
                for row in state["fills"]
                if row["source"] in ("legacy_import_zero", "unverified_legacy", "broker_reported")
            )
            and not any(
                row["original_broker_id"] is not None
                and row["trade_id"] is None
                and row["payload"]["status"] == "filled"
                for row in source["orders"]
            )
        )
        if candidates and not full:
            raise HTTPException(409, "须先核对完整原账清单及成交映射")
        for record_id in {c["recordId"] for c in candidates}:
            record = records[record_id]
            history = [r for r in state["fills"] if r["record_id"] == record_id]
            projected = [p for p in state["projections"] if p["record_id"] == record_id]
            if any(row.get('calculated_fee_pending') for row in history):
                rejected=[c for c in candidates if c['recordId']==record_id]
                excluded.extend({'orderId':c['orderId'],'reason':'independent_actual_fee_confirmation_required'} for c in rejected)
                candidates=[c for c in candidates if c['recordId']!=record_id];continue
            try:
                initial, events = replay(history, record, corrections, projected)
                proposed = {
                    **corrections,
                    **{
                        UUID(c["orderId"]): Decimal(c["newFees"])
                        for c in candidates
                        if c["recordId"] == record_id
                    },
                }
                from .position_transfer_checkpoint import current_rows, economic_initial
                current_history = current_rows(history,record)
                new_events = effective_trades(current_history,proposed)
                position = initial
                for event in new_events:
                    position = apply_filled_trade(position, event).position
                economic_opening = economic_initial(record,initial)
                before = replay_economic_trades(economic_opening, events)
                after = replay_economic_trades(economic_opening, new_events)
                before_unknown = any(
                    r["source"] in ("legacy_import_zero", "unverified_legacy")
                    and r["fees"] == 0
                    and r["id"] not in corrections
                    for r in history
                )
                after_unknown = any(
                    r["source"] in ("legacy_import_zero", "unverified_legacy")
                    and r["fees"] == 0
                    and r["id"] not in proposed
                    for r in history
                )
                effects.append(
                    {
                        "recordId": record_id,
                        "quantity": str(position.quantity),
                        "beforeCost": None if record["cost"] is None else str(record["cost"]),
                        "afterCost": None if position.cost is None else str(position.cost),
                        "beforeRealizedPnl": None
                        if before_unknown or before.realized_pnl is None
                        else str(before.realized_pnl),
                        "afterRealizedPnl": None
                        if after_unknown or after.realized_pnl is None
                        else str(after.realized_pnl),
                    }
                )
            except ValueError:
                rejected = [c for c in candidates if c["recordId"] == record_id]
                excluded.extend(
                    {"orderId": c["orderId"], "reason": "position_history_requires_reconciliation"}
                    for c in rejected
                )
                candidates = [c for c in candidates if c["recordId"] != record_id]
        openings = [
            o for o in state["openings"] if o["account_id"] == account["id"] and o["currency"] == currency
        ]
        if candidates:
            await require_scope(conn,who.id,account["account_kind"],currency)
        if candidates and not openings:
            raise HTTPException(409, "现金期初来源未知")
        with localcontext() as context:
            context.prec = 80
            delta = -sum((Decimal(c["feeDelta"]) for c in candidates), Decimal(0))
            owner_cash = sum(
                (
                    r["amount"]
                    for r in state["cash"]
                    if r["currency"] == currency
                    and r["account_kind"] == account["account_kind"]
                    and r["affects_owner"]
                ),
                Decimal(0),
            )
            broker_cash = sum(
                (
                    r["amount"]
                    for r in state["cash"]
                    if r["currency"] == currency and r["account_id"] == account["id"]
                ),
                Decimal(0),
            )
        from .scope_coverage import scope_status
        owner_complete=await scope_status(conn,who.id,account["account_kind"],currency)
        from .actual_projection import actual_cash_known
        owner_complete=owner_complete and await actual_cash_known(conn,who.id,account["account_kind"],currency)
        broker_complete=await actual_cash_known(conn,who.id,account["account_kind"],currency,account["id"])
        value = {
            "sourceAccount": {
                "id": account["id"],
                "name": account["name"],
                "providerId": account["provider_id"],
                "source": account["holding_source"],
                "accountKind": account["account_kind"],
            },
            "version": 1,
            "accountId": who.id,
            "brokerAccountId": account["id"],
            "providerId": account["provider_id"],
            "ruleVersion": VERSION,
            "snapshotRevision": state["snapshotRevision"],
            "globalCashRevision": state["cashRevision"],
            "collectionRevision": state["collectionRevision"],
            "candidates": candidates,
            "excluded": excluded,
            "unselectedOrderIds": [
                str(r["id"])
                for r in state["fills"]
                if r["account_id"] == account["id"]
                and str(r["id"]) not in {s["orderId"] for s in data["orders"]}
            ]
            + [
                r["original_order_id"]
                for r in state["sourceInventory"]["orders"]
                if r["mapped_broker_id"] == account["id"]
                and r["trade_id"] is None
                and r["payload"]["status"] != "filled"
            ],
            "positionEffects": effects,
            "cashEffect": {
                "currency": currency,
                "before": str(owner_cash) if openings and owner_complete else None,
                "after": str(owner_cash + delta) if openings and owner_complete else None,
                "delta": str(delta),
                "brokerBefore": str(broker_cash) if openings and broker_complete else None,
                "brokerAfter": str(broker_cash + delta) if openings and broker_complete else None,
                "brokerDelta": str(delta),
                "unallocatedDelta": "0",
                "externalFlow": "0",
            },
            "canSubmit": bool(candidates),
            "automaticZeroFeeRepair": False,
        }
        return state, value

    async def preview(self, who, raw):
        await self.consume_budget(who)
        data = self.parse_command(raw)
        async with self.db.connection() as conn, conn.transaction():
            await self.trading.lock(conn, who)
            state, value = await self.calculate(conn, who, data)
            token = secrets.token_urlsafe(32)
            expires = await (
                await conn.execute(
                    "INSERT INTO trade_fee_previews(token_hash,owner_id,session_hash,payload_hash,snapshot_hash) VALUES(%s,%s,%s,%s,%s) RETURNING expires_at",
                    (digest(token), who.id, who.token_hash, hashed(data), state["snapshotRevision"]),
                )
            ).fetchone()
            return {**value, "previewRevision": token, "expiresAt": expires["expires_at"].isoformat()}

    async def submit(self, who, raw, preview):
        await self.consume_budget(who)
        data = self.parse_command(raw)
        fingerprint = hashed(data)
        async with self.db.connection() as conn, conn.transaction():
            revision = await self.trading.lock(conn, who)
            prior = await (
                await conn.execute(
                    "SELECT * FROM trade_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, data["requestId"]),
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise HTTPException(409, "请求编号已用于其他操作")
                return prior["result"]
            try:
                async with conn.transaction():
                    result = await self.commit(conn, who, data, fingerprint, revision, preview)
                    # Prove all deferred attribution/cash/projection constraints inside
                    # the savepoint, before persisting a success as the final outcome.
                    await conn.execute("SET CONSTRAINTS ALL IMMEDIATE")
                    return result
            except HTTPException as error:
                result = {
                    "requestId": data["requestId"],
                    "state": "failed",
                    "kind": self.operation_kind,
                    "code": 40902 if error.status_code == 409 else error.status_code * 100 + 1,
                    "message": str(error.detail),
                    "status": error.status_code,
                    "data": None,
                }
                result=await self.decorate_failure(conn,who,data,result)
                await conn.execute(
                    "INSERT INTO trade_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                    (who.id, data["requestId"], fingerprint, Jsonb(result)),
                )
                return result
            except PostgreSQLError:
                # The nested transaction has rolled back every financial effect. A
                # live connection can now persist a bounded failure for the same UUID.
                result = {
                    "requestId": data["requestId"],
                    "state": "failed",
                    "kind": self.operation_kind,
                    "code": 50301,
                    "message": self.failure_message,
                    "status": 503,
                    "data": None,
                }
                result=await self.decorate_failure(conn,who,data,result)
                await conn.execute(
                    "INSERT INTO trade_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                    (who.id, data["requestId"], fingerprint, Jsonb(result)),
                )
                return result

    async def receipt(self, who, request_id):
        result = await self.trading.receipt(who, UUID(str(request_id)))
        if result.get("kind") != self.operation_kind:
            raise HTTPException(404, "历史费用原请求回执不存在")
        return result

    async def commit(self, conn, who, data, fingerprint, revision, preview):
        state, value = await self.calculate(conn, who, data)
        proof = await (
            await conn.execute(
                "SELECT * FROM trade_fee_previews WHERE token_hash=%s AND owner_id=%s AND session_hash=%s AND expires_at>clock_timestamp() AND consumed_at IS NULL FOR UPDATE",
                (digest(preview), who.id, who.token_hash),
            )
        ).fetchone()
        if (
            not proof
            or proof["payload_hash"] != fingerprint
            or proof["snapshot_hash"] != state["snapshotRevision"]
            or not value["canSubmit"]
        ):
            raise HTTPException(409, "预览失效或无可更正项目")
        await self.before_post(conn,who,data,state,value)
        for item in value["candidates"]:
            await conn.execute(
                "INSERT INTO trade_fee_corrections(id,owner_id,trade_id,request_id,old_fees,new_fees,detail) VALUES(%s,%s,%s,%s,%s,%s,%s)",
                (
                    uuid4(),
                    who.id,
                    item["orderId"],
                    data["requestId"],
                    item["oldFees"],
                    item["newFees"],
                    Jsonb(self.correction_detail(item,data)),
                ),
            )
        records = {r["id"]: r for r in state["records"]}
        for effect in value["positionEffects"]:
            record = records[effect["recordId"]]
            identifier = uuid4()
            await conn.execute(
                "INSERT INTO trade_fee_projections VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    identifier,
                    who.id,
                    record["id"],
                    data["requestId"],
                    record["revision"],
                    record["fee_projection_id"],
                    record["trade_tip_id"],
                    effect["quantity"],
                    effect["beforeCost"],
                    effect["afterCost"],
                    effect["beforeRealizedPnl"],
                    effect["afterRealizedPnl"],
                ),
            )
            await conn.execute(
                "UPDATE portfolio_records SET cost=%s,fee_projection_id=%s,revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s",
                (effect["afterCost"], identifier, who.id, record["id"]),
            )
        account = state["account"]
        now = datetime.now(UTC)
        await conn.execute(
            "INSERT INTO cash_ledger_entries(id,owner_id,account_id,account_kind,currency,request_id,kind,amount,affects_owner,occurred_at,note,fee_repair_request_id) VALUES(%s,%s,%s,%s,%s,%s,'fee_correction',%s,true,%s,%s,%s)",
            (
                uuid4(),
                who.id,
                account["id"],
                account["account_kind"],
                value["cashEffect"]["currency"],
                data["requestId"],
                value["cashEffect"]["delta"],
                now,
                self.cash_note,
                data["requestId"],
            ),
        )
        await conn.execute(
            "UPDATE cash_ledger_collections SET revision=revision+1 WHERE owner_id=%s", (who.id,)
        )
        result = self.completed_result(data,value,revision)
        await conn.execute(
            "INSERT INTO trade_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
            (who.id, data["requestId"], fingerprint, Jsonb(result)),
        )
        await conn.execute(
            "UPDATE trade_fee_previews SET consumed_at=clock_timestamp() WHERE token_hash=%s",
            (digest(preview),),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
            (who.id,self.audit_action,account["id"],data["requestId"]),
        )
        return result
