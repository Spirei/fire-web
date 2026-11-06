"""Read-only candidate review: all writes below private identity-checked test PG."""

from decimal import Decimal as D
from decimal import localcontext
from uuid import uuid4

import pytest
from fee_source_test_helpers import import_synthetic, synthetic_snapshot
from test_fee_repairs import seed


async def test_missing_source_fee_is_not_reported_as_a_known_zero(client, admin, db):
    async with db.connection() as conn:
        await conn.execute("ALTER TABLE trade_ledger ALTER COLUMN source SET DEFAULT 'unverified_legacy'")
    _aid, filled = await seed(client, db, legacy=False)
    async with db.connection() as conn:
        await conn.execute("ALTER TABLE trade_ledger ALTER COLUMN source SET DEFAULT 'owner_recorded'")
    source = await synthetic_snapshot(client, db, filled["tradeId"])
    source["orders"][0]["input"]["fees"] = None
    from fastapi import HTTPException
    from test_fee_source_inventory import financial_rows

    before = await financial_rows(db)
    with pytest.raises(HTTPException):
        await import_synthetic(client, db, source)
    assert await financial_rows(db) == before
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM trade_fee_import_evidence")).fetchone()
    result = await client.get("/api/trading/fills", params={"recordId": filled["record"]["id"]})
    assert result.status_code == 200, result.text
    row = result.json()["items"][0]
    assert row["fees"] is None and row["feesKnown"] is False
    assert row["after_cost"] is None and row["realized_pnl"] is None
    next_fill = {**filled["record"]}
    command = {
        "requestId": str(uuid4()),
        "recordId": next_fill["id"],
        "recordRevision": next_fill["revision"],
        "side": "buy",
        "quantity": "1",
        "price": "1",
        "amount": "1",
        "fees": "0",
        "currency": "USD",
        "settlementCurrency": "USD",
        "occurredAt": "2026-09-02T12:00:00Z",
        "confirmedActualFill": True,
    }
    blocked = await client.post("/api/trading/preview", json=command)
    assert blocked.status_code == 409 and "费用权威" in blocked.text


def test_corrected_history_projection_is_independent_of_decimal_context():
    from alcor_api.fee_repair_model import effective_projection

    one, two = uuid4(), uuid4()
    rows = [
        {
            "id": one,
            "previous_trade_id": None,
            "before_record_revision": 1,
            "before_quantity": D(0),
            "before_cost": D(0),
            "after_quantity": D(3),
            "after_cost": D("1.333"),
            "side": "buy",
            "quantity": D(3),
            "price": D(1),
            "amount": D(3),
            "fees": D(1),
            "currency": "USD",
            "settlement_currency": "USD",
            "settlement_amount": None,
        },
        {
            "id": two,
            "previous_trade_id": one,
            "before_record_revision": 2,
            "before_quantity": D(3),
            "before_cost": D("1.333"),
            "after_quantity": D(2),
            "after_cost": D(1),
            "side": "sell",
            "quantity": D(1),
            "price": D(2),
            "amount": D(2),
            "fees": D(0),
            "currency": "USD",
            "settlement_currency": "USD",
            "settlement_amount": None,
        },
    ]
    record = {"trade_tip_id": two, "qty": D(2), "cost": D(1)}
    values = []
    for precision in (6, 28, 80):
        with localcontext() as ctx:
            ctx.prec = precision
            values.append(effective_projection(rows, record, {}, [])[two]["realized_pnl"])
    assert len(set(values)) == 1, [str(value) for value in values]


@pytest.mark.parametrize(
    "plan_fields", [{"revision": 1}, {"id": "", "revision": 0}, {"id": None, "revision": 1}]
)
def test_personal_fee_plan_revision_requires_a_nonempty_identity(plan_fields):
    from alcor_api.current_fees import parse_input

    raw = {
        "source": "rule_calculated",
        "confirmed": True,
        "brokerAccountId": "ba-" + ("1" * 24),
        "providerId": "longbridge",
        "ruleVersion": "2026-10-23.1",
        "instrumentKind": "us_domestic_equity",
        "plan": {
            "effectiveFrom": "2025-07-01",
            "effectiveThrough": "2026-10-23",
            "overrides": {},
            **plan_fields,
        },
    }
    with pytest.raises(ValueError):
        parse_input(raw)
