"""Composition-specific checks; no SQL31/32/37/38 or real provider access."""

from uuid import uuid4

import httpx
import pytest_asyncio
from alcor_api.main import create_app
from test_cash_ledger import account as unknown_account
from test_trading import setup


@pytest_asyncio.fixture
async def composed(settings):
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client,
    ):
        created = await client.post(
            "/api/session/register", json={"username": "ComposedIncome", "password": "Synthetic9Pass"}
        )
        assert created.status_code == 201, created.text
        client.headers["x-csrf-token"] = created.json()["csrf"]
        yield client, app


def statement(record, **changes):
    return {
        "requestId": str(uuid4()),
        "recordId": record["id"],
        "recordRevision": record["revision"],
        "eventReference": "controlled-actual-statement",
        "grossAmount": "10",
        "withheldTax": "1.5",
        "processingFee": "0.5",
        "currency": "USD",
        "settlementCurrency": "USD",
        "occurredAt": "2026-01-02T00:00:00Z",
        "confirmedActualReceipt": True,
        **changes,
    }


async def test_actual_income_commits_once_without_global_source_closure_and_owner_total_stays_unknown(
    composed,
):
    client, app = composed
    _, record = await setup(client)
    other = await unknown_account(client, "Unverified separate source")
    initial = (await client.get("/api/cash/accounts/" + other)).json()
    assert all(row["balance"] is None and not row["complete"] for row in initial["currencies"])
    command = statement(record)
    preview = await client.post("/api/dividends/receipts/preview", json=command)
    assert preview.status_code == 200, preview.text
    assert preview.json()["ownerCashAfter"] is None
    payload = {"data": command, "preview": preview.json()["preview"]}
    submitted = await client.post("/api/dividends/receipts/operations", json=payload)
    assert submitted.status_code == 200, submitted.text
    value = submitted.json()
    assert value["cashDelta"] == "8.0" and value["cashAfter"] == "1008.0" and value["ownerCashAfter"] is None
    assert value["ownerCashState"] == "unknown" and value["quantityAfter"] == "0"
    assert (await client.post("/api/dividends/receipts/operations", json=payload)).json() == value
    assert (await client.get("/api/trading/operations/" + command["requestId"])).json() == value
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM dividend_receipts")).fetchone())[
            "n"
        ] == 1
        assert (await (await conn.execute("SELECT count(*) AS n FROM trade_ledger")).fetchone())["n"] == 1
        assert not (
            await (await conn.execute("SELECT to_regclass('financial_source_closures') AS name")).fetchone()
        )["name"]


async def test_old_unproved_generic_dividend_does_not_bypass_the_same_statement_gate(composed):
    client, app = composed
    _, record = await setup(client)
    from test_trading import command

    denied = await client.post(
        "/api/trading/preview",
        json=command(record, side="dividend", quantity="0", price="0", amount="10", fees="2"),
    )
    assert denied.status_code == 409, denied.text
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM dividend_receipts")).fetchone())[
            "n"
        ] == 0
