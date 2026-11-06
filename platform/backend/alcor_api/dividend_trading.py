"""Candidate facade: generic trading and dedicated receipt routes share event identity."""

from decimal import localcontext

from fastapi import HTTPException

from alcor_api.dividend_receipts import DividendReceipts
from alcor_api.trading import Trading, exact, normalize


def statement_command(raw):
    detail = raw.get("dividendReceipt")
    if not isinstance(detail, dict) or set(detail) != {
        "eventReference",
        "withheldTax",
        "processingFee",
        "confirmedActualReceipt",
    }:
        raise HTTPException(409, "股息实际到账须提供单据事件编号和税费明细，请更新客户端")
    trade = normalize({key: value for key, value in raw.items() if key != "dividendReceipt"})
    try:
        with localcontext() as context:
            context.prec = 80
            fees = exact(detail["withheldTax"]) + exact(detail["processingFee"])
        if fees != exact(trade["fees"]):
            raise ValueError()
    except ValueError:
        raise HTTPException(422, "原币费用与股息税费明细不一致") from None
    return {
        key: trade[key]
        for key in (
            "requestId",
            "recordId",
            "recordRevision",
            "currency",
            "settlementCurrency",
            "settlementAmount",
            "occurredAt",
            "note",
        )
    } | {"grossAmount": trade["amount"], **detail}


class DividendAwareTrading:
    def __init__(self, db):
        self.trades, self.dividends = Trading(db), DividendReceipts(db)

    async def preview(self, who, raw):
        if isinstance(raw, dict) and raw.get("side") == "dividend":
            return await self.dividends.preview(who, statement_command(raw))
        return await self.trades.preview(who, raw)

    async def submit(self, who, raw, proof):
        if isinstance(raw, dict) and raw.get("side") == "dividend":
            return await self.dividends.submit(who, statement_command(raw), proof)
        return await self.trades.submit(who, raw, proof)

    async def receipt(self, who, request_id):
        try:
            return await self.dividends.receipt(who, request_id)
        except HTTPException as exc:
            if exc.status_code != 404:
                raise
        # Existing generic/legacy receipts remain readable without invented statement metadata.
        return await self.trades.receipt(who, request_id)

    async def list(self, who, record_id, **pagination):
        return await self.trades.list(who, record_id, **pagination)
