"""Confirmed manual fill recording in the same transaction as position and cash.

This service never sends broker instructions. Imported nonzero positions need a separately
verified opening history before this deliberately bounded recording path can use them.
"""

import hashlib
import json
import secrets
from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal, localcontext
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .broker_accounts import broker_account
from .cash_ledger import CashLedger, add
from .portfolio_records import ALIASES, PortfolioRecords
from .security import digest
from .trade_accounting import (
    AccountingError,
    FilledTrade,
    Position,
    apply_filled_trade,
    cash_delta,
    number,
    replay_economic_trades,
)

MARKET_CURRENCY = {"US": "USD", "HK": "HKD", "CN": "CNY", "SG": "SGD", "JP": "JPY", "KR": "KRW", "UK": "GBP"}


def exact(value, *, negative=False):
    value = number(value, negative=negative)
    if value.as_tuple().exponent < -18:
        raise AccountingError("金额或数量精度超过18位")
    return value


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def normalize(raw):
    required = {
        "requestId",
        "recordId",
        "recordRevision",
        "side",
        "quantity",
        "price",
        "amount",
        "fees",
        "currency",
        "settlementCurrency",
        "occurredAt",
        "confirmedActualFill",
    }
    if (
        not isinstance(raw, dict)
        or not required <= set(raw)
        or set(raw) - required - {"settlementAmount", "note", "feeInput", "allowFinancing", "financingConfirmation", "attachments"}
    ):
        raise HTTPException(422, "成交登记参数无效")
    if 'allowFinancing' in raw or 'financingConfirmation' in raw:
        from .financing_model import confirmation
        if raw.get('allowFinancing') is not True or raw.get('side')!='buy' or 'financingConfirmation' not in raw:raise HTTPException(422,'融资确认仅用于本人明确核实的已成交买入')
        confirmation(raw['financingConfirmation'])
    try:
        if not isinstance(raw["requestId"], str) or not isinstance(raw["occurredAt"], str):
            raise TypeError()
        request_id = str(UUID(raw["requestId"]))
        record_id = raw["recordId"]
        if not isinstance(record_id, str) or not 1 <= len(record_id) <= 100:
            raise ValueError()
        if (
            type(raw["recordRevision"]) is not int
            or raw["recordRevision"] < 1
            or raw["confirmedActualFill"] is not True
        ):
            raise ValueError()
        for key in ("currency", "settlementCurrency"):
            value = raw[key]
            if (
                not isinstance(value, str)
                or len(value) != 3
                or not value.isascii()
                or not value.isalpha()
                or value != value.upper()
            ):
                raise ValueError()
        quantity, price, amount, fees = (exact(raw[key]) for key in ("quantity", "price", "amount", "fees"))
        settlement = exact(raw["settlementAmount"]) if raw.get("settlementAmount") is not None else None
        if raw["side"] == "dividend" and (quantity != 0 or price != 0):
            raise ValueError()
        if raw["side"] != "dividend" and price <= 0:
            raise ValueError()
        trade = FilledTrade(
            raw["side"], quantity, price, fees, amount, raw["currency"], raw["settlementCurrency"], settlement
        )
        when = datetime.fromisoformat(raw["occurredAt"])
        if when.tzinfo is None:
            raise ValueError()
        note = raw.get("note", "")
        if not isinstance(note, str) or len(note) > 500 or any(ord(c) < 32 or ord(c) == 127 for c in note):
            raise ValueError()
        if trade.currency == trade.settlement_currency and settlement is not None:
            with localcontext() as context:
                context.prec = 80
                expected = amount + fees if trade.side == "buy" else amount - fees
                if settlement != expected:
                    raise ValueError()
        elif trade.currency != trade.settlement_currency and settlement is None:
            raise ValueError()
    except (ValueError, TypeError, KeyError, AccountingError):
        raise HTTPException(422, "请核对实际成交金额、原币费用及结算信息") from None
    attachment_spec = None
    if raw.get('attachments') is not None:
        if trade.side not in ('buy','sell') or trade.currency!=trade.settlement_currency:
            raise HTTPException(422,'附加委托须为明确同币种买卖成交')
        from .internal_order_families import attachments
        source = raw['attachments']
        if not isinstance(source,dict):
            raise HTTPException(422,'附加委托参数无效')
        source = dict(source)
        for name in ('takeProfit','stopLoss'):
            if isinstance(source.get(name),dict):
                source[name] = dict(source[name])
                for field in ('percent','fees','limitPrice'):
                    if isinstance(source[name].get(field),str):
                        try:
                            source[name][field] = exact(source[name][field])
                        except (AccountingError,ValueError,TypeError):
                            raise HTTPException(422,'附加委托须使用有效精确数值') from None
        attachment_spec = attachments(source)
    return {
        "requestId": request_id,
        "recordId": record_id,
        "recordRevision": raw["recordRevision"],
        "side": trade.side,
        "quantity": str(quantity),
        "price": str(price),
        "amount": str(amount),
        "fees": str(fees),
        "currency": trade.currency,
        "settlementCurrency": trade.settlement_currency,
        "settlementAmount": None if settlement is None else str(settlement),
        "occurredAt": when.astimezone(UTC).isoformat(),
        "note": note,
        "confirmedActualFill": True,
        **({'attachments':attachment_spec} if attachment_spec is not None else {}),
        **({"feeInput": raw["feeInput"]} if "feeInput" in raw else {}),
        **({"allowFinancing":True,"financingConfirmation":raw["financingConfirmation"]} if raw.get("allowFinancing") else {}),
    }


def trade_value(data):
    return FilledTrade(
        data["side"],
        Decimal(data["quantity"]),
        Decimal(data["price"]),
        Decimal(data["fees"]),
        Decimal(data["amount"]),
        data["currency"],
        data["settlementCurrency"],
        Decimal(data["settlementAmount"]) if data["settlementAmount"] is not None else None,
    )


class Trading:
    normalize_command=staticmethod(normalize)
    command_fingerprint=staticmethod(fingerprint)

    async def prepare_command(self,conn,who,data):
        return data

    async def decorate_receipt(self,conn,who,data,receipt):
        if data.get('attachments'):
            from .internal_order_families import create_children_from_recorded_trade
            trade = await (await conn.execute('SELECT * FROM trade_ledger WHERE owner_id=%s AND id=%s',
                                              (who.id,receipt['tradeId']))).fetchone()
            children = await create_children_from_recorded_trade(conn,who,trade,
                {'draft':{'attachmentsExact':data['attachments']}},data['requestId'])
            receipt = {**receipt,'attachments':data['attachments'],'children':children,'brokerExecution':False}
        return receipt

    async def decorate_preview(self,conn,who,data,preview):
        if data.get('attachments'):
            return {**preview,'attachments':data['attachments'],'attachmentAuthority':'explicit_internal_intents_after_recorded_fill',
                    'attachmentFeesAuthority':'estimates_not_actual_paid','brokerExecution':False}
        return preview

    async def existing_receipt(self,conn,who,data,result):
        return result

    async def preview_token_hash(self,conn,who,data,preview):
        return digest(preview)

    def __init__(self, db):
        self.db = db
        self.cash = CashLedger(db)
        self.records = PortfolioRecords(db)

    async def lock(self, conn, who):
        cash_revision = await self.cash.lock(conn, who)
        await self.records.lock(conn, who.id, who)
        return cash_revision

    async def economic_realized(self, conn, owner, record, trade):
        from .actual_projection import first_unknown_revision
        from .fee_repair_model import replay
        from .position_transfer_checkpoint import current_rows, economic_initial, initial_position, opening
        if await first_unknown_revision(conn,owner,record['id']) is not None:return None
        rows = await (
            await conn.execute(
                "SELECT * FROM trade_ledger WHERE owner_id=%s AND record_id=%s ORDER BY before_record_revision",
                (owner, record["id"]),
            )
        ).fetchall()
        if rows:
            from .trade_amendment_history import attach_amendments
            await attach_amendments(conn,owner,rows)
            corrections = await (
                await conn.execute(
                    "SELECT c.trade_id,c.new_fees FROM trade_fee_corrections c JOIN trade_ledger t ON t.owner_id=c.owner_id AND t.id=c.trade_id WHERE t.owner_id=%s AND t.record_id=%s",
                    (owner, record["id"]),
                )
            ).fetchall()
            projections = await (
                await conn.execute(
                    "SELECT * FROM trade_fee_projections WHERE owner_id=%s AND record_id=%s",
                    (owner, record["id"]),
                )
            ).fetchall()
            corrected_ids = {r["trade_id"] for r in corrections}
            if any(
                row["source"] in ("legacy_import_zero", "unverified_legacy")
                and row["fees"] == 0
                and row["id"] not in corrected_ids
                for row in current_rows(rows,record)
            ):
                return None
            try:
                initial, events = replay(
                    rows, record, {r["trade_id"]: r["new_fees"] for r in corrections}, projections
                )
            except ValueError:
                return None
        elif opening(record) is not None:
            initial = initial_position(record)
            events = []
        elif record["history_state"] == "empty" and record["qty"] == 0:
            initial = Position(record["qty"], record["cost"])
            events = []
        else:
            return None
        initial = economic_initial(record,initial)
        before = replay_economic_trades(initial, events)
        after = replay_economic_trades(initial, [*events, trade])
        if trade.side == "buy" or before.realized_pnl is None or after.realized_pnl is None:
            return None
        with localcontext() as context:
            context.prec = 80
            return after.realized_pnl - before.realized_pnl

    async def plan(self, conn, who, data, *, financial_source=False):
        if data["side"] == "dividend" and not getattr(self, "_statement_context", False):
            raise HTTPException(409, "股息到账须由统一单据凭证入口登记")
        record = await self.records.get(conn, who.id, data["recordId"])
        if not record:
            raise HTTPException(404, "记录不存在")
        if record["revision"] != data["recordRevision"]:
            raise HTTPException(409, "持仓已变化，请重新读取")
        if not record["broker_account_id"]:
            raise HTTPException(409, "请先明确持仓的稳定券商账户")
        account = await broker_account(conn, who.id, record["broker_account_id"])
        if account["holding_source"] != "manual" or account["account_kind"] not in {"real", "simulated"}:
            raise HTTPException(409, "账户来源或真实模拟身份尚未确认")
        if record["history_state"] == "unknown" or record["qty"] is None:
            raise HTTPException(409, "持仓历史或数量未知，请先核对期初")
        from .position_transfer_checkpoint import verify_current
        checkpoint = await verify_current(conn, who.id, record) if record.get("position_transfer_id") else None
        if record["history_state"] == "empty" and record["qty"] != 0 and checkpoint is None:
            raise HTTPException(409, "现有非零持仓需要独立期初证据，不能倒推历史")
        if record["history_state"] == "has_trades" and record["trade_tip_id"] is None:
            raise HTTPException(409, "原成交历史尚未迁入，不能接续记账")
        from .actual_projection import first_unknown_revision
        independent_credit = (getattr(self,'_statement_context',False) and data['side']=='dividend' and Decimal(data['settlementAmount'] if data['settlementAmount'] is not None else data['amount']) > (Decimal(0) if data['settlementAmount'] is not None else Decimal(data['fees'])))
        if await first_unknown_revision(conn,who.id,record['id']) is not None and not independent_credit:
            raise HTTPException(409,'历史实付费用权威未核对，不能按登记或估算费用接续记账',headers={'X-Alcor-Financial-Scope':'incomplete'})
        if "feeInput" in data:
            from .current_fees import calculate

            try:
                calculate(data, record, account, data["feeInput"])
                declared = data["feeInput"].get("plan", {})
                if declared.get("id"):
                    saved = await (
                        await conn.execute(
                            "SELECT * FROM fee_plan_revisions WHERE owner_id=%s AND id=%s AND revision=%s AND account_id=%s",
                            (who.id, declared["id"], declared.get("revision"), account["id"]),
                        )
                    ).fetchone()
                    if (
                        not saved
                        or saved["components"] != declared["overrides"]
                        or saved["effective_from"].isoformat() != declared["effectiveFrom"]
                        or saved["effective_through"].isoformat() != declared["effectiveThrough"]
                    ):
                        raise ValueError("personal_plan_revision_mismatch")
            except (ValueError, TypeError, KeyError):
                raise HTTPException(409, "费用分项、期间或来源未核对") from None
        trade = trade_value(data)
        market = ALIASES.get(record["market"].upper(), record["market"].upper())
        currency = MARKET_CURRENCY.get(market)
        settlement = "CNY" if market == "HK" and record["account_market"] == "CN" else currency
        if currency is None or trade.currency != currency or trade.settlement_currency != settlement:
            raise HTTPException(409, "证券市场与实际结算币种不一致")
        if settlement not in account["currencies"]:
            raise HTTPException(409, "账户未登记实际结算币种")
        opening = await (
            await conn.execute(
                "SELECT * FROM cash_ledger_accounts WHERE owner_id=%s AND account_id=%s AND currency=%s",
                (who.id, account["id"], settlement),
            )
        ).fetchone()
        if not opening:
            raise HTTPException(409, "请先核对所选账户的原币现金期初")
        when = datetime.fromisoformat(data["occurredAt"])
        now = (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
        latest = await (
            await conn.execute(
                "SELECT max(occurred_at) AS at FROM cash_ledger_entries WHERE owner_id=%s AND account_kind=%s AND currency=%s",
                (who.id, account["account_kind"], settlement),
            )
        ).fetchone()
        record_latest = await (
            await conn.execute(
                "SELECT max(occurred_at) AS at FROM trade_ledger WHERE owner_id=%s AND record_id=%s",
                (who.id, record["id"]),
            )
        ).fetchone()
        if checkpoint is not None and when < checkpoint["at"]:
            raise HTTPException(409, "成交时间早于已确认转仓期初")
        if (
            when > now
            or when < opening["opening_at"]
            or latest["at"]
            and when < latest["at"]
            or record_latest["at"]
            and when < record_latest["at"]
        ):
            raise HTTPException(409, "成交时间不在已核对历史之后，历史成交需独立重放预览")
        pending = await (
            await conn.execute(
                "SELECT 1 FROM broker_account_references r JOIN broker_accounts b ON b.owner_id=r.owner_id AND b.id=r.account_id "
                "WHERE r.owner_id=%s AND b.account_kind=%s AND r.kind='order' AND (r.currency=%s OR r.currency IS NULL) "
                "AND NOT EXISTS(SELECT 1 FROM trade_ledger t WHERE t.owner_id=r.owner_id AND t.id::text=r.reference_id) "
                "AND NOT EXISTS(SELECT 1 FROM internal_orders o WHERE o.owner_id=r.owner_id AND o.id::text=r.reference_id) LIMIT 1",
                (who.id, account["account_kind"], settlement),
            )
        ).fetchone()
        if pending:
            raise HTTPException(409, "已有委托预留尚未核对")
        try:
            result = apply_filled_trade(Position(record["qty"], record["cost"]), trade)
            result = replace(result, realized_pnl=await self.economic_realized(conn, who.id, record, trade))
            exact(result.position.quantity)
            if result.position.cost is not None:
                exact(result.position.cost, negative=True)
            if result.cash is None:
                raise AccountingError("实际结算未知")
            exact(result.cash, negative=True)
        except AccountingError as exc:
            raise HTTPException(409, str(exc)) from None
        independent_receipt_credit = (
            getattr(self, "_statement_context", False)
            and data["side"] == "dividend" and result.cash > 0
        )
        if not financial_source and not independent_receipt_credit:
            from .scope_coverage import account_status, limited
            if not await account_status(conn,who.id,account["id"],settlement):
                limited({'accountId':account["id"],'currency':settlement,'complete':False})
            from .actual_projection import require_actual_cash
            await require_actual_cash(conn,who.id,account["account_kind"],settlement,account["id"])
        total, _, balance = await self.cash.balances(
            conn, who.id, settlement, account["id"], account["account_kind"]
        )
        after = add(balance, result.cash)
        if data.get('allowFinancing'):
            from .financing_model import confirmation
            confirmation(data.get('financingConfirmation'))
            if data['side']!='buy' or (data.get('feeInput') or {}).get('source')=='rule_calculated':raise HTTPException(409,'融资登记须为已核实实付费用的实际买入，估算不能成为实际负债')
        if after < 0 and result.cash < 0 and not data.get('allowFinancing'):
            raise HTTPException(409, "所选账户现金不足；负现金登记须先完成明确的融资核实")
        return record, account, result, balance, total

    @staticmethod
    def projection(data, record, account, result, balance, total):
        from .current_fees import calculate

        detail = calculate(data, record, account, data["feeInput"]) if "feeInput" in data else None
        return {
            "feeDetail": detail,
            "recordId": record["id"],
            "accountId": account["id"],
            "accountKind": account["account_kind"],
            "recordRevision": record["revision"],
            "side": data["side"],
            "quantityBefore": str(record["qty"]),
            "quantityAfter": str(result.position.quantity),
            "costBefore": None if record["cost"] is None else str(record["cost"]),
            "costAfter": None if result.position.cost is None else str(result.position.cost),
            "cashCurrency": result.cash_currency,
            "cashDelta": str(result.cash),
            "cashBefore": str(balance),
            "cashAfter": str(add(balance, result.cash)),
            "ownerCashAfter": None if data["side"] == "dividend" else str(add(total, result.cash)),
            **({"ownerCashState": "unknown", "ownerCashScope": "owner_source_coverage_unverified"} if data["side"] == "dividend" else {}),
            "realizedPnl": None if result.realized_pnl is None else str(result.realized_pnl),
            "realizedPnlCurrency": data["currency"],
            "realizedPnlBasis": "economic_moving_average",
            "source": "owner_recorded",
            "brokerExecution": False,
        }

    async def actual_projection(self,conn,who,data,record,account,result,balance,total,*,before_known=None):
        from .actual_projection import first_unknown_revision
        value=self.projection(data,record,account,result,balance,total)
        estimated=(value.get('feeDetail') or {}).get('source')=='rule_calculated'
        unknown_revision=await first_unknown_revision(conn,who.id,record['id'])
        history_unknown=unknown_revision is not None and unknown_revision<record['revision']
        if before_known is None:before_known=await self.cash.account_complete(conn,who,{'accountId':account['id'],'accountKind':account['account_kind'],'currency':result.cash_currency})
        cash_known=not estimated and before_known
        owner_known=not estimated and await self.cash.owner_complete(conn,who,{'accountId':account['id'],'accountKind':account['account_kind'],'currency':result.cash_currency})
        value.update(actualFeeKnown=not estimated,ownerCashComplete=owner_known and value.get('ownerCashAfter') is not None)
        if data.get('allowFinancing'):
            from .financing_model import effect
            value['financing']={**effect(balance,add(balance,result.cash)),'confirmed':True,'policyIsBrokerAuthorization':False,'confirmationRequestId':data['requestId']}
        if estimated or history_unknown:
            value.update(registeredCostAfter=value['costAfter'],costAfter=None,registeredRealizedPnl=value['realizedPnl'],realizedPnl=None)
        if history_unknown:value.update(registeredCostBefore=value['costBefore'],costBefore=None)
        if not cash_known:value.update(registeredCashAfter=value['cashAfter'],cashAfter=None)
        if not before_known:value.update(registeredCashBefore=value['cashBefore'],cashBefore=None)
        if not owner_known:value.update(registeredOwnerCashAfter=value['ownerCashAfter'],ownerCashAfter=None)
        if estimated:value.update(estimatedFees=data['fees'],feeSource='rule_calculated',registeredCashDelta=value['cashDelta'],cashDelta=None)
        return value

    async def preview(self, who, raw):
        data = self.normalize_command(raw)
        original_fingerprint=self.command_fingerprint(data)
        async with self.db.connection() as conn, conn.transaction():
            revision = await self.lock(conn, who)
            data=await self.prepare_command(conn,who,data)
            record, account, result, balance, total = await self.plan(conn, who, data)
            token = secrets.token_urlsafe(32)
            row = await (
                await conn.execute(
                    "INSERT INTO trade_previews(token_hash,owner_id,session_hash,fingerprint,record_revision,cash_revision,account_revision) "
                    "VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING expires_at",
                    (
                        digest(token),
                        who.id,
                        who.token_hash,
                        original_fingerprint,
                        record["revision"],
                        revision,
                        account["revision"],
                    ),
                )
            ).fetchone()
            value={
                **await self.actual_projection(conn, who, data, record, account, result, balance, total),
                "preview": token,
                "expiresAt": row["expires_at"].isoformat(),
                "cashRevision": revision,
            }
            return await self.decorate_preview(conn,who,data,value)

    durable_financing_failures=True

    async def submit(self,who,raw,preview):
        if isinstance(raw,dict) and raw.get('allowFinancing') and self.durable_financing_failures:
            from .financing_failures import submit
            return await submit(self,who,raw,preview)
        return await self._submit_ledger(who,raw,preview)

    async def _submit_ledger(self, who, raw, preview):
        data = self.normalize_command(raw)
        hashed = self.command_fingerprint(data)
        if not isinstance(preview, str) or not 1 <= len(preview) <= 128:
            raise HTTPException(422, "预览凭证无效")
        async with self.db.connection() as conn, conn.transaction():
            cash_revision = await self.lock(conn, who)
            prior = await (
                await conn.execute(
                    "SELECT fingerprint,result FROM trade_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, data["requestId"]),
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != hashed:
                    raise HTTPException(409, "请求编号已用于其他操作")
                return await self.existing_receipt(conn,who,data,prior["result"])
            from .asset_request_domains import require_domain
            await require_domain(conn, who.id, data['requestId'], 'trade')
            if await (
                await conn.execute(
                    "SELECT 1 FROM cash_ledger_entries WHERE owner_id=%s AND request_id=%s",
                    (who.id, data["requestId"]),
                )
            ).fetchone():
                raise HTTPException(409, "请求编号已用于其他现金操作")
            selected_proof_hash=await self.preview_token_hash(conn,who,data,preview)
            proof = await (
                await conn.execute(
                    "SELECT * FROM trade_previews WHERE token_hash=%s AND owner_id=%s AND session_hash=%s "
                    "AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
                    (selected_proof_hash, who.id, who.token_hash),
                )
            ).fetchone()
            if not proof or proof["fingerprint"] != hashed or proof["cash_revision"] != cash_revision:
                raise HTTPException(409, "预览已过期或数据已变化，请重新核对")
            data=await self.prepare_command(conn,who,data)
            record, account, result, balance, total = await self.plan(conn, who, data)
            actual_before=await self.cash.account_complete(conn,who,{'accountId':account['id'],'accountKind':account['account_kind'],'currency':result.cash_currency})
            if (
                proof["record_revision"] != record["revision"]
                or proof["account_revision"] != account["revision"]
            ):
                raise HTTPException(409, "账户或持仓已变化，请重新核对")
            trade_id, cash_id = uuid4(), uuid4()
            await conn.execute(
                "INSERT INTO trade_ledger(id,owner_id,request_id,record_id,account_id,account_kind,side,quantity,price,amount,fees,currency,"
                "settlement_currency,settlement_amount,cash_delta,cash_entry_id,previous_trade_id,before_record_revision,before_quantity,before_cost,"
                "after_quantity,after_cost,realized_pnl,input_payload,occurred_at,note) "
                "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    trade_id,
                    who.id,
                    data["requestId"],
                    record["id"],
                    account["id"],
                    account["account_kind"],
                    data["side"],
                    data["quantity"],
                    data["price"],
                    data["amount"],
                    data["fees"],
                    data["currency"],
                    data["settlementCurrency"],
                    data["settlementAmount"],
                    result.cash,
                    cash_id,
                    record["trade_tip_id"],
                    record["revision"],
                    record["qty"],
                    record["cost"],
                    result.position.quantity,
                    result.position.cost,
                    result.realized_pnl,
                    Jsonb(data),
                    data["occurredAt"],
                    data["note"],
                ),
            )
            if data.get('allowFinancing'):
                from .financing_cash import attach
                await attach(conn,who,{**data,'_financingAccountId':account['id'],'_financingAccountKind':account['account_kind']},cash_id,balance,add(balance,result.cash),trade_id=trade_id)
            updated = await (
                await conn.execute(
                    "UPDATE portfolio_records SET qty=%s,cost=%s,history_state='has_trades',trade_tip_id=%s,updated_at=clock_timestamp() "
                    "WHERE owner_id=%s AND id=%s RETURNING *",
                    (result.position.quantity, result.position.cost, trade_id, who.id, record["id"]),
                )
            ).fetchone()
            await conn.execute(
                "INSERT INTO cash_ledger_entries(id,owner_id,account_id,account_kind,currency,request_id,kind,amount,affects_owner,occurred_at,note,source_trade_id) "
                "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,true,%s,%s,%s)",
                (
                    cash_id,
                    who.id,
                    account["id"],
                    account["account_kind"],
                    result.cash_currency,
                    data["requestId"],
                    "trade_" + data["side"],
                    result.cash,
                    data["occurredAt"],
                    data["note"],
                    trade_id,
                ),
            )
            await conn.execute(
                "UPDATE cash_ledger_collections SET revision=revision+1 WHERE owner_id=%s", (who.id,)
            )
            await conn.execute(
                "INSERT INTO broker_account_references(owner_id,account_id,kind,reference_id,currency) VALUES(%s,%s,'order',%s,%s)",
                (who.id, account["id"], str(trade_id), result.cash_currency),
            )
            if "feeInput" in data:
                from .current_fees import calculate

                await conn.execute(
                    "INSERT INTO trade_fee_details VALUES(%s,%s,%s)",
                    (who.id, trade_id, Jsonb(calculate(data, record, account, data["feeInput"]))),
                )
            from .actual_projection import actual_record_dto
            receipt = {
                **await self.actual_projection(conn, who, data, record, account, result, balance, total,before_known=actual_before),
                "requestId": data["requestId"],
                "tradeId": str(trade_id),
                "cashEntryId": str(cash_id),
                "state": "completed",
                "record": await actual_record_dto(conn,who.id,updated),
                "cashRevision": cash_revision + 1,
            }
            receipt=await self.decorate_receipt(conn,who,data,receipt)
            await conn.execute(
                "INSERT INTO trade_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (who.id, data["requestId"], hashed, Jsonb(receipt)),
            )
            await conn.execute(
                "UPDATE trade_previews SET consumed_at=clock_timestamp() WHERE token_hash=%s",
                (selected_proof_hash,),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'trade.recorded',%s,%s)",
                (who.id, str(trade_id), data["requestId"]),
            )
            return receipt

    async def receipt(self, who, request_id):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            row = await (
                await conn.execute(
                    "SELECT result FROM trade_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "未找到成交登记回执")
            return row["result"]

    async def list(self, who, record_id, *, limit=50, offset=0, revision=None):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            from .security import lock_mutation_identity
            await lock_mutation_identity(conn,who,require_admin=False)
            from .scope_coverage import require_record
            await require_record(conn,who.id,record_id)
            record = await self.records.get(conn, who.id, record_id)
            if not record:
                raise HTTPException(404, "记录不存在")
            from .position_transfer_checkpoint import attach_openings
            await attach_openings(conn,who.id,[record])
            if revision is not None and revision != record["revision"]:
                raise HTTPException(409, "成交历史已变化，请重新读取第一页")
            count = await (
                await conn.execute(
                    "SELECT count(*) n FROM trade_ledger WHERE owner_id=%s AND record_id=%s",
                    (who.id, record_id),
                )
            ).fetchone()
            rows = await (
                await conn.execute(
                    "SELECT * FROM trade_ledger WHERE owner_id=%s AND record_id=%s ORDER BY before_record_revision LIMIT %s OFFSET %s",
                    (who.id, record_id, limit, offset),
                )
            ).fetchall()
            details = await (
                await conn.execute(
                    "SELECT * FROM trade_fee_details WHERE owner_id=%s AND trade_id=ANY(%s)",
                    (who.id, [r["id"] for r in rows]),
                )
            ).fetchall()
            detail_map = {r["trade_id"]: r["detail"] for r in details}
            corrections = await (
                await conn.execute(
                    "SELECT * FROM trade_fee_corrections WHERE owner_id=%s AND trade_id=ANY(%s)",
                    (who.id, [r["id"] for r in rows]),
                )
            ).fetchall()
            from .trade_amendment_history import attach_amendments
            await attach_amendments(conn,who.id,rows)
            legacy_unknown = any(
                r["source"] in ("legacy_import_zero", "unverified_legacy") and r["fees"] == 0 for r in rows
            )
            if record.get("position_transfer_id") or record.get("fee_projection_id") or record.get("amendment_tip_id") or legacy_unknown:
                from .fee_repair_model import effective_projection

                history = await (
                    await conn.execute(
                        "SELECT * FROM trade_ledger WHERE owner_id=%s AND record_id=%s ORDER BY before_record_revision LIMIT 10001",
                        (who.id, record_id),
                    )
                ).fetchall()
                await attach_amendments(conn,who.id,history)
                if len(history) > 10000:
                    raise HTTPException(409, "完整费用历史超出读取范围")
                all_corrections = await (
                    await conn.execute(
                        "SELECT c.trade_id,c.new_fees FROM trade_fee_corrections c JOIN trade_ledger t ON t.owner_id=c.owner_id AND t.id=c.trade_id WHERE t.owner_id=%s AND t.record_id=%s",
                        (who.id, record_id),
                    )
                ).fetchall()
                projections = await (
                    await conn.execute(
                        "SELECT * FROM trade_fee_projections WHERE owner_id=%s AND record_id=%s",
                        (who.id, record_id),
                    )
                ).fetchall()
                try:
                    effective = effective_projection(
                        history, record, {c["trade_id"]: c["new_fees"] for c in all_corrections}, projections
                    )
                except ValueError:
                    raise HTTPException(409, "费用历史投影需核对") from None
                for row in rows:
                    row["originalProjection"] = {
                        key: None if row[key] is None else str(row[key])
                        for key in (
                            "before_quantity",
                            "before_cost",
                            "after_quantity",
                            "after_cost",
                            "realized_pnl",
                        )
                    }
                    row.update(effective[row["id"]])
                    if record.get("position_transfer_id"):
                        row["positionTransferId"]=str(record["position_transfer_id"])
            from .actual_projection import first_unknown_revision
            actual_unknown_from = await first_unknown_revision(conn,who.id,record_id)
            from .actual_projection import confirmed_actual_fees
            actual_confirmations=await confirmed_actual_fees(conn,who.id,[row['id'] for row in rows])
            actual_map={row['trade_id']:row for row in actual_confirmations}
            correction_map = {r["trade_id"]: r for r in corrections}
            for row in rows:
                change = correction_map.get(row["id"])
                row["originalFees"] = str(row["fees"])
                if record.get("position_transfer_id"):
                    row["positionOpening"]={"transferEventId":str(record["position_transfer_id"]),"scope":row.get("projectionScope","post_transfer_registered_trades"),"historicalPnlInherited":False}
                row["feeSource"] = row["source"]
                row["feeBreakdown"] = None
                row["feesKnown"] = not (
                    row["source"] in ("legacy_import_zero", "unverified_legacy")
                )
                if not row["feesKnown"]:
                    row["fees"] = None
                    row["feeSource"] = "unavailable_legacy"
                if row["id"] in detail_map:
                    saved = detail_map[row["id"]]
                    row["feeSource"] = saved["source"]
                    row["feeBreakdown"] = saved["components"]
                    row["feeRuleVersion"] = saved["ruleVersion"]
                    row["feeDetail"] = saved
                if change:
                    row["fees"] = change["new_fees"]
                    row["feesKnown"] = True
                    row["feeSource"] = "owner_reconstructed"
                    row["feeBreakdown"] = change["detail"]["components"]
                    row["feeProvenance"] = {
                        "source": "owner_reconstructed",
                        "operationId": str(change["request_id"]),
                        "detail": change["detail"],
                    }
            for row in rows:
                if row["source"] in ("legacy_import_zero","unverified_legacy") and row["id"] not in actual_map:
                    if row["feesKnown"]:row["estimatedFees"]=str(row["fees"])
                    row.update(fees=None,feesKnown=False,actualFeeKnown=False,registeredCashDelta=str(row["cash_delta"]),cash_delta=None,feeSource="unavailable_legacy")
                if row['id'] in actual_map:
                    actual=actual_map[row['id']]
                    row.update(fees=actual['actual_fee'],feesKnown=True,actualFeeKnown=True,feeSource='owner_recorded',registeredCashDelta=str(row['cash_delta']),feeDetail={'source':'owner_recorded','currency':actual['evidence']['currency'],'total':str(actual['actual_fee']),'brokerAccountId':actual['evidence']['brokerAccountId'],'providerId':actual['evidence']['providerId'],'components':[{'kind':'actual_paid','amount':str(actual['actual_fee']),'currency':actual['evidence']['currency'],'source':'owner_recorded'}],'ruleVersion':None,'ruleSnapshot':None,'evidence':actual['evidence']},feeProvenance={'source':'owner_recorded','operationId':str(correction_map[row['id']]['request_id']),'evidenceSha256':actual['evidence_sha256'],'detail':actual['evidence']})
                    change=correction_map[row['id']]
                    row['cash_delta']=row['cash_delta']-(change['new_fees']-change['old_fees'])
                if row['id'] not in actual_map and detail_map.get(row['id'],{}).get('source')=='rule_calculated':
                    row.update(registeredFees=row['originalFees'],estimatedFees=row['originalFees'],fees=None,feesKnown=False,actualFeeKnown=False,registeredCashDelta=str(row['cash_delta']),cash_delta=None,feeSource='rule_calculated')
                row['effectiveActive']=not row.get('_effective_inactive',False)
                if row.get('_effective_inactive'):
                    saved=row['_latest_amendment']
                    row.setdefault('registeredCashDelta',str(row['cash_delta']));row['cash_delta']=None
                    row['correction']={'action':saved['action'],'state':'deleted' if saved['action']=='delete' else 'superseded','requestId':str(saved['request_id']),'amendmentId':str(saved['id']),'replacementId':None if saved['action']=='delete' else str(saved['replacement_id'])}
                if row.get('_effective_event'):
                    saved=row['_latest_amendment'];effective=row['_effective_event']
                    row.setdefault('originalSide',row['side'])
                    row.setdefault('originalSettlementCurrency',row['settlement_currency'])
                    row.setdefault('originalSettlementAmount',None if row['settlement_amount'] is None else str(row['settlement_amount']))
                    row['side']=effective['side']
                    row['settlement_currency']=effective['settlement_currency']
                    row['settlement_amount']=None if effective['settlement_amount'] is None else Decimal(effective['settlement_amount'])
                    row.update({key:Decimal(effective[key]) for key in ('quantity','price','amount','fees')})
                    row['occurred_at']=datetime.fromisoformat(effective['occurred_at'])
                    row.setdefault('registeredCashDelta',str(row['cash_delta']))
                    row['cash_delta']=cash_delta(FilledTrade(row['side'],row['quantity'],row['price'],row['fees'],row['amount'],row['currency'],row['settlement_currency'],row['settlement_amount']))
                    row['feesKnown']=True;row['actualFeeKnown']=True;row['feeSource']='owner_recorded'
                    row['feeDetail']=saved['evidence'].get('legacyFeeDetail') or {'source':'owner_recorded','currency':row['currency'],'total':effective['fees'],'ruleVersion':None,'ruleSnapshot':None,'components':None,'evidence':saved['evidence']}
                    row['feeProvenance']={'source':'owner_recorded','operationId':str(saved['request_id']),'evidenceSha256':saved['evidence_sha256'],'detail':saved['evidence']}
                    row['amendment']={'id':str(saved['id']),'requestId':str(saved['request_id']),'replacementId':str(saved['replacement_id']),'originalTradeId':str(saved['trade_id']),'brokerExecution':False,'source':'owner_recorded'}
                if actual_unknown_from is not None and row["before_record_revision"]>=actual_unknown_from:
                    row["after_cost"]=None;row["realized_pnl"]=None
                    if row["before_record_revision"]>actual_unknown_from:row["before_cost"]=None
            return {
                "total": count["n"],
                "recordRevision": record["revision"],
                "nextOffset": offset + len(rows) if offset + len(rows) < count["n"] else None,
                "items": [
                    {
                        **{key:value for key,value in row.items() if not key.startswith('_')},
                        **{
                            key: None if row[key] is None else str(row[key])
                            for key in (
                                "quantity",
                                "price",
                                "amount",
                                "fees",
                                "settlement_amount",
                                "cash_delta",
                                "before_quantity",
                                "before_cost",
                                "after_quantity",
                                "after_cost",
                                "realized_pnl",
                            )
                        },
                    }
                    for row in rows
                ],
            }
