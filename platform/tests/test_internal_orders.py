"""Isolated HTTP acceptance for internal intents and authoritative PG reservations."""

import asyncio
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alcor_api.internal_orders import pending_reservations
from alcor_api.main import create_app
from alcor_api.migrate import migrate
from psycopg.conninfo import conninfo_to_dict
from psycopg.errors import CheckViolation
from test_trading import command as fill_command
from test_trading import setup
from test_trading import submit as fill_submit


@pytest_asyncio.fixture
async def oc(settings):
    await migrate(settings, conninfo_to_dict(settings.database_url.get_secret_value())["dbname"])
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client,
    ):
        response = await client.post(
            "/api/session/register", json={"username": "OrderOwner", "password": "Synthetic9Pass"}
        )
        assert response.status_code in (200, 201), response.text
        client.headers["x-csrf-token"] = response.json()["csrf"]
        yield client, app


def command(record, **changes):
    return {
        "requestId": str(uuid4()),
        "action": "create",
        "recordId": record["id"],
        "recordRevision": record["revision"],
        "side": "buy",
        "quantity": "2",
        "limitPrice": "10",
        "fees": "1",
        "confirmedInternalOrder": True,
        **changes,
    }


async def submit(client, data):
    preview = await client.post("/api/trading/orders/preview", json=data)
    assert preview.status_code == 200, preview.text
    result = await client.post(
        "/api/trading/orders/operations", json={"data": data, "preview": preview.json()["preview"]}
    )
    assert result.status_code == 200, result.text
    return result.json(), preview.json()["preview"]


async def values(app):
    async with app.state.db.connection() as conn:
        return {
            table: await (await conn.execute("SELECT * FROM " + table + " ORDER BY 1,2")).fetchall()
            for table in (
                "cash_ledger_entries",
                "portfolio_records",
                "trade_ledger",
                "internal_orders",
                "internal_order_collections",
                "internal_order_operations",
            )
        }


@pytest.mark.asyncio
async def test_pending_is_not_fill_and_cancel_releases_reservation_without_money(oc):
    client, app = oc
    account, record = await setup(client)
    before = await values(app)
    data = command(record)
    result, proof = await submit(client, data)
    order = result["order"]
    assert order["status"] == "pending" and order["reservedCash"] == "21"
    assert order["executionEnabled"] is False and order["brokerExecution"] is False
    after = await values(app)
    for table in ("cash_ledger_entries", "portfolio_records", "trade_ledger"):
        assert after[table] == before[table]
    assert (
        await client.post("/api/trading/orders/operations", json={"data": data, "preview": proof})
    ).json() == result
    assert (await client.get("/api/trading/orders/operations/" + data["requestId"])).json() == result
    async with app.state.db.connection() as conn:
        owner = after["portfolio_records"][0]["owner_id"]
        reservation = await pending_reservations(conn, owner, "real", "USD", record["id"], account)
        assert reservation["cash"] == 21 and reservation["account_cash"] == 21
    cancelled, _ = await submit(
        client, {"requestId": str(uuid4()), "action": "cancel", "orderId": order["id"], "orderRevision": 1}
    )
    assert cancelled["order"]["status"] == "cancelled" and cancelled["order"]["reservedCash"] == "0"
    async with app.state.db.connection() as conn:
        reservation = await pending_reservations(conn, owner, "real", "USD", record["id"], account)
        assert reservation["complete"] and reservation["cash"] == 0
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute("UPDATE internal_orders SET status='pending',cancelled_at=NULL")


@pytest.mark.asyncio
async def test_competing_buy_previews_reserve_only_once_and_never_overspend(oc):
    client, app = oc
    _, record = await setup(client, amount="30")
    a, b = command(record), command(record)
    pa = (await client.post("/api/trading/orders/preview", json=a)).json()["preview"]
    pb = (await client.post("/api/trading/orders/preview", json=b)).json()["preview"]
    results = await asyncio.gather(
        client.post("/api/trading/orders/operations", json={"data": a, "preview": pa}),
        client.post("/api/trading/orders/operations", json={"data": b, "preview": pb}),
    )
    assert sorted(r.status_code for r in results) == [200, 409]
    assert (await client.post("/api/trading/orders/preview", json=command(record))).status_code == 409
    assert len((await values(app))["internal_orders"]) == 1


@pytest.mark.asyncio
async def test_sell_reservation_never_invents_quantity(oc):
    client, app = oc
    _, record = await setup(client)
    filled, _ = await fill_submit(client, fill_command(record, quantity="10", amount="100"))
    record = filled["record"]
    await submit(client, command(record, side="sell", quantity="6", fees="0"))
    assert (
        await client.post(
            "/api/trading/orders/preview", json=command(record, side="sell", quantity="5", fees="0")
        )
    ).status_code == 409
    result, _ = await submit(client, command(record, side="sell", quantity="4", fees="0"))
    assert result["order"]["reservedCash"] == "0"
    snapshot = await values(app)
    assert snapshot["portfolio_records"][0]["qty"] == 10
    assert len(snapshot["trade_ledger"]) == 1


@pytest.mark.asyncio
async def test_actual_account_cash_and_simulation_are_not_interchangeable(oc):
    client, _app = oc
    _, poor = await setup(client, name="Empty", amount="0")
    await setup(client, name="Real Rich", amount="1000", code="MSFT")
    await setup(client, name="Sim Rich", amount="1000", code="NVDA", account_kind="simulated")
    assert (await client.post("/api/trading/orders/preview", json=command(poor))).status_code == 409


@pytest.mark.asyncio
@pytest.mark.parametrize("table", ["internal_orders", "internal_order_operations"])
async def test_order_failure_never_leaves_reservation_or_consumes_proof(oc, table):
    client, app = oc
    _, record = await setup(client)
    data = command(record)
    proof = (await client.post("/api/trading/orders/preview", json=data)).json()["preview"]
    before = await values(app)
    async with app.state.db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION fail_internal_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic order write fault'; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER fail_internal_order BEFORE INSERT ON "
            + table
            + " FOR EACH ROW EXECUTE FUNCTION fail_internal_order()"
        )
    assert (
        await client.post("/api/trading/orders/operations", json={"data": data, "preview": proof})
    ).status_code == 503
    assert await values(app) == before
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT consumed_at FROM internal_order_previews")).fetchone())[
            "consumed_at"
        ] is None
        await conn.execute("DROP TRIGGER fail_internal_order ON " + table)
    assert (
        await client.post("/api/trading/orders/operations", json={"data": data, "preview": proof})
    ).status_code == 200


@pytest.mark.asyncio
async def test_unknown_order_reference_blocks_new_reservations_not_cancellation(oc):
    client, app = oc
    account, record = await setup(client)
    order, _ = await submit(client, command(record))
    async with app.state.db.connection() as conn:
        owner = (await (await conn.execute("SELECT owner_id FROM internal_orders")).fetchone())["owner_id"]
        await conn.execute(
            "INSERT INTO broker_account_references VALUES(%s,%s,'order','unknown-legacy-order',NULL)",
            (owner, account),
        )
    assert (await client.post("/api/trading/orders/preview", json=command(record))).status_code == 409
    cancelled, _ = await submit(
        client,
        {"requestId": str(uuid4()), "action": "cancel", "orderId": order["order"]["id"], "orderRevision": 1},
    )
    assert cancelled["order"]["status"] == "cancelled"


@pytest.mark.asyncio
async def test_session_and_owner_bound_proof_expiry_and_payload_conflicts(oc):
    client, app = oc
    _, record = await setup(client)
    data = command(record)
    proof = (await client.post("/api/trading/orders/preview", json=data)).json()["preview"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as other:
        response = await other.post(
            "/api/session/register", json={"username": "OtherOrders", "password": "Synthetic9Pass"}
        )
        other.headers["x-csrf-token"] = response.json()["csrf"]
        assert (await other.post("/api/trading/orders/preview", json=data)).status_code == 404
        assert (
            await other.post("/api/trading/orders/operations", json={"data": data, "preview": proof})
        ).status_code == 409
        response = await other.post(
            "/api/session/login", json={"login": "OrderOwner", "password": "Synthetic9Pass"}
        )
        other.headers["x-csrf-token"] = response.json()["csrf"]
        assert (
            await other.post("/api/trading/orders/operations", json={"data": data, "preview": proof})
        ).status_code == 409
    result = await client.post("/api/trading/orders/operations", json={"data": data, "preview": proof})
    assert result.status_code == 200
    assert (
        await client.post(
            "/api/trading/orders/operations", json={"data": {**data, "quantity": "1"}, "preview": proof}
        )
    ).status_code == 409
    next_data = command(record)
    next_proof = (await client.post("/api/trading/orders/preview", json=next_data)).json()["preview"]
    async with app.state.db.connection() as conn:
        await conn.execute(
            "UPDATE internal_order_previews SET expires_at=clock_timestamp()-interval '1 second' WHERE consumed_at IS NULL"
        )
    assert (
        await client.post("/api/trading/orders/operations", json={"data": next_data, "preview": next_proof})
    ).status_code == 409


@pytest.mark.asyncio
async def test_lost_source_remains_unknown_but_cancellation_is_available(oc):
    client, app = oc
    account, record = await setup(client)
    saved, _ = await submit(client, command(record))
    async with app.state.db.connection() as conn:
        owner = (await (await conn.execute("SELECT owner_id FROM internal_orders")).fetchone())["owner_id"]
        await conn.execute("UPDATE portfolio_records SET source='unverified-import'")
        state = await pending_reservations(conn, owner, "real", "USD", record["id"], account)
        assert state["complete"] is False and state["cash"] is None
    assert (await client.post("/api/trading/orders/preview", json=command(record))).status_code == 409
    result, _ = await submit(
        client,
        {"requestId": str(uuid4()), "action": "cancel", "orderId": saved["order"]["id"], "orderRevision": 1},
    )
    assert result["order"]["status"] == "cancelled"


@pytest.mark.asyncio
async def test_smallest_decimal_reservation_cannot_overdraw_and_cash_is_unchanged(oc):
    client, app = oc
    _, record = await setup(client, amount="0.000000000000000001")
    result, _ = await submit(
        client, command(record, quantity="0.000000000000000001", limitPrice="1", fees="0")
    )
    assert result["order"]["reservedCash"] == "1E-18"
    assert (
        await client.post(
            "/api/trading/orders/preview",
            json=command(record, quantity="0.000000000000000001", limitPrice="1", fees="0"),
        )
    ).status_code == 409
    snapshot = await values(app)
    assert snapshot["cash_ledger_entries"][0]["amount"].as_tuple().exponent == -18
    assert snapshot["portfolio_records"][0]["qty"] == 0 and snapshot["trade_ledger"] == []


@pytest.mark.asyncio
async def test_waiting_identity_revocation_does_not_reserve_or_consume_proof(oc):
    client, app = oc
    _, record = await setup(client)
    data = command(record)
    proof = (await client.post("/api/trading/orders/preview", json=data)).json()["preview"]
    before = await values(app)
    owner = before["portfolio_records"][0]["owner_id"]
    async with app.state.db.connection() as blocker, blocker.transaction():
        await blocker.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("broker-accounts:" + owner,)
        )
        pending = asyncio.create_task(
            client.post("/api/trading/orders/operations", json={"data": data, "preview": proof})
        )
        async with app.state.db.connection() as observer:
            waiting = False
            for _ in range(100):
                row = await (
                    await observer.execute(
                        "SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory'"
                    )
                ).fetchone()
                if row["n"]:
                    waiting = True
                    break
                await asyncio.sleep(0.01)
            assert waiting
            await observer.execute("DELETE FROM sessions WHERE user_id=%s", (owner,))
    assert (await pending).status_code == 401
    assert await values(app) == before


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [
        {"quantity": 0.1},
        {"quantity": "0"},
        {"limitPrice": "0"},
        {"fees": None},
        {"quantity": "1e-19"},
        {"confirmedInternalOrder": False},
        {"side": "dividend"},
        {"action": "execute"},
        {"brokerExecution": True},
        {"accountKind": "simulated"},
    ],
)
async def test_unsupported_or_imprecise_orders_are_rejected(oc, changes):
    client, _app = oc
    _, record = await setup(client)
    assert (
        await client.post("/api/trading/orders/preview", json=command(record, **changes))
    ).status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("first", ["cash", "order"])
async def test_cash_withdrawal_and_order_proofs_conflict_in_both_directions(oc, first):
    from test_cash_ledger import command as cash_command

    client, _app = oc
    account, record = await setup(client, amount="30")
    cash = cash_command(account, "external_withdrawal", "20")
    order = command(record)
    cp = (await client.post("/api/cash/preview", json=cash)).json()["preview"]
    op = (await client.post("/api/trading/orders/preview", json=order)).json()["preview"]
    operations = {
        "cash": ("/api/cash/operations", {"data": cash, "preview": cp}),
        "order": ("/api/trading/orders/operations", {"data": order, "preview": op}),
    }
    path, body = operations[first]
    assert (await client.post(path, json=body)).status_code == 200
    path, body = operations["order" if first == "cash" else "cash"]
    assert (await client.post(path, json=body)).status_code == 409
    path, body = ("/api/trading/orders/preview", order) if first == "cash" else ("/api/cash/preview", cash)
    assert (await client.post(path, json=body)).status_code == 409


@pytest.mark.asyncio
async def test_cancellation_releases_cash_without_losing_historical_reference(oc):
    from test_cash_ledger import command as cash_command
    from test_cash_ledger import submit as cash_submit

    client, app = oc
    account, record = await setup(client, amount="30")
    result, _ = await submit(client, command(record))
    assert (
        await client.post("/api/cash/preview", json=cash_command(account, "external_withdrawal", "10"))
    ).status_code == 409
    await cash_submit(client, cash_command(account, "external_withdrawal", "9"))
    await submit(
        client,
        {"requestId": str(uuid4()), "action": "cancel", "orderId": result["order"]["id"], "orderRevision": 1},
    )
    receipt, _ = await cash_submit(client, cash_command(account, "external_withdrawal", "21"))
    assert receipt["balanceAfter"] == "0"
    async with app.state.db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT count(*) n FROM broker_account_references WHERE kind='order'")
            ).fetchone()
        )["n"] == 1


@pytest.mark.asyncio
async def test_actual_fill_is_recorded_despite_pending_capacity_and_does_not_fake_execution(oc):
    client, app = oc
    _, record = await setup(client, amount="30")
    result, _ = await submit(client, command(record))
    filled, _ = await fill_submit(client, fill_command(record))
    assert filled["cashAfter"] == "9"
    assert (
        await client.post("/api/trading/orders/preview", json=command(filled["record"]))
    ).status_code == 409
    state = await values(app)
    assert state["internal_orders"][0]["status"] == "pending"
    assert state["internal_orders"][0]["execution_enabled"] is False
    assert len(state["trade_ledger"]) == 1
    await submit(
        client,
        {"requestId": str(uuid4()), "action": "cancel", "orderId": result["order"]["id"], "orderRevision": 1},
    )


import test_backups as backup_tests

backup_app = backup_tests.backup_app
bc = backup_tests.bc
configured = backup_tests.configured


@pytest.mark.asyncio
async def test_pending_reservations_and_receipts_survive_restore_without_execution(
    bc, backup_app, configured
):
    from uuid import UUID

    import psycopg
    from psycopg.rows import dict_row
    from test_backups import create_capsule, execute
    from test_backups import submit as submit_backup

    account, record = await setup(bc, amount="100")
    receipt, _ = await submit(bc, command(record))
    tables = (
        "internal_orders",
        "internal_order_operations",
        "internal_order_collections",
        "cash_ledger_entries",
        "broker_account_references",
    )
    async with backup_app.state.db.connection() as conn:
        expected = {
            table: await (await conn.execute("SELECT * FROM " + table + " ORDER BY 1,2")).fetchall()
            for table in tables
        }
        owner = expected["internal_orders"][0]["owner_id"]
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
    result = await execute(backup_app, configured, UUID(job["id"]))
    assert result["sessions_revoked"]
    async with await psycopg.AsyncConnection.connect(
        configured.restore_targets[0].database_url.get_secret_value(), row_factory=dict_row
    ) as conn:
        for table in tables:
            assert (
                await (await conn.execute("SELECT * FROM " + table + " ORDER BY 1,2")).fetchall()
                == expected[table]
            )
        reserved = await pending_reservations(conn, owner, "real", "USD", record["id"], account)
        assert reserved["complete"] and reserved["cash"] == 21
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute(
                    "UPDATE internal_orders SET execution_enabled=true WHERE id=%s", (receipt["order"]["id"],)
                )


@pytest.mark.asyncio
async def test_concurrent_cash_and_order_cannot_both_spend_same_capacity(oc):
    from test_cash_ledger import command as cash_command

    client, app = oc
    account, record = await setup(client, amount="30")
    cash, order = cash_command(account, "external_withdrawal", "20"), command(record)
    cp = (await client.post("/api/cash/preview", json=cash)).json()["preview"]
    op = (await client.post("/api/trading/orders/preview", json=order)).json()["preview"]
    responses = await asyncio.gather(
        client.post("/api/cash/operations", json={"data": cash, "preview": cp}),
        client.post("/api/trading/orders/operations", json={"data": order, "preview": op}),
    )
    assert sorted(response.status_code for response in responses) == [200, 409]
    state = await values(app)
    assert len(state["internal_orders"]) + len(state["cash_ledger_entries"]) == 2


@pytest.mark.asyncio
async def test_reservation_cannot_borrow_other_account_or_real_simulated_capacity(oc):
    from test_cash_ledger import command as cash_command
    from test_cash_ledger import submit as cash_submit

    client, _app = oc
    account, record = await setup(client, amount="30")
    other, _ = await setup(client, name="Other real", amount="100")
    simulated, _ = await setup(client, name="Simulation", account_kind="simulated", amount="100")
    await submit(client, command(record))
    # A large owner aggregate never makes the reserved account's 9 available become 10.
    assert (
        await client.post("/api/cash/preview", json=cash_command(account, "external_withdrawal", "10"))
    ).status_code == 409
    await cash_submit(client, cash_command(other, "external_withdrawal", "100"))
    await cash_submit(client, cash_command(simulated, "external_withdrawal", "100", accountKind="simulated"))
    await cash_submit(client, cash_command(account, "external_withdrawal", "9"))


@pytest.mark.asyncio
async def test_actual_sell_does_not_get_rejected_or_mark_reserved_sell_filled(oc):
    client, app = oc
    _, record = await setup(client)
    purchase, _ = await fill_submit(client, fill_command(record))
    record = purchase["record"]
    reserved, _ = await submit(client, command(record, side="sell"))
    sold, _ = await fill_submit(client, fill_command(record, side="sell", fees="0"))
    assert sold["quantityAfter"] == "0"
    assert (
        await client.post("/api/trading/orders/preview", json=command(sold["record"], side="sell"))
    ).status_code == 409
    state = await values(app)
    assert state["internal_orders"][0]["status"] == "pending"
    assert len(state["trade_ledger"]) == 2
    await submit(
        client,
        {
            "requestId": str(uuid4()),
            "action": "cancel",
            "orderId": reserved["order"]["id"],
            "orderRevision": 1,
        },
    )
