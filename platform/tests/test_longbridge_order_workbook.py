from decimal import Decimal
import asyncio
import hashlib
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from alcor_api.legacy_order_export import workbook
from alcor_api.legacy_order_import import OrderImport, longbridge_execution, verified_longbridge_archive
from alcor_api.legacy_order_workbooks import LONGBRIDGE_HEADERS, LONGBRIDGE_LOG, build_xlsx, read_sheet
from test_legacy_trade_corrections import native_headers


def order_values(status="已撤销"):
    return [
        status, "US", "TEST", "Synthetic", "卖", "限价单", "120", "45", None, "USD",
        "2026-08-21 07:59:00 ET", None, "45", "80", "3600", "0", "40", "当日有效",
        "盘中+盘前盘后", None, "1171109569108168704", None,
    ]


def broker_book(events):
    return build_xlsx([("Orders", [LONGBRIDGE_HEADERS, order_values()]), ("Trade Log", [LONGBRIDGE_LOG, *events])])


def event(stamp, quantity, price="45", status="部分成交"):
    return ["1171109569108168704", "US", "TEST", "Synthetic", "卖", stamp, status, price, quantity, ""]


def test_archive_accepts_cross_day_verified_fills_and_rejects_summary_only():
    assert len(verified_longbridge_archive(broker_book([
        event("2026-08-21 09:31:01 ET", "20"),
        event("2026-08-24 09:31:01 ET", "60"),
    ]))) == 1
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as rejected:
        verified_longbridge_archive(broker_book([]))
    assert rejected.value.status_code == 422


async def test_archive_persists_once_without_posting_any_trade(client, admin, db):
    fixture = os.environ.get("ALCOR_PRIVATE_LONGBRIDGE_QA_FILE")
    raw = Path(fixture).read_bytes() if fixture else broker_book([event("2026-08-21 09:31:01 ET", "80")])
    digest = hashlib.sha256(raw).hexdigest()
    path = "/api/trading/history/import/longbridge-archive/" + digest
    headers = await native_headers(db, admin)
    assert (await client.get(path, headers=headers)).json() == {"saved": False}
    wrong = await client.put(path, content=raw+b"x", headers=headers)
    assert wrong.status_code == 422
    read_only = await native_headers(db, admin, scope="portfolio.read orders.read")
    assert (await client.put(path, content=raw, headers=read_only)).status_code in (401, 403)
    results = await asyncio.gather(*(client.put(path, content=raw, headers=headers) for _ in range(2)))
    assert [reply.status_code for reply in results] == [200, 200], [reply.text for reply in results]
    receipt = results[0].json()
    assert receipt == results[1].json() == (await client.get(path, headers=read_only)).json()
    assert receipt["saved"] and receipt["sha256"] == digest and receipt["orderCount"] == (433 if fixture else 1)
    original = await client.get("/api/trading/history/import/sources/"+receipt["sourceId"]+"/original", headers=headers)
    assert original.status_code == 200 and original.content == raw
    async with db.connection() as conn:
        for table in ("trade_ledger", "legacy_order_import_links", "cash_ledger_entries"):
            row = await (await conn.execute("SELECT count(*) n FROM " + table + " WHERE owner_id=%s", (admin,))).fetchone()
            assert row["n"] == 0


def test_cancelled_order_keeps_real_partial_executions_and_exact_original_id():
    row, = read_sheet(broker_book([
        event("2026-08-21 09:30:15 ET", "20"),
        event("2026-08-21 09:31:01 ET", "60"),
        event("2026-08-21 09:32:00 ET", "40", status="已撤销"),
    ]))
    assert row["订单号"] == "1171109569108168704"
    assert row["_hasExecution"] == "true"
    assert "费用" not in row
    assert longbridge_execution(row, "US", "TEST", "sell", "80", Decimal(3600)) == ("2026-08-21T13:31:01+00:00", "45", 2)


def test_conflicting_or_cross_day_log_requires_separate_review():
    row, = read_sheet(broker_book([event("2026-08-21 09:31:01 ET", "79")]))
    with pytest.raises(ValueError, match="股数或总额"):
        longbridge_execution(row, "US", "TEST", "sell", "80", Decimal(3600))
    row, = read_sheet(broker_book([
        event("2026-08-21 09:30:15 ET", "20"),
        event("2026-08-24 09:31:01 ET", "60"),
    ]))
    with pytest.raises(ValueError, match="跨交易日"):
        longbridge_execution(row, "US", "TEST", "sell", "80", Decimal(3600))


def test_compatible_export_preserves_available_facts_and_real_fee_for_reimport():
    order = {
        "id": "fire_1", "market": "US", "code": "TEST", "name": "Synthetic", "side": "sell", "status": "filled",
        "qty": Decimal(80), "price": Decimal(45), "amount": Decimal(3600), "fees": Decimal("1.83"),
        "filledQty": None, "executedPrice": None, "orderNo": "22460001", "originalOrderNo": "1171109569108168704",
        "tradedAt": "2026-08-21T13:31:01+00:00",
    }
    row, = read_sheet(workbook([order], False, include_fees=True, longbridge_layout=True))
    assert row["_sourceFormat"] == "fire-order-export"
    assert row["成交时间"] == order["tradedAt"] and row["委托时间"] == "—"
    assert row["费用"] == "1.83"
    assert row["原券商订单号"] == order["originalOrderNo"]
    assert row["成交金额"] == "3600"
    assert row["成交数量"] == "80" and row["成交均价"] == "45"


@pytest.mark.asyncio
async def test_preview_distinguishes_existing_time_correction_from_a_new_order_without_paid_fees():
    class Rows:
        async def execute(self, query, args):
            assert args == ("owner",)
            self.result = [{
                "id": "security", "market": "US", "code": "TEST",
                "broker_account_id": "account", "account_kind": "real",
            }] if "portfolio_records" in query else []
            return self

        async def fetchall(self):
            return self.result

    rows = read_sheet(broker_book([event("2026-08-21 09:31:01 ET", "80")]))
    existing = {
        "id": "registered-trade", "recordId": "security", "market": "US", "code": "TEST", "side": "sell",
        "status": "filled", "qty": 80, "price": 45, "amount": 3600, "tradedAt": "2026-08-21T11:59:00+00:00",
        "brokerAccountId": "account",
    }
    plan = await OrderImport(None).plan(Rows(), SimpleNamespace(id="owner"), rows, {}, {"orders": [existing]})
    row, = plan["rows"]
    assert row["state"] == "blocked" and row["requiresCorrection"]
    assert row["existingOrderId"] == "registered-trade" and row["matchBasis"] == "matching_original_terms"
    assert row["tradedAt"] == "2026-08-21T13:31:01+00:00"
    existing["tradedAt"] = row["tradedAt"]
    plan = await OrderImport(None).plan(Rows(), SimpleNamespace(id="owner"), rows, {}, {"orders": [existing]})
    assert plan["rows"][0]["state"] == "duplicate"
    plan = await OrderImport(None).plan(Rows(), SimpleNamespace(id="owner"), rows, {}, {"orders": []})
    assert plan["rows"][0]["state"] == "blocked" and "实付费用" in plan["rows"][0]["reason"]
    assert plan["rows"][0]["amount"] == "3600" and not plan["rows"][0]["feesKnown"]
