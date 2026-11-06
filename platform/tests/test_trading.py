"""Actual PostgreSQL HTTP checks; all fills are synthetic internal records, never broker executions."""

import asyncio
from decimal import Decimal
from uuid import uuid4

import httpx
import pytest
from alcor_api.cli import create_user
from psycopg.errors import CheckViolation
from test_cash_ledger import command as cash_command
from test_cash_ledger import submit as cash_submit


async def setup(
    client,
    *,
    name="Trade account",
    account_kind="real",
    currency="USD",
    amount="1000",
    market="US",
    account_market="",
    code="AAPL",
    qty="0",
    cost="0",
):
    created = await client.post(
        "/api/broker-accounts",
        json={
            "request_id": str(uuid4()),
            "name": name,
            "provider_id": None,
            "account_kind": account_kind,
            "currency": currency,
            "currencies": [currency],
        },
    )
    assert created.status_code == 201, created.text
    account = created.json()["data"]["id"]
    await cash_submit(
        client, cash_command(account, amount=amount, currency=currency, accountKind=account_kind)
    )
    preview = await client.post(
        "/api/portfolio/records/preview",
        json={
            "kind": "create",
            "data": {
                "name": "Synthetic security",
                "code": code,
                "market": market,
                "accountMarket": account_market,
                "price": None,
                "qty": qty,
                "cost": cost,
                "group": "",
                "note": "",
                "brokerAccountId": account,
            },
        },
    )
    assert preview.status_code == 200, preview.text
    created = await client.post(
        "/api/portfolio/records/confirm",
        json={"previewId": preview.json()["previewId"], "requestId": str(uuid4())},
    )
    assert created.status_code == 200, created.text
    return account, created.json()["record"]


def command(record, **changes):
    return {
        "requestId": str(uuid4()),
        "recordId": record["id"],
        "recordRevision": record["revision"],
        "side": "buy",
        "quantity": "2",
        "price": "10",
        "amount": "20",
        "fees": "1",
        "currency": "USD",
        "settlementCurrency": "USD",
        "occurredAt": "2026-01-02T00:00:00Z",
        "confirmedActualFill": True,
        **changes,
    }


async def submit(client, data):
    preview = await client.post("/api/trading/preview", json=data)
    assert preview.status_code == 200, preview.text
    result = await client.post(
        "/api/trading/operations", json={"data": data, "preview": preview.json()["preview"]}
    )
    assert result.status_code == 200, result.text
    return result.json(), preview.json()["preview"]


async def economic(db, owner):
    values = {}
    async with db.connection() as conn:
        for table in (
            "portfolio_records",
            "portfolio_record_collections",
            "cash_ledger_accounts",
            "cash_ledger_entries",
            "cash_ledger_collections",
            "trade_ledger",
            "trade_operations",
            "broker_account_references",
        ):
            values[table] = await (
                await conn.execute("SELECT * FROM " + table + " WHERE owner_id=%s ORDER BY 1,2", (owner,))
            ).fetchall()
    return values


@pytest.mark.asyncio
async def test_actual_fill_cash_position_receipt_and_read_only_preview(client, admin, db):
    account, record = await setup(client)
    data = command(record)
    before = await economic(db, admin)
    preview = await client.post("/api/trading/preview", json=data)
    assert preview.status_code == 200, preview.text
    assert await economic(db, admin) == before
    result, proof = await submit(client, data)
    assert result["brokerExecution"] is False and result["source"] == "owner_recorded"
    assert result["cashDelta"] == "-21" and result["cashAfter"] == "979"
    assert result["record"]["qty"] == "2" and Decimal(result["record"]["cost"]) == Decimal("10.500")
    assert result["record"]["historyState"] == "has_trades"
    assert (
        await client.post("/api/trading/operations", json={"data": data, "preview": proof})
    ).json() == result
    assert (await client.get("/api/trading/operations/" + data["requestId"])).json() == result
    assert (
        await client.post("/api/trading/operations", json={"data": {**data, "fees": "0"}, "preview": proof})
    ).status_code == 409
    fills = (await client.get("/api/trading/fills", params={"recordId": record["id"]})).json()["items"]
    assert len(fills) == 1 and fills[0]["amount"] == "20" and fills[0]["fees"] == "1"
    # A known filled reference is not a pending order and must not disable later cash operations.
    cash, _ = await cash_submit(
        client, cash_command(account, "external_withdrawal", "9", occurredAt="2026-01-03T00:00:00Z")
    )
    assert cash["balanceAfter"] == "970"
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM trade_ledger")).fetchone())["n"] == 1
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) n FROM cash_ledger_entries WHERE source_trade_id IS NOT NULL"
                )
            ).fetchone()
        )["n"] == 1


@pytest.mark.asyncio
async def test_sell_dividend_original_amount_and_over_sell_guard(client, admin):
    _, record = await setup(client)
    buy, _ = await submit(client, command(record))
    sell, _ = await submit(
        client,
        command(
            buy["record"],
            side="sell",
            quantity="1",
            price="12",
            amount="12",
            fees="0",
            occurredAt="2026-01-03T00:00:00Z",
        ),
    )
    assert sell["cashAfter"] == "991" and sell["record"]["qty"] == "1"
    assert Decimal(sell["record"]["cost"]) == Decimal("9.000")
    assert Decimal(sell["realizedPnl"]) == Decimal("1.50")
    dividend = await actual_dividend(client, sell["record"], "2.37", "0", "2026-01-04T00:00:00Z")
    assert dividend["cashDelta"] == "2.37" and dividend["cashAfter"] == "993.37"
    assert dividend["record"]["qty"] == "1" and Decimal(dividend["record"]["cost"]) == Decimal(9)
    too_many = command(
        dividend["record"],
        side="sell",
        quantity="2",
        price="12",
        amount="24",
        fees="0",
        occurredAt="2026-01-05T00:00:00Z",
    )
    assert (await client.post("/api/trading/preview", json=too_many)).status_code == 409
    malformed = command(dividend["record"], side="dividend", quantity="1", price="2.37", amount="2.37")
    rejected = await client.post("/api/trading/preview", json=malformed)
    assert rejected.status_code == 409
    assert "单据事件编号" in rejected.json()["error"]["message"]


@pytest.mark.asyncio
async def test_selected_account_cash_never_borrows_other_kind_or_other_account(client, admin):
    _, poor = await setup(client, name="Poor real", amount="0")
    await setup(client, name="Rich real", amount="1000000", code="MSFT")
    await setup(client, name="Rich simulation", amount="1000000", account_kind="simulated", code="NVDA")
    assert (await client.post("/api/trading/preview", json=command(poor))).status_code == 409
    _, simulated = await setup(
        client, name="Funded simulation", account_kind="simulated", amount="100", code="AMD"
    )
    result, _ = await submit(client, command(simulated))
    assert result["accountKind"] == "simulated" and result["cashAfter"] == "79"
    assert result["ownerCashAfter"] == "1000079"


@pytest.mark.asyncio
async def test_stock_connect_uses_explicit_cny_net_without_double_hkd_fee(client, admin):
    _, record = await setup(client, currency="CNY", market="HK", account_market="CN", code="00700")
    data = command(record, currency="HKD", settlementCurrency="CNY", settlementAmount="19.27")
    result, _ = await submit(client, data)
    assert (
        result["cashCurrency"] == "CNY"
        and result["cashDelta"] == "-19.27"
        and result["cashAfter"] == "980.73"
    )
    assert Decimal(result["record"]["cost"]) == Decimal("10.500")
    for change, status in [
        ({"settlementAmount": None}, 422),
        ({"settlementCurrency": "HKD", "settlementAmount": "21"}, 409),
    ]:
        assert (
            await client.post(
                "/api/trading/preview",
                json={
                    **command(
                        result["record"], currency="HKD", settlementCurrency="CNY", settlementAmount="19.27"
                    ),
                    **change,
                },
            )
        ).status_code == status


@pytest.mark.asyncio
async def test_unknown_history_official_and_old_time_are_not_guessed(client, admin, db):
    _account, record = await setup(client, qty="10", cost="5")
    assert (await client.post("/api/trading/preview", json=command(record))).status_code == 409
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE portfolio_records SET qty=0,history_state='unknown' WHERE owner_id=%s AND id=%s",
            (admin, record["id"]),
        )
    record = (await client.get("/api/portfolio/records/" + record["id"])).json()["record"]
    assert (await client.post("/api/trading/preview", json=command(record))).status_code == 409
    _, known = await setup(client, name="Known zero", code="MSFT")
    assert (
        await client.post("/api/trading/preview", json=command(known, occurredAt="2025-12-31T00:00:00Z"))
    ).status_code == 409
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE broker_accounts SET holding_source='official' WHERE id=%s", (known["brokerAccountId"],)
        )
    assert (await client.post("/api/trading/preview", json=command(known))).status_code == 409


@pytest.mark.asyncio
async def test_concurrent_proofs_and_expiry_leave_one_actual_fill(client, admin, db):
    _, record = await setup(client)
    a, b = command(record), command(record)
    pa = (await client.post("/api/trading/preview", json=a)).json()["preview"]
    pb = (await client.post("/api/trading/preview", json=b)).json()["preview"]
    result = await asyncio.gather(
        client.post("/api/trading/operations", json={"data": a, "preview": pa}),
        client.post("/api/trading/operations", json={"data": b, "preview": pb}),
    )
    assert sorted(r.status_code for r in result) == [200, 409]
    row = next(r.json()["record"] for r in result if r.status_code == 200)
    exp = command(row)
    proof = (await client.post("/api/trading/preview", json=exp)).json()["preview"]
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE trade_previews SET expires_at=clock_timestamp()-interval '1 second' WHERE consumed_at IS NULL"
        )
    assert (
        await client.post("/api/trading/operations", json={"data": exp, "preview": proof})
    ).status_code == 409
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM trade_ledger")).fetchone())["n"] == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "table", ["trade_ledger", "portfolio_records", "cash_ledger_entries", "trade_operations"]
)
async def test_every_write_failure_rolls_back_position_cash_receipt_and_proof(client, admin, db, table):
    _, record = await setup(client)
    data = command(record)
    proof = (await client.post("/api/trading/preview", json=data)).json()["preview"]
    before = await economic(db, admin)
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_fill_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic fill failure'; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_fill_write BEFORE INSERT OR UPDATE ON "
            + table
            + " FOR EACH ROW EXECUTE FUNCTION reject_fill_write()"
        )
    assert (
        await client.post("/api/trading/operations", json={"data": data, "preview": proof})
    ).status_code == 503
    assert await economic(db, admin) == before
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT consumed_at FROM trade_previews")).fetchone())[
            "consumed_at"
        ] is None
        await conn.execute("DROP TRIGGER reject_fill_write ON " + table)
    assert (await client.get("/api/trading/operations/" + data["requestId"])).status_code == 404
    assert (
        await client.post("/api/trading/operations", json={"data": data, "preview": proof})
    ).status_code == 200


@pytest.mark.asyncio
async def test_cross_owner_cross_session_tampering_and_csrf_rejected(client, admin, app, settings):
    _, record = await setup(client)
    data = command(record)
    proof = (await client.post("/api/trading/preview", json=data)).json()["preview"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as other:
        await create_user(settings, "TradeOtherOwner", "Synthetic9Pass")
        login = await other.post(
            "/api/session/login", json={"login": "TradeOtherOwner", "password": "Synthetic9Pass"}
        )
        other.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await other.post("/api/trading/preview", json=data)).status_code == 404
        assert (await other.get("/api/trading/fills", params={"recordId": record["id"]})).status_code == 404
        assert (
            await other.post("/api/trading/operations", json={"data": data, "preview": proof})
        ).status_code == 409
        login = await other.post(
            "/api/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"}
        )
        other.headers["x-csrf-token"] = login.json()["csrf"]
        assert (
            await other.post("/api/trading/operations", json={"data": data, "preview": proof})
        ).status_code == 409
    assert (
        await client.post(
            "/api/trading/operations", json={"data": data, "preview": proof}, headers={"x-csrf-token": ""}
        )
    ).status_code == 403
    assert (
        await client.post(
            "/api/trading/operations", json={"data": {**data, "amount": "21"}, "preview": proof}
        )
    ).status_code == 422


@pytest.mark.asyncio
async def test_fill_projection_and_original_evidence_cannot_be_edited_directly(client, admin, db):
    _, record = await setup(client)
    result, _ = await submit(client, command(record))
    async with db.connection() as conn:
        for statement in (
            "UPDATE portfolio_records SET qty=99",
            "UPDATE portfolio_records SET cost=1",
            "UPDATE portfolio_records SET broker_account_id=NULL",
            "UPDATE trade_ledger SET fees=0",
            "DELETE FROM trade_ledger",
        ):
            with pytest.raises(CheckViolation):
                async with conn.transaction():
                    await conn.execute(statement)
    edited = {
        k: result["record"][k] for k in ("name", "code", "market", "price", "cost", "qty", "group", "note")
    }
    edited["qty"] = "99"
    response = await client.post(
        "/api/portfolio/records/preview",
        json={
            "kind": "update",
            "recordId": record["id"],
            "revision": result["record"]["revision"],
            "data": edited,
        },
    )
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_small_quantity_and_unknown_cost_remain_exact(client, admin):
    _, record = await setup(client, cost=None)
    result, _ = await submit(
        client,
        command(record, quantity="0.000000000000000001", price="1", amount="0.000000000000000001", fees="0"),
    )
    assert Decimal(result["record"]["qty"]) == Decimal("1e-18")
    assert result["record"]["cost"] is None and result["realizedPnl"] is None
    assert Decimal(result["cashAfter"]) == Decimal("999.999999999999999999")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [
        {"amount": "21"},
        {"fees": None},
        {"fees": 0.1},
        {"quantity": "1e-19"},
        {"settlementAmount": "1"},
        {"confirmedActualFill": False},
        {"requestId": 1},
        {"occurredAt": 1},
        {"recordRevision": True},
    ],
)
async def test_invalid_or_implicit_financial_input_is_not_accepted(client, admin, changes):
    _, record = await setup(client)
    assert (await client.post("/api/trading/preview", json=command(record, **changes))).status_code == 422


@pytest.mark.asyncio
async def test_cash_changed_after_preview_and_uuid_collision_are_conflicts(client, admin):
    account, record = await setup(client)
    data = command(record)
    proof = (await client.post("/api/trading/preview", json=data)).json()["preview"]
    other = cash_command(account, "external_deposit", "1")
    await cash_submit(client, other)
    assert (
        await client.post("/api/trading/operations", json={"data": data, "preview": proof})
    ).status_code == 409
    collision = command(record, requestId=other["requestId"])
    proof = (await client.post("/api/trading/preview", json=collision)).json()["preview"]
    assert (
        await client.post("/api/trading/operations", json={"data": collision, "preview": proof})
    ).status_code == 409
    free_buy = command(record, price="0", amount="0", fees="0")
    assert (await client.post("/api/trading/preview", json=free_buy)).status_code == 422


@pytest.mark.asyncio
async def test_identity_revocation_while_waiting_cannot_commit_fill(client, admin, db):
    _, record = await setup(client)
    data = command(record)
    proof = (await client.post("/api/trading/preview", json=data)).json()["preview"]
    before = await economic(db, admin)
    async with db.connection() as blocker, blocker.transaction():
        await blocker.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("broker-accounts:" + admin,)
        )
        pending = asyncio.create_task(
            client.post("/api/trading/operations", json={"data": data, "preview": proof})
        )
        async with db.connection() as observer:
            waiting = False
            for _ in range(100):
                row = await (
                    await observer.execute(
                        "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() "
                        "AND wait_event_type='Lock' AND wait_event='advisory'"
                    )
                ).fetchone()
                if row["n"]:
                    waiting = True
                    break
                await asyncio.sleep(0.01)
            assert waiting
            await observer.execute("DELETE FROM sessions WHERE user_id=%s", (admin,))
    assert (await pending).status_code == 401
    assert await economic(db, admin) == before


@pytest.mark.asyncio
async def test_fill_pages_use_real_revision_and_preserve_full_history(client, admin):
    _, record = await setup(client)
    first, _ = await submit(client, command(record))
    second, _ = await submit(client, command(first["record"], occurredAt="2026-01-03T00:00:00Z"))
    page = (await client.get("/api/trading/fills", params={"recordId": record["id"], "limit": 1})).json()
    assert page["total"] == 2 and len(page["items"]) == 1 and page["nextOffset"] == 1
    next_page = (
        await client.get(
            "/api/trading/fills",
            params={
                "recordId": record["id"],
                "limit": 1,
                "offset": 1,
                "recordRevision": page["recordRevision"],
            },
        )
    ).json()
    assert next_page["nextOffset"] is None and next_page["items"][0]["id"] != page["items"][0]["id"]
    await submit(client, command(second["record"], occurredAt="2026-01-04T00:00:00Z"))
    assert (
        await client.get(
            "/api/trading/fills",
            params={
                "recordId": record["id"],
                "limit": 1,
                "offset": 1,
                "recordRevision": page["recordRevision"],
            },
        )
    ).status_code == 409


import test_backups as backup_tests

backup_app = backup_tests.backup_app
bc = backup_tests.bc
configured = backup_tests.configured


@pytest.mark.asyncio
async def test_fills_cash_projection_and_receipts_survive_full_restore(bc, backup_app, configured):
    from uuid import UUID

    import psycopg
    from psycopg.rows import dict_row
    from test_backups import create_capsule, execute
    from test_backups import submit as submit_backup

    _, record = await setup(bc)
    first, _ = await submit(bc, command(record))
    await submit(
        bc,
        command(
            first["record"],
            side="sell",
            quantity="1",
            amount="10",
            fees="0",
            occurredAt="2026-01-03T00:00:00Z",
        ),
    )
    async with backup_app.state.db.connection() as conn:
        owner = (await (await conn.execute("SELECT id FROM users WHERE username='BackupQA'")).fetchone())[
            "id"
        ]
    expected = await economic(backup_app.state.db, owner)
    backup_id, _ = await create_capsule(bc, backup_app, configured)
    preview = await bc.get(
        "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert preview.status_code == 200, preview.text
    job, _ = await submit_backup(
        bc,
        "backup.restore",
        backup_id=backup_id,
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    await execute(backup_app, configured, UUID(job["id"]))
    target = configured.restore_targets[0]
    async with await psycopg.AsyncConnection.connect(
        target.database_url.get_secret_value(), row_factory=dict_row
    ) as conn:
        for table, rows in expected.items():
            restored = await (
                await conn.execute("SELECT * FROM " + table + " WHERE owner_id=%s ORDER BY 1,2", (owner,))
            ).fetchall()
            assert restored == rows, table
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute("UPDATE portfolio_records SET qty=100")


@pytest.mark.asyncio
async def test_repeated_sales_realize_economic_profit_once_despite_diluted_display_cost(client, admin):
    _, record = await setup(client)
    buy, _ = await submit(client, command(record, quantity="10", price="10", amount="100", fees="0"))
    first, _ = await submit(
        client, command(buy["record"], side="sell", quantity="5", price="20", amount="100", fees="0")
    )
    # Display cost is diluted down to zero, but the remaining economic acquisition basis is still 10/share.
    assert Decimal(first["record"]["cost"]) == Decimal(0)
    second, _ = await submit(
        client, command(first["record"], side="sell", quantity="5", price="20", amount="100", fees="0")
    )
    assert Decimal(first["realizedPnl"]) == Decimal(50)
    assert Decimal(second["realizedPnl"]) == Decimal(50)
    assert Decimal(second["cashAfter"]) == Decimal(1100)
    assert second["realizedPnlCurrency"] == "USD" and second["realizedPnlBasis"] == "economic_moving_average"


@pytest.mark.asyncio
async def test_same_time_reverse_random_ids_preserve_fill_causality_and_economics(client, admin, monkeypatch):
    from uuid import UUID

    from alcor_api import trading

    _, record = await setup(client)
    ids = iter(UUID(int=n) for n in [60, 61, 40, 41, 20, 21])
    monkeypatch.setattr(trading, "uuid4", lambda: next(ids))
    buy, _ = await submit(client, command(record, quantity="10", price="10", amount="100", fees="0"))
    first, _ = await submit(
        client, command(buy["record"], side="sell", quantity="5", price="20", amount="100", fees="0")
    )
    second, _ = await submit(
        client, command(first["record"], side="sell", quantity="5", price="20", amount="100", fees="0")
    )
    rows = (await client.get("/api/trading/fills", params={"recordId": record["id"]})).json()["items"]
    assert [row["side"] for row in rows] == ["buy", "sell", "sell"]
    assert [row["id"] for row in rows] == [buy["tradeId"], first["tradeId"], second["tradeId"]]
    assert sum(Decimal(row["realized_pnl"]) for row in rows if row["realized_pnl"] is not None) == Decimal(
        100
    )


@pytest.mark.asyncio
async def test_trade_uuid_cannot_be_reused_as_a_new_cash_deposit(client, admin, db):
    account, record = await setup(client)
    fill, _ = await submit(client, command(record))
    before = await economic(db, admin)
    data = cash_command(
        account, "external_deposit", "5", requestId=fill["requestId"], occurredAt="2026-01-03T00:00:00Z"
    )
    preview = await client.post("/api/cash/preview", json=data)
    assert preview.status_code == 200
    result = await client.post(
        "/api/cash/operations", json={"data": data, "preview": preview.json()["preview"]}
    )
    assert result.status_code == 409
    assert await economic(db, admin) == before
    assert (await client.get("/api/trading/operations/" + fill["requestId"])).json() == fill


@pytest.mark.asyncio
async def test_economic_profit_with_fees_and_actual_dividend_agrees_with_final_cash(client, admin):
    _, record = await setup(client)
    buy, _ = await submit(client, command(record, quantity="10", price="10", amount="100", fees="1"))
    first, _ = await submit(
        client, command(buy["record"], side="sell", quantity="5", price="20", amount="100", fees="2")
    )
    dividend = await actual_dividend(client, first["record"], "3", "0.2", "2026-01-02T00:00:00Z")
    second, _ = await submit(
        client, command(dividend["record"], side="sell", quantity="5", price="20", amount="100", fees="2")
    )
    assert Decimal(first["realizedPnl"]) == Decimal("47.5")
    assert Decimal(second["realizedPnl"]) == Decimal("47.5")
    assert Decimal(dividend["realizedPnl"]) == Decimal("2.8")
    realized = sum(Decimal(fill["realizedPnl"]) for fill in (first, dividend, second))
    assert realized == Decimal("97.8")
    assert Decimal(second["cashAfter"]) - Decimal(1000) == realized


async def actual_dividend(client, record, gross, fee, occurred_at):
    from test_notification_composition import statement
    data = statement(record, eventReference=str(uuid4()), grossAmount=gross, withheldTax="0", processingFee=fee, occurredAt=occurred_at)
    preview = await client.post("/api/dividends/receipts/preview", json=data)
    assert preview.status_code == 200, preview.text
    result = await client.post("/api/dividends/receipts/operations", json={"data": data, "preview": preview.json()["preview"]})
    assert result.status_code == 200, result.text
    assert (await client.get("/api/dividends/receipts/operations/" + data["requestId"])).json() == result.json()
    return result.json()
