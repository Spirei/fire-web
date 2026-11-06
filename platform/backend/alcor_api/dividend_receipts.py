"""Actual dividend statement recording over the single trade/cash transaction."""

from contextlib import asynccontextmanager
from decimal import localcontext

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from alcor_api.broker_accounts import serialize_brokers
from alcor_api.security import digest, lock_mutation_identity
from alcor_api.trading import Trading, exact, fingerprint
from alcor_api.trading import normalize as normalize_trade


def normalize(raw):
    required = {
        "requestId",
        "recordId",
        "recordRevision",
        "eventReference",
        "grossAmount",
        "withheldTax",
        "processingFee",
        "currency",
        "settlementCurrency",
        "occurredAt",
        "confirmedActualReceipt",
    }
    if (
        not isinstance(raw, dict)
        or not required <= raw.keys()
        or raw.keys() - required - {"settlementAmount", "note"}
        or raw["confirmedActualReceipt"] is not True
    ):
        raise HTTPException(422, "实际股息凭证参数无效")
    reference = raw["eventReference"]
    if (
        not isinstance(reference, str)
        or not 1 <= len(reference) <= 160
        or reference.strip() != reference
        or any(ord(c) < 32 or ord(c) == 127 for c in reference)
    ):
        raise HTTPException(422, "请填写单据的唯一派息事件编号")
    try:
        gross, tax, fee = (exact(raw[key]) for key in ("grossAmount", "withheldTax", "processingFee"))
        with localcontext() as ctx:
            ctx.prec = 80
            total = tax + fee
        if gross <= 0 or total > gross:
            raise ValueError()
        trade = normalize_trade(
            {
                "requestId": raw["requestId"],
                "recordId": raw["recordId"],
                "recordRevision": raw["recordRevision"],
                "side": "dividend",
                "quantity": "0",
                "price": "0",
                "amount": str(gross),
                "fees": str(total),
                "currency": raw["currency"],
                "settlementCurrency": raw["settlementCurrency"],
                "settlementAmount": raw.get("settlementAmount"),
                "occurredAt": raw["occurredAt"],
                "note": raw.get("note", ""),
                "confirmedActualFill": True,
            }
        )
    except ValueError:
        raise HTTPException(422, "实际股息总额与原币税费无效") from None
    return {
        "trade": trade,
        "eventReference": reference,
        "grossAmount": str(gross),
        "withheldTax": str(tax),
        "processingFee": str(fee),
        "confirmedActualReceipt": True,
    }


class BoundDatabase:
    def __init__(self, conn):
        self.conn = conn

    @asynccontextmanager
    async def connection(self):
        yield self.conn


class DividendReceipts:
    def __init__(self, db):
        self.db = db

    async def guard(self, conn, who, data):
        trades = Trading(BoundDatabase(conn))
        trades._statement_context = True
        await trades.lock(conn, who)
        record = await trades.records.get(conn, who.id, data["trade"]["recordId"])
        if not record:
            raise HTTPException(404, "证券记录不存在")
        existing = await (
            await conn.execute(
                "SELECT 1 FROM dividend_receipts WHERE owner_id=%s AND account_id=%s AND record_id=%s AND event_reference=%s",
                (who.id, record["broker_account_id"], record["id"], data["eventReference"]),
            )
        ).fetchone()
        if existing:
            raise HTTPException(409, "该股息事件已登记，请查询原回执")
        return trades, record

    async def preview(self, who, raw):
        data = normalize(raw)
        async with self.db.connection() as conn, conn.transaction():
            trades, _ = await self.guard(conn, who, data)
            value = await trades.preview(who, data["trade"])
            await conn.execute(
                "INSERT INTO dividend_receipt_previews VALUES(%s,%s,%s)",
                (digest(value["preview"]), who.id, fingerprint(data)),
            )
            return {
                **value,
                "eventReference": data["eventReference"],
                "grossAmount": data["grossAmount"],
                "withheldTax": data["withheldTax"],
                "processingFee": data["processingFee"],
                "source": "owner_confirmed_statement",
            }

    async def submit(self, who, raw, proof):
        data = normalize(raw)
        if not isinstance(proof, str) or not 1 <= len(proof) <= 128:
            raise HTTPException(422, "预览凭证无效")
        async with self.db.connection() as conn, conn.transaction():
            trades = Trading(BoundDatabase(conn))
            trades._statement_context = True
            await trades.lock(conn, who)
            prior = await (
                await conn.execute(
                    "SELECT fingerprint,result FROM dividend_receipts WHERE owner_id=%s AND request_id=%s",
                    (who.id, data["trade"]["requestId"]),
                )
            ).fetchone()
            if prior:
                if prior["fingerprint"] != fingerprint(data):
                    raise HTTPException(409, "请求编号已用于其他股息凭证")
                return prior["result"]
            if await (
                await conn.execute(
                    "SELECT 1 FROM trade_operations WHERE owner_id=%s AND request_id=%s",
                    (who.id, data["trade"]["requestId"]),
                )
            ).fetchone():
                raise HTTPException(409, "请求编号已用于其他成交登记")
            binding = await (
                await conn.execute(
                    "SELECT fingerprint FROM dividend_receipt_previews WHERE token_hash=%s AND owner_id=%s",
                    (digest(proof), who.id),
                )
            ).fetchone()
            if not binding or binding["fingerprint"] != fingerprint(data):
                raise HTTPException(409, "股息凭证预览已变化")
            _, record = await self.guard(conn, who, data)
            result = await trades.submit(who, data["trade"], proof)
            result = {
                **result,
                "eventReference": data["eventReference"],
                "grossAmount": data["grossAmount"],
                "withheldTax": data["withheldTax"],
                "processingFee": data["processingFee"],
                "source": "owner_confirmed_statement",
            }
            await conn.execute(
                "INSERT INTO dividend_receipts(owner_id,request_id,trade_id,account_id,record_id,event_reference,fingerprint,input_payload,result) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    who.id,
                    data["trade"]["requestId"],
                    result["tradeId"],
                    record["broker_account_id"],
                    record["id"],
                    data["eventReference"],
                    fingerprint(data),
                    Jsonb(data),
                    Jsonb(result),
                ),
            )
            return result

    async def receipt(self, who, request_id):
        async with self.db.connection() as conn, conn.transaction():
            await serialize_brokers(conn, who.id)
            await lock_mutation_identity(conn, who, require_admin=False)
            row = await (
                await conn.execute(
                    "SELECT result FROM dividend_receipts WHERE owner_id=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if not row:
                raise HTTPException(404, "股息凭证不存在")
            return row["result"]

    async def list(self, who, limit=25, before=None):
        if (
            type(limit) is not int
            or not 1 <= limit <= 100
            or before is not None
            and (type(before) is not int or before < 1)
        ):
            raise HTTPException(422, "分页参数无效")
        async with self.db.connection() as conn, conn.transaction():
            await serialize_brokers(conn, who.id)
            await lock_mutation_identity(conn, who, require_admin=False)
            rows = await (
                await conn.execute(
                    "SELECT sequence,created_at,result FROM dividend_receipts WHERE owner_id=%s AND (%s::bigint IS NULL OR sequence<%s) ORDER BY sequence DESC LIMIT %s",
                    (who.id, before, before, limit + 1),
                )
            ).fetchall()
            return {
                "items": [
                    {"createdAt": row["created_at"].isoformat(), **row["result"]} for row in rows[:limit]
                ],
                "nextCursor": rows[limit - 1]["sequence"] if len(rows) > limit else None,
            }

    async def record_legacy_aggregate(self, conn, who, trade_id, request_id, *, gross, fees):
        """Explicit legacy owner receipt, aggregate paid fees known; tax split remains unknown."""
        row=await (await conn.execute('SELECT * FROM trade_ledger WHERE owner_id=%s AND id=%s',(who.id,trade_id))).fetchone()
        if not row or row['side']!='dividend' or row['amount']!=exact(gross) or row['fees']!=exact(fees):
            raise HTTPException(409,'原股息到账与聚合费用无法核对')
        reference='legacy-owner-request:'+str(request_id)
        data={'eventReference':reference,'grossAmount':str(row['amount']),'paidFees':str(row['fees']),
              'withheldTax':None,'processingFee':None,'source':'legacy_owner_declared_aggregate',
              'taxBreakdownState':'unknown','providerStatementReference':None,'confirmedActualReceipt':True}
        result={**data,'requestId':str(request_id),'tradeId':str(trade_id),'state':'completed'}
        await conn.execute('''INSERT INTO dividend_receipts(owner_id,request_id,trade_id,account_id,record_id,event_reference,fingerprint,input_payload,result)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(who.id,request_id,trade_id,row['account_id'],row['record_id'],reference,fingerprint(data),Jsonb(data),Jsonb(result)))
        return result
