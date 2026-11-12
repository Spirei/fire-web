"""PG-backed internal limit intents and reservations, without broker or quote execution."""

import hashlib
import json
import secrets
from decimal import Decimal, localcontext
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .broker_accounts import broker_account, serialize_brokers
from .cash_ledger import CashLedger
from .portfolio_records import ALIASES, PortfolioRecords
from .security import digest
from .trade_accounting import AccountingError, number
from .trading import MARKET_CURRENCY


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def precise(value):
    result = number(value)
    if result.as_tuple().exponent < -18:
        raise AccountingError("数量或金额精度超过18位")
    return result


def normalize(raw):
    if not isinstance(raw, dict):
        raise HTTPException(422, "委托参数无效")
    try:
        if not isinstance(raw.get("requestId"), str):
            raise TypeError()
        request_id = str(UUID(raw["requestId"]))
        action = raw["action"]
        if action == "create":
            required = {
                "requestId",
                "action",
                "recordId",
                "recordRevision",
                "side",
                "quantity",
                "limitPrice",
                "fees",
                "confirmedInternalOrder",
            }
            if (
                not required <= set(raw)
                or set(raw) - required - {"note"}
                or raw["confirmedInternalOrder"] is not True
            ):
                raise ValueError()
            if type(raw["recordRevision"]) is not int or raw["recordRevision"] < 1:
                raise ValueError()
            record_id = raw["recordId"]
            if not isinstance(record_id, str) or not 1 <= len(record_id) <= 100:
                raise ValueError()
            if raw["side"] not in ("buy", "sell"):
                raise ValueError()
            quantity, price, fees = (precise(raw[k]) for k in ("quantity", "limitPrice", "fees"))
            if quantity <= 0 or price <= 0:
                raise ValueError()
            with localcontext() as context:
                context.prec = 80
                required_cash = precise(quantity * price + fees) if raw["side"] == "buy" else Decimal(0)
            note = raw.get("note", "")
            if (
                not isinstance(note, str)
                or len(note) > 500
                or any(ord(c) < 32 or ord(c) == 127 for c in note)
            ):
                raise ValueError()
            return {
                "requestId": request_id,
                "action": action,
                "recordId": record_id,
                "recordRevision": raw["recordRevision"],
                "side": raw["side"],
                "quantity": str(quantity),
                "limitPrice": str(price),
                "fees": str(fees),
                "reservationCash": str(required_cash),
                "note": note,
                "confirmedInternalOrder": True,
            }
        if action == "cancel":
            if (
                set(raw) != {"requestId", "action", "orderId", "orderRevision"}
                or type(raw["orderRevision"]) is not int
                or raw["orderRevision"] < 1
            ):
                raise ValueError()
            if not isinstance(raw["orderId"], str):
                raise TypeError()
            return {
                "requestId": request_id,
                "action": action,
                "orderId": str(UUID(raw["orderId"])),
                "orderRevision": raw["orderRevision"],
            }
        raise ValueError()
    except (ValueError, TypeError, KeyError, AccountingError):
        raise HTTPException(422, "请核对内部限价委托的数量、费用和版本") from None


async def pending_reservations(conn, owner, account_kind, currency, record_id=None, account_id=None, *, account_scope=False, exclude_order_id=None, shared_read=False):
    """Caller holds the owner transaction lock. Unknown references never become zero."""
    # Cash/asset reads must not upgrade their shared owner locks here. Existing
    # financial writers still acquire and retain the default exclusive domains.
    await serialize_brokers(conn, owner, shared_read=shared_read)
    scoped_account = account_id if account_scope else None
    if account_scope and not scoped_account:raise ValueError('explicit reservation account required')
    rows = await (
        await conn.execute(
            "SELECT o.*,r.id AS current_record,r.broker_account_id,r.code AS current_code,r.market AS current_market,r.deleted_at AS record_deleted,r.qty AS current_qty,r.cost AS current_cost,r.history_state,r.account_market AS current_account_market,r.source AS current_source,r.position_transfer_id AS current_position_transfer_id,"
            "b.deleted_at AS account_deleted,b.holding_source,b.account_kind AS current_kind,fl.family_id AS oco_family_id "
            "FROM internal_orders o LEFT JOIN portfolio_records r ON r.owner_id=o.owner_id AND r.id=o.record_id "
            "LEFT JOIN broker_accounts b ON b.owner_id=o.owner_id AND b.id=o.account_id "
            "LEFT JOIN internal_order_family_legs fl ON fl.owner_id=o.owner_id AND fl.order_id=o.id "
            "WHERE o.owner_id=%s AND o.account_kind=%s AND o.currency=%s AND o.status='pending' AND (%s::text IS NULL OR o.account_id=%s) AND (%s::uuid IS NULL OR (o.id<>%s AND NOT EXISTS(SELECT 1 FROM internal_order_family_legs a JOIN internal_order_family_legs z ON z.owner_id=a.owner_id AND z.family_id=a.family_id WHERE a.owner_id=o.owner_id AND a.order_id=%s AND z.order_id=o.id))) ORDER BY o.created_at,o.id",
            (owner, account_kind, currency,scoped_account,scoped_account,exclude_order_id,exclude_order_id,exclude_order_id),
        )
    ).fetchall()
    unknown = await (
        await conn.execute(
            "SELECT 1 FROM broker_account_references r JOIN broker_accounts b ON b.owner_id=r.owner_id AND b.id=r.account_id "
            "WHERE r.owner_id=%s AND b.account_kind=%s AND r.kind='order' AND (r.currency=%s OR r.currency IS NULL) "
            "AND NOT EXISTS(SELECT 1 FROM trade_ledger t WHERE t.owner_id=r.owner_id AND t.id::text=r.reference_id) "
            "AND NOT EXISTS(SELECT 1 FROM internal_orders o WHERE o.owner_id=r.owner_id AND o.id::text=r.reference_id) AND (%s::text IS NULL OR r.account_id=%s) LIMIT 1",
            (owner, account_kind, currency,scoped_account,scoped_account),
        )
    ).fetchone()
    complete = not unknown
    with localcontext() as context:
        context.prec = 80
        cash = Decimal(0)
        account_cash = Decimal(0)
        quantity = Decimal(0)
        verified_openings = {}
        groups = {}
        for row in rows:
            checkpoint_known = False
            if row.get('current_position_transfer_id'):
                key = row['record_id']
                if key not in verified_openings:
                    from .position_transfer_checkpoint import verify_current
                    actual_record = await (await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s AND deleted_at IS NULL', (owner,key))).fetchone()
                    try:
                        verified_openings[key] = bool(actual_record and await verify_current(conn,owner,actual_record))
                    except (HTTPException,ValueError):
                        verified_openings[key] = False
                checkpoint_known = verified_openings[key]
            valid = (
                row["current_record"] is not None
                and row["record_deleted"] is None
                and row["account_deleted"] is None
                and row["broker_account_id"] == row["account_id"]
                and row["current_code"] == row["record_code"]
                and row["current_market"] == row["record_market"]
                and row["current_kind"] == account_kind
                and row["holding_source"] == "manual"
                and row["current_qty"] is not None
                and row["current_cost"] is not None
                and row["history_state"] != "unknown"
                and (not row.get("current_position_transfer_id") or checkpoint_known)
                and not (row["history_state"] == "empty" and row["current_qty"] != 0 and not checkpoint_known)
                and row["current_account_market"] == row["record_account_market"]
                and row["current_source"] == row["record_source"]
            )
            complete = complete and valid
            key = ('oco',str(row['oco_family_id']),row['account_id'],row['record_id'],row['side']) if row['oco_family_id'] else ('single',str(row['id']))
            group = groups.setdefault(key,{'cash':Decimal(0),'accountCash':Decimal(0),'qty':Decimal(0)})
            if row['side']=='buy':
                group['cash']=max(group['cash'],row['reservation_cash'])
                if row['account_id']==account_id:
                    group['accountCash']=max(group['accountCash'],row['reservation_cash'])
            elif row['record_id']==record_id:
                group['qty']=max(group['qty'],row['quantity'])
        cash=sum((group['cash'] for group in groups.values()),Decimal(0))
        account_cash=sum((group['accountCash'] for group in groups.values()),Decimal(0))
        quantity=sum((group['qty'] for group in groups.values()),Decimal(0))
    revision = await (
        await conn.execute("SELECT revision FROM internal_order_collections WHERE owner_id=%s", (owner,))
    ).fetchone()
    return {
        "complete": complete,
        "cash": cash if complete else None,
        "account_cash": account_cash if complete else None,
        "quantity": quantity if complete else None,
        "revision": revision["revision"] if revision else 0,
    }


def order_dto(row):
    return {
        "id": str(row["id"]),
        "accountId": row["account_id"],
        "accountKind": row["account_kind"],
        "recordId": row["record_id"],
        "currency": row["currency"],
        "side": row["side"],
        "orderType": row["order_type"],
        **({"originalStatus": row["import_original_status"], "originalIntent": row["import_original_intent"]} if row["order_type"] == "imported" else {}),
        "quantity": str(row["quantity"]),
        "limitPrice": str(row["limit_price"]),
        "fees": str(row["fees"]),
        "reservedCash": str(row["reservation_cash"]) if row["status"] == "pending" else "0",
        "status": row["status"],
        "revision": row["revision"],
        "note": row["note"],
        "createdAt": row["created_at"].isoformat(),
        "cancelledAt": row["cancelled_at"].isoformat() if row["cancelled_at"] else None,
        "executionModel": "imported_inactive" if row["order_type"] == "imported" else "internal_pending",
        "brokerExecution": False,
        "executionEnabled": row["execution_enabled"],
    }


class InternalOrders:
    def __init__(self, db):
        self.db = db
        self.cash = CashLedger(db)
        self.records = PortfolioRecords(db)

    async def lock(self, conn, who):
        cash_revision = await self.cash.lock(conn, who)
        await self.records.lock(conn, who.id, who)
        await conn.execute(
            "INSERT INTO internal_order_collections(owner_id) VALUES(%s) ON CONFLICT DO NOTHING", (who.id,)
        )
        orders = await (
            await conn.execute(
                "SELECT revision FROM internal_order_collections WHERE owner_id=%s FOR UPDATE", (who.id,)
            )
        ).fetchone()
        return cash_revision, orders["revision"]

    async def plan(self, conn, who, data, cash_revision, order_revision):
        if data["action"] == "cancel":
            row = await (
                await conn.execute(
                    "SELECT * FROM internal_orders WHERE owner_id=%s AND id=%s FOR UPDATE",
                    (who.id, data["orderId"]),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "委托不存在")
            if row["revision"] != data["orderRevision"] or row["status"] != "pending":
                raise HTTPException(409, "委托状态已变化，请重新读取")
            # Cancellation must remain possible even if a source or holding has since become unavailable.
            return {
                "order": row,
                "dependencies": {"orderRevision": row["revision"]},
                "summary": {"order": order_dto(row), "action": "cancel"},
            }
        record = await self.records.get(conn, who.id, data["recordId"])
        if not record:
            raise HTTPException(404, "证券记录不存在")
        if record["revision"] != data["recordRevision"]:
            raise HTTPException(409, "证券记录已变化")
        if not record["broker_account_id"] or record["qty"] is None or record["cost"] is None:
            raise HTTPException(409, "持仓账户、数量或成本尚未核实")
        from .position_transfer_checkpoint import verify_current
        checkpoint = await verify_current(conn,who.id,record) if record.get("position_transfer_id") else None
        if (
            record["history_state"] == "unknown"
            or (record["history_state"] == "empty" and record["qty"] != 0 and checkpoint is None)
            or (record["history_state"] == "has_trades" and record["trade_tip_id"] is None)
        ):
            raise HTTPException(409, "证券期初与成交来源尚未核实")
        account = await broker_account(conn, who.id, record["broker_account_id"])
        if account["account_kind"] not in ("real", "simulated") or account["holding_source"] != "manual":
            raise HTTPException(409, "账户身份或官方来源不允许内部委托")
        market = ALIASES.get(record["market"].upper(), record["market"].upper())
        currency = MARKET_CURRENCY.get(market)
        if currency is None or (market == "HK" and record["account_market"] == "CN"):
            raise HTTPException(409, "当前内部委托不支持该市场或跨币净结算")
        if currency not in account["currencies"]:
            raise HTTPException(409, "账户币种尚未核实")
        opening = await (
            await conn.execute(
                "SELECT 1 FROM cash_ledger_accounts WHERE owner_id=%s AND account_id=%s AND currency=%s",
                (who.id, account["id"], currency),
            )
        ).fetchone()
        if not opening:
            raise HTTPException(409, "请先核对账户现金期初")
        reservation = await pending_reservations(
            conn, who.id, account["account_kind"], currency, record["id"], account["id"], account_scope=True, exclude_order_id=data.get("_excludedOrder")
        )
        if not reservation["complete"]:
            raise HTTPException(409, "现有委托来源不完整，不能推断可用数量或现金")
        from .scope_coverage import account_status, limited
        if not await account_status(conn,who.id,account["id"],currency):
            limited({"accountId":account["id"],"currency":currency,"complete":False})
        from .actual_projection import require_actual_cash
        await require_actual_cash(conn,who.id,account["account_kind"],currency,account["id"])
        _total, _, balance = await self.cash.balances(
            conn, who.id, currency, account["id"], account["account_kind"]
        )
        with localcontext() as context:
            context.prec = 80
            available_cash = max(
                Decimal(0), balance - reservation["account_cash"]
            )
            available_qty = max(Decimal(0), record["qty"] - reservation["quantity"])
            if data["side"] == "buy" and Decimal(data.get("_capacityCash",data["reservationCash"])) > available_cash:
                raise HTTPException(409, "可用于新委托的现金不足")
            if data["side"] == "sell" and Decimal(data["quantity"]) > available_qty:
                raise HTTPException(409, "可用于新委托的数量不足")
        return {
            "record": record,
            "account": account,
            "currency": currency,
            "dependencies": {
                "recordRevision": record["revision"],
                "accountRevision": account["revision"],
                "cashRevision": cash_revision,
                "orderRevision": order_revision,
            },
            "summary": {
                "action": "create",
                "recordId": record["id"],
                "accountId": account["id"],
                "accountKind": account["account_kind"],
                "currency": currency,
                "side": data["side"],
                "quantity": data["quantity"],
                "limitPrice": data["limitPrice"],
                "fees": data["fees"],
                "reservedCash": data["reservationCash"],
                "availableCashBefore": str(available_cash),
                "availableQuantityBefore": str(available_qty),
                "executionModel": "internal_pending",
                "brokerExecution": False,
                "executionEnabled": False,
            },
        }

    async def preview(self, who, raw):
        data = normalize(raw)
        async with self.db.connection() as conn, conn.transaction():
            cash_revision, order_revision = await self.lock(conn, who)
            planned = await self.plan(conn, who, data, cash_revision, order_revision)
            token = secrets.token_urlsafe(32)
            row = await (
                await conn.execute(
                    "INSERT INTO internal_order_previews(token_hash,owner_id,session_hash,fingerprint,dependencies) "
                    "VALUES(%s,%s,%s,%s,%s) RETURNING expires_at",
                    (
                        digest(token),
                        who.id,
                        who.token_hash,
                        fingerprint(data),
                        Jsonb(planned["dependencies"]),
                    ),
                )
            ).fetchone()
            return {**planned["summary"], "preview": token, "expiresAt": row["expires_at"].isoformat()}

    async def submit(self, who, raw, preview):
        data = normalize(raw)
        hashed = fingerprint(data)
        if not isinstance(preview, str) or not 1 <= len(preview) <= 128:
            raise HTTPException(422, "预览凭证无效")
        async with self.db.connection() as conn, conn.transaction():
            cash_revision, order_revision = await self.lock(conn, who)
            prior = await (
                await conn.execute(
                    "SELECT fingerprint,result FROM internal_order_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, data["requestId"]),
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != hashed:
                    raise HTTPException(409, "请求编号已用于其他委托操作")
                return prior["result"]
            from .asset_request_domains import require_domain
            await require_domain(conn,who.id,data['requestId'],'internal_order')
            proof = await (
                await conn.execute(
                    "SELECT * FROM internal_order_previews WHERE token_hash=%s AND owner_id=%s AND session_hash=%s "
                    "AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE",
                    (digest(preview), who.id, who.token_hash),
                )
            ).fetchone()
            if not proof or proof["fingerprint"] != hashed:
                raise HTTPException(409, "预览已失效或不属于当前会话")
            planned = await self.plan(conn, who, data, cash_revision, order_revision)
            if proof["dependencies"] != planned["dependencies"]:
                raise HTTPException(409, "账户、持仓、现金或委托已变化，请重新预览")
            if data["action"] == "create":
                row = await (
                    await conn.execute(
                        "INSERT INTO internal_orders(id,owner_id,account_id,account_kind,record_id,record_code,record_market,"
                        "record_account_market,record_source,currency,side,quantity,limit_price,fees,reservation_cash,note) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
                        (
                            uuid4(),
                            who.id,
                            planned["account"]["id"],
                            planned["account"]["account_kind"],
                            planned["record"]["id"],
                            planned["record"]["code"],
                            planned["record"]["market"],
                            planned["record"]["account_market"],
                            planned["record"]["source"],
                            planned["currency"],
                            data["side"],
                            data["quantity"],
                            data["limitPrice"],
                            data["fees"],
                            data["reservationCash"],
                            data["note"],
                        ),
                    )
                ).fetchone()
            else:
                row = await (
                    await conn.execute(
                        "UPDATE internal_orders SET status='cancelled',cancelled_at=clock_timestamp() WHERE owner_id=%s AND id=%s RETURNING *",
                        (who.id, data["orderId"]),
                    )
                ).fetchone()
            # Reservation changes invalidate already issued cash/trade proofs without altering any cash posting.
            await conn.execute(
                "UPDATE cash_ledger_collections SET revision=revision+1 WHERE owner_id=%s", (who.id,)
            )
            result = {
                "requestId": data["requestId"],
                "action": data["action"],
                "state": "completed",
                "order": order_dto(row),
            }
            await conn.execute(
                "INSERT INTO internal_order_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
                (who.id, data["requestId"], hashed, Jsonb(result)),
            )
            await conn.execute(
                "UPDATE internal_order_previews SET consumed_at=clock_timestamp() WHERE token_hash=%s",
                (digest(preview),),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
                (who.id, "internal-order." + data["action"], str(row["id"]), data["requestId"]),
            )
            return result

    async def receipt(self, who, request_id):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            row = await (
                await conn.execute(
                    "SELECT result FROM internal_order_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "委托操作回执不存在")
            return row["result"]

    async def list(self, who, *, limit=50, offset=0, revision=None):
        async with self.db.connection() as conn, conn.transaction():
            _, current = await self.lock(conn, who)
            if revision is not None and revision != current:
                raise HTTPException(409, "委托集合已变化，请重新读取第一页")
            rows = await (
                await conn.execute(
                    "SELECT * FROM internal_orders WHERE owner_id=%s ORDER BY created_at,id LIMIT %s OFFSET %s",
                    (who.id, limit, offset),
                )
            ).fetchall()
            total = (
                await (
                    await conn.execute("SELECT count(*) n FROM internal_orders WHERE owner_id=%s", (who.id,))
                ).fetchone()
            )["n"]
            from .personal_data_transfer import order_declarations_on_connection
            declarations = await order_declarations_on_connection(conn, who.id, limit=limit, offset=offset)
            return {
                "importedDeclarations": declarations,
                "items": [order_dto(row) for row in rows],
                "revision": current,
                "total": total,
                "nextOffset": offset + len(rows) if offset + len(rows) < total else None,
            }
