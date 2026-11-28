"""Isolated PG HTTP tests for Web Data Management ledger reconciliation."""

import copy
from collections import Counter
from uuid import uuid4

import pytest
from psycopg.types.json import Jsonb

from alcor_api.main import create_app
from test_legacy_registered_cash import archive, reseal, sealed_book, store_packet
from test_legacy_order_projection import table
from test_legacy_trade_corrections import native_headers
from test_native_ledger import (
    ASSETS,
    LEDGER,
    SCOPES,
    TRANSACTIONS,
    _create_manual_broker_and_record,
    adopt,
    data,
    order,
    trade,
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
    assert [row["kind"] for row in after["events"]] == ["reconcile_adjustment", "repair_baseline"]


@pytest.mark.asyncio
async def test_opening_checkpoint_removes_disk_archive_dependency_and_streams_events(
    client, app, admin, db, tmp_path,
):
    import shutil
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
    web_headers = {"X-Alcor-Expected-Account": admin}

    before = (await client.get(RECONCILE, headers=web_headers)).json()
    assert before["checkpoint"]["sealed"] is False
    assert before["checkpoint"]["diskArchiveDependency"] is True
    assert before["checkpoint"]["canSeal"] is True

    # Seal opening checkpoint into single PG DB (with UUID idempotency).
    cp_req = {"requestId": str(uuid4()), "note": "固化迁移期初"}
    sealed = await client.post(RECONCILE + "/checkpoint", headers=web_headers, json=cp_req)
    assert sealed.status_code == 200, sealed.text
    cp_body = sealed.json()
    assert cp_body["checkpointVersion"] == 1
    assert cp_body["sourceAuthority"] == "sealed_legacy_registered_book_checkpoint"
    assert cp_body["cashCurrencies"] == 14
    assert cp_body["positionCount"] == 1
    replay = await client.post(RECONCILE + "/checkpoint", headers=web_headers, json=cp_req)
    assert replay.status_code == 200 and replay.json() == cp_body
    cp_mismatch = await client.post(
        RECONCILE + "/checkpoint",
        headers=web_headers,
        json={"requestId": cp_req["requestId"], "note": "不同固化备注"},
    )
    assert cp_mismatch.status_code == 409

    # Physically delete disk migration archive — reads must remain 100% intact from single PG!
    shutil.rmtree(tmp_path / "database-migrations")

    # Pre-adoption canonical cash opening + deposit after checkpoint must not double-count.
    from test_cash_ledger import command as cash_command, submit as cash_submit
    await cash_submit(client, cash_command(longbridge, amount="12110.51", currency="USD", accountKind="real"))
    await cash_submit(
        client,
        cash_command(longbridge, action="external_deposit", amount="100", currency="USD", accountKind="real"),
    )

    phone = await native_headers(db, admin, SCOPES)
    assets = await data(client.get(ASSETS, headers=phone))
    assert assets["summary"]["cashComplete"] is True
    assert assets["summary"]["totalCash"] == 12210.51
    assert assets["cash"]["sourceAuthority"] == "sealed_legacy_registered_book_checkpoint"

    baseline = await data(client.get(LEDGER, headers=phone))
    usd_base = next(row for row in baseline["cash"] if row["brokerAccountId"] is None and row["currency"] == "USD")
    assert usd_base["balance"] == "12210.51"

    # Adopt + trade (including negative diluted unitCostAfter) after disk archive removal.
    await adopt(client, phone, baseline)
    buy = order(
        googl["id"], longbridge, at="2026-10-28T22:30:00+08:00",
        quantity="15", price="300", fees="1.05", net="4501.05",
    )
    buy.update(code="GOOGL", name="Synthetic GOOGL")
    tx = trade(1, buy, "18", "33", "12210.51", "7709.46", cost="-2100.25")
    tx["cash"][0].pop("brokerAccountId")
    await data(client.post(TRANSACTIONS, headers=phone, json=tx))
    updated_ledger = await data(client.get(LEDGER, headers=phone))
    googl_after = next(row for row in updated_ledger["positions"] if row["recordId"] == googl["id"])
    assert googl_after["unitCost"] == "-2100.25"

    after = (await client.get(RECONCILE, headers=web_headers)).json()
    assert after["checkpoint"]["sealed"] is True
    assert after["checkpoint"]["diskArchiveDependency"] is False
    assert [row["kind"] for row in after["events"]] == ["trade", "adopt", "opening_checkpoint"]
    assert [row["seq"] for row in after["events"]] == [3, 2, 1]


@pytest.mark.asyncio
async def test_registered_sale_void_replays_later_native_sales_from_sealed_book(client, app, admin, db, tmp_path):
    app.state.native_ledger_enabled = True
    broker, record = await _create_manual_broker_and_record(
        client, name="Synthetic broker", code="SYN", qty="6", cost="10",
    )
    stored = sealed_book()
    packet = stored["originals"]
    wrong_sale = "sell"
    buy, sell, pending = packet["orders"]
    buy.update(qty="8", amount="80", position_qty_before="0", position_qty_after="8",
               position_cost_before="0", position_cost_after="10", order_no="original-buy")
    sell.update(price="25", position_qty_before="8", position_qty_after="6",
                position_cost_before="10", position_cost_after="10", order_no="original-sale",
                traded_at="2026-01-03T12:00:00Z")
    pending["order_no"] = "original-pending"
    packet["normalized_orders"][wrong_sale]["occurredAt"] = sell["traded_at"]
    packet["maps"]["accounts"]["source-account"] = broker
    packet["maps"]["records"]["source-record"] = record["id"]
    packet["funds"][1].update(id="fund-order-sell", direction="1")
    packet["raw_snapshot"]["tables"].update({
        "records": table([{"id": "source-record", "qty": "6", "cost": "10"}]),
        "broker_cash_order_links": table([]),
        "trade_correction_originals": table([]),
        "trade_correction_replacements": table([]),
        "app_trade_metadata": table([]),
    })
    reseal(stored)
    binding, _ = archive(tmp_path, stored)
    app.state.db.settings.backup_dir = tmp_path
    db.settings.backup_dir = tmp_path
    await store_packet(db, admin, stored, binding)
    originals = copy.deepcopy(packet)
    response = await client.post(
        RECONCILE + "/checkpoint", headers={"X-Alcor-Expected-Account": admin},
        json={"requestId": str(uuid4()), "note": "Synthetic opening checkpoint"},
    )
    assert response.status_code == 200, response.text

    headers = await native_headers(db, admin, SCOPES)
    await adopt(client, headers, await data(client.get(LEDGER, headers=headers)))
    sales = []
    for index in range(3):
        fill = order(
            record["id"], broker, at=f"2026-02-0{index + 1}T16:00:00Z",
            side="sell", quantity="1", price="12", fees="1", net="11",
        )
        fill.update(code="SYN", name=record["name"])
        tx = trade(index + 1, fill, str(6 - index), str(5 - index),
                   str(67 + 11 * index), str(78 + 11 * index), cost="10")
        tx["cash"][0].pop("brokerAccountId")
        await data(client.post(TRANSACTIONS, headers=headers, json=tx))
        sales.append(fill["tradeId"])

    orders = ASSETS + "/orders?scope=all&status=all"
    relevant = {wrong_sale, *sales}
    for path in (orders, orders + "&basis=financial"):
        before = await data(client.get(path, headers=headers))
        assert Counter(item["id"] for item in before["items"] if item["id"] in relevant) == Counter(relevant)

    preview_path = LEDGER + "/registered-void"
    await data(client.get(preview_path, headers=headers, params={"orderId": buy["id"]}), 409)
    proof = await data(client.get(preview_path, headers=headers, params={"orderId": wrong_sale}))
    assert proof["ownerId"] == admin and proof["sourceRevision"] == 4
    assert proof["sourceFingerprint"] == stored["source_sha256"]
    assert [item["id"] for item in proof["orders"]] == [wrong_sale]
    expected_position = {
        "recordId": record["id"], "market": "US", "accountMarket": "US",
        "brokerAccountId": broker, "name": record["name"], "code": "SYN",
    }
    assert proof["positions"] == [{
        **expected_position, "quantityBefore": "3", "quantityDelta": "2",
        "unitCostBefore": "10", "unitCostAfter": "10",
    }]
    assert proof["cash"] == [{"currency": "USD", "balanceBefore": "100", "delta": "-48"}]

    body = {
        "requestId": str(uuid4()), "kind": "registered_void", "baseRevision": 4,
        "registeredOrderIds": [wrong_sale],
        "positions": [{**expected_position, "quantityBefore": "3", "quantityAfter": "5", "unitCostAfter": "10"}],
        "cash": [{"currency": "USD", "balanceBefore": "100", "balanceAfter": "52"}],
    }
    receipt = await data(client.post(TRANSACTIONS, headers=headers, json=body))
    assert receipt == {
        "ownerId": admin, "requestId": body["requestId"], "kind": "registered_void", "sourceRevision": 5,
    }
    assert receipt == await data(client.get(TRANSACTIONS + "/" + body["requestId"], headers=headers))
    assert receipt == await data(client.post(TRANSACTIONS, headers=headers, json=body))
    state = await data(client.get(LEDGER, headers=headers))
    assert state["positions"] == [{**expected_position, "quantity": "5", "unitCost": "10"}]
    assert {item["brokerAccountId"]: item["balance"] for item in state["cash"] if item["currency"] == "USD"} == {
        None: "52", broker: None,
    }
    for path in (orders, orders + "&basis=financial"):
        after = await data(client.get(path, headers=headers))
        assert Counter(item["id"] for item in after["items"] if item["id"] in relevant) == Counter(sales)
    async with db.connection() as conn:
        saved = await (await conn.execute(
            "SELECT originals FROM database_migration_history_imports WHERE owner_id=%s", (admin,),
        )).fetchone()
    assert saved["originals"] == originals


@pytest.mark.asyncio
async def test_migration_0176_backfills_existing_native_ledger_transactions(pg, tmp_path):
    import psycopg
    from psycopg import sql
    from psycopg.rows import dict_row
    from alcor_api.cli import create_user
    from alcor_api.config import ROOT, Settings
    from alcor_api.migrate import migrate

    previous = tmp_path / "pre-0176"
    previous.mkdir()
    for migration in (ROOT / "migrations").glob("[0-9]*.sql"):
        if migration.name < "0176_":
            (previous / migration.name).symlink_to(migration)

    name = "alcor_test_0176_" + uuid4().hex
    with psycopg.connect(pg.get_uri(), autocommit=True) as server:
        server.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        try:
            uri = pg.get_uri(database=name)
            settings = Settings(database_url=uri, instance_id=uuid4(), environment="test", migration_dir=previous)
            await migrate(settings, name, initialize_empty=True)
            owner = await create_user(settings, "EventBackfill", "Backfill9Pass", email="backfill@example.invalid")
            r1, r2 = uuid4(), uuid4()
            with psycopg.connect(uri, row_factory=dict_row) as conn:
                conn.execute(
                    "INSERT INTO native_ledger_heads(owner_id,revision,snapshot) VALUES(%s,2,%s)",
                    (owner, Jsonb({"positions": [], "cash": [], "orders": []})),
                )
                conn.execute(
                    "INSERT INTO native_ledger_transactions(owner_id,request_id,revision,fingerprint,event,receipt) "
                    "VALUES(%s,%s,1,%s,%s,%s)",
                    (owner, r1, "1" * 64, Jsonb({"kind": "adopt"}), Jsonb({"sourceRevision": 1})),
                )
                conn.execute(
                    "INSERT INTO native_ledger_transactions(owner_id,request_id,revision,fingerprint,event,receipt) "
                    "VALUES(%s,%s,2,%s,%s,%s)",
                    (
                        owner, r2, "2" * 64,
                        Jsonb({
                            "kind": "repair_baseline", "note": "历史核准",
                            "positionUpdates": [{"code": "GOOGL", "unitCostAfter": "336.84236364"}],
                            "cashUpdates": [{"currency": "USD", "balanceAfter": "4605.92"}],
                        }),
                        Jsonb({"sourceRevision": 2}),
                    ),
                )

            settings.migration_dir = ROOT / "migrations"
            await migrate(settings, name)
            with psycopg.connect(uri, row_factory=dict_row) as conn:
                events = conn.execute(
                    "SELECT seq, ledger_revision, request_id, kind, positions, cash, note "
                    "FROM owner_ledger_events WHERE owner_id=%s ORDER BY seq",
                    (owner,),
                ).fetchall()
                assert [(e["seq"], e["ledger_revision"], e["kind"], e["note"]) for e in events] == [
                    (1, 1, "adopt", ""),
                    (2, 2, "repair_baseline", "历史核准"),
                ]
                assert events[1]["positions"] == [{"code": "GOOGL", "unitCostAfter": "336.84236364"}]
                assert events[1]["cash"] == [{"currency": "USD", "balanceAfter": "4605.92"}]
        finally:
            server.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=%s AND pid<>pg_backend_pid()",
                (name,),
            )
            server.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(name)))
