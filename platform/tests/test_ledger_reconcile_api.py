"""Isolated PG HTTP tests for Web Data Management ledger reconciliation."""

from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb

from alcor_api.main import create_app
from test_legacy_registered_cash import archive, reseal, sealed_book, store_packet
from test_legacy_trade_corrections import native_headers
from test_native_ledger import (
    ASSETS,
    LEDGER,
    SCOPES,
    _create_manual_broker_and_record,
    data,
    order,
)

RECONCILE = "/api/personal-data-transfer/ledger-reconcile"


@pytest.fixture
def native_enabled():
    return True


@pytest.mark.asyncio
async def test_ledger_reconcile_baseline_and_manual_adjustments(client, app, admin, db, tmp_path):
    app.state.native_ledger_enabled = True
    stored = sealed_book()
    stored["originals"]["funds"][0]["amount"] = "12083.51"  # +27 = 12110.51 USD
    reseal(stored)
    binding, _ = archive(tmp_path, stored)
    app.state.db.settings.backup_dir = tmp_path
    db.settings.backup_dir = tmp_path
    await store_packet(db, admin, stored, binding)

    longbridge, googl = await _create_manual_broker_and_record(
        client, name="Longbridge", code="GOOGL", qty="18", cost="367.486", price="320",
    )
    ibkr_resp = await client.post(
        "/api/broker-accounts",
        json={
            "request_id": str(uuid4()), "name": "IBKR", "provider_id": None,
            "account_kind": "real", "currency": "USD", "currencies": ["USD"],
        },
    )
    assert ibkr_resp.status_code == 201, ibkr_resp.text
    ibkr = ibkr_resp.json()["data"]["id"]

    web_headers = {"X-Alcor-Expected-Account": admin}

    # Before adoption: read-only baseline view works cleanly.
    unadopted = await client.get(RECONCILE, headers=web_headers)
    assert unadopted.status_code == 200, unadopted.text
    body = unadopted.json()
    assert body["adopted"] is False and body["revision"] == 0
    assert body["positions"][0]["code"] == "GOOGL" and body["positions"][0]["unitCost"] == "367.486"
    usd_cash = next(row for row in body["cash"] if row["currency"] == "USD")
    assert usd_cash["balance"] == "12110.51"

    # Simulate legacy buggy adoption + GOOGL/SKUU fills.
    googl_fill = order(
        googl["id"], longbridge, at="2026-10-28T22:30:00+08:00",
        quantity="15", price="300", fees="1.05", net="4501.05",
    )
    googl_fill.update(code="GOOGL", name="Synthetic GOOGL")
    skuu_fill = order(
        "skuu-reconcile-rec", ibkr, at="2026-11-20T22:30:00+08:00",
        quantity="300", price="10.0068", fees="1.50", net="3003.54",
    )
    skuu_fill.update(code="SKUU", name="Synthetic SKUU")
    buggy = {
        "positions": [
            {"recordId": googl["id"], "brokerAccountId": longbridge, "market": "US", "accountMarket": "US",
             "code": "GOOGL", "name": "Synthetic GOOGL", "quantity": "33", "unitCost": None},
            {"recordId": "skuu-reconcile-rec", "brokerAccountId": ibkr, "market": "US", "accountMarket": "US",
             "code": "SKUU", "name": "Synthetic SKUU", "quantity": "300", "unitCost": "10.0118"},
        ],
        "cash": [
            {"currency": "USD", "brokerAccountId": None, "balance": None},
            {"currency": "USD", "brokerAccountId": longbridge, "balance": None},
            {"currency": "USD", "brokerAccountId": ibkr, "balance": None},
        ],
        "orders": [googl_fill, skuu_fill],
        "orderHistory": {},
        "orderNumbers": {googl_fill["tradeId"]: "0000000001", skuu_fill["tradeId"]: "0000000002"},
    }
    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            "INSERT INTO native_ledger_heads(owner_id,revision,snapshot) VALUES(%s,3,%s)",
            (admin, Jsonb(buggy)),
        )

    # Read detects baseline gaps accurately.
    state = (await client.get(RECONCILE, headers=web_headers)).json()
    assert state["adopted"] is True and state["revision"] == 3
    assert state["baselineDiff"]["hasGaps"] is True
    pos_by_code = {item["code"]: item for item in state["positions"]}
    assert pos_by_code["GOOGL"]["unitCost"] is None
    assert pos_by_code["GOOGL"]["suggestedUnitCost"] == "336.84236364"
    usd_row = next(row for row in state["cash"] if row["currency"] == "USD")
    assert usd_row["balance"] is None and usd_row["suggestedBalance"] == "4605.92"

    # Stale revision rejected with 409.
    stale = await client.post(
        RECONCILE + "/baseline",
        headers=web_headers,
        json={"requestId": str(uuid4()), "baseRevision": 2},
    )
    assert stale.status_code == 409

    # 1-click baseline apply + idempotent replay + conflict on mutated payload.
    base_req_id = str(uuid4())
    base_payload = {"requestId": base_req_id, "baseRevision": 3, "note": "一键基线核准"}
    applied = await client.post(RECONCILE + "/baseline", headers=web_headers, json=base_payload)
    assert applied.status_code == 200, applied.text
    receipt = applied.json()
    assert receipt["sourceRevision"] == 4
    assert receipt["positionUpdates"] == [{
        "recordId": googl["id"], "market": "US", "code": "GOOGL",
        "unitCostBefore": None, "unitCostAfter": "336.84236364",
    }]
    replay = await client.post(RECONCILE + "/baseline", headers=web_headers, json=base_payload)
    assert replay.status_code == 200 and replay.json() == receipt
    mismatch = await client.post(
        RECONCILE + "/baseline",
        headers=web_headers,
        json={"requestId": base_req_id, "baseRevision": 3, "note": "不同备注"},
    )
    assert mismatch.status_code == 409
    no_gaps = await client.post(
        RECONCILE + "/baseline",
        headers=web_headers,
        json={"requestId": str(uuid4()), "baseRevision": 4},
    )
    assert no_gaps.status_code == 400

    # Manual adjustment (supports negative diluted cost & cash update) + App projection sync.
    adj_req_id = str(uuid4())
    adj_payload = {
        "requestId": adj_req_id,
        "baseRevision": 4,
        "note": "核对券商结单",
        "positions": [{"recordId": googl["id"], "unitCost": "-12.5"}],
        "cash": [{"currency": "USD", "balance": "5000.25"}],
    }
    adjusted = await client.post(RECONCILE + "/adjust", headers=web_headers, json=adj_payload)
    assert adjusted.status_code == 200, adjusted.text
    adj_receipt = adjusted.json()
    assert adj_receipt["sourceRevision"] == 5
    adj_replay = await client.post(RECONCILE + "/adjust", headers=web_headers, json=adj_payload)
    assert adj_replay.status_code == 200 and adj_replay.json() == adj_receipt

    # No-op rejected with 400.
    noop = await client.post(
        RECONCILE + "/adjust",
        headers=web_headers,
        json={
            "requestId": str(uuid4()), "baseRevision": 5,
            "positions": [{"recordId": googl["id"], "unitCost": "-12.5"}], "cash": [],
        },
    )
    assert noop.status_code == 400

    # Wrong expected account rejected with 403.
    wrong_owner = await client.get(RECONCILE, headers={"X-Alcor-Expected-Account": "other-user"})
    assert wrong_owner.status_code == 403

    # App endpoints immediately see sourceRevision 5 and reconciled figures.
    phone = await native_headers(db, admin, SCOPES)
    ledger = await data(client.get(LEDGER, headers=phone))
    assert ledger["sourceRevision"] == 5
    googl_pos = next(item for item in ledger["positions"] if item["code"] == "GOOGL")
    assert googl_pos["unitCost"] == "-12.5"
    summary = await data(client.get(ASSETS + "/summary", headers=phone))
    assert summary["summary"]["cashComplete"] is True
    assert summary["summary"]["totalCash"] == 5000.25

    after = (await client.get(RECONCILE, headers=web_headers)).json()
    assert after["revision"] == 5 and after["baselineDiff"]["hasGaps"] is False
    assert [row["kind"] for row in after["recentAdjustments"]] == ["reconcile_adjustment", "repair_baseline"]
