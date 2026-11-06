"""One deferred synthetic funding lifecycle; no provider, card or real account writes."""

from uuid import uuid4

from test_cash_ledger import account
from test_trading import command as trade_command
from test_trading import setup as trading_setup

ROOT = "/api/account/fund-sources"


async def test_fund_source_evidence_retirement_uuid_and_scope_workflow(client, admin, db):
    _source_account, record = await trading_setup(client, name="Synthetic independent trade book")

    async def prepare(command):
        result = await client.post(ROOT + "/preview", json=command)
        assert result.status_code == 200, result.text
        preview = result.json()
        return preview, {
            "previewId": preview["previewId"],
            "command": command,
            "cashPreview": preview["cashPreview"],
            "confirm": True,
        }

    async def submit(body):
        result = await client.post(ROOT + "/operations", json=body)
        assert result.status_code == 200, result.text
        assert result.json()["state"] == "completed"
        return result.json()

    def create(action, amount, day, *, kind="real", currency="USD", evidence=None):
        return {
            "kind": "create",
            "requestId": str(uuid4()),
            "cash": {
                "accountId": None,
                "accountKind": kind,
                "currency": currency,
                "action": action,
                "amount": amount,
                "occurredAt": f"2026-01-{day:02}T12:00:00Z",
                "note": "synthetic funding evidence",
                **({"openingBasis": "new_external_opening"} if action == "opening" else {}),
                **({"evidence": evidence} if evidence else {}),
            },
        }

    opening = create("opening", "100.000000000000000001", 2)
    opening_view, opening_body = await prepare(opening)
    assert opening_view["balanceBefore"] is None
    first = await submit(opening_body)
    assert first["source"]["amount"] == "100.000000000000000001"
    assert await submit(opening_body) == first
    assert (await client.get(ROOT + "/operations/" + opening["requestId"])).json() == first
    deposit = create("external_deposit", "25", 3)
    _, deposit_body = await prepare(deposit)
    deposited = await submit(deposit_body)
    evidence = {"reference": "synthetic statement observed by owner", "observedAt": "2026-01-04T12:00:00Z"}
    reconcile = create("reconcile_balance", "140.000000000000000001", 4, evidence=evidence)
    view, reconcile_body = await prepare(reconcile)
    assert view["balanceScope"] == "unallocated_owner_kind_currency"
    assert view["balanceBefore"] == "125.000000000000000001" and view["delta"] == "15.000000000000000000"
    reconciled = await submit(reconcile_body)
    assert reconciled["reconciliationEvidence"]["reference"] == evidence["reference"]
    assert reconciled["reconciliationEvidence"]["authority"] == "owner_declared_observation"
    retirement = {
        "kind": "delete",
        "requestId": str(uuid4()),
        "sourceId": deposited["source"]["id"],
        "sourceRevision": deposited["source"]["revision"],
        "occurredAt": "2026-01-05T12:00:00Z",
        "note": "synthetic reversal evidence",
    }
    reverse_view, reverse_body = await prepare(retirement)
    assert reverse_view["delta"] == "-25"
    reversed_result = await submit(reverse_body)
    assert reversed_result["retired"] and reversed_result["originalEntryRetained"]
    assert reversed_result["source"]["retirementRequestId"] == retirement["requestId"]
    simulated = create("opening", "1000", 6, kind="simulated")
    _, body = await prepare(simulated)
    await submit(body)
    euro = create("opening", "0", 6, currency="EUR")
    _, body = await prepare(euro)
    euro_result = await submit(body)
    assert euro_result["source"]["amount"] == "0" and euro_result["source"]["currency"] == "EUR"
    unknown_account = await account(client, name="Synthetic unknown cash account")
    unknown = create("external_deposit", "0", 7)
    unknown["cash"]["accountId"] = unknown_account
    rejected = await client.post(ROOT + "/preview", json=unknown)
    assert rejected.status_code == 409, rejected.text
    late = create("external_deposit", "1", 7)
    _, late_body = await prepare(late)
    closed = await client.post(ROOT + "/operations/" + late["requestId"] + "/close", json={})
    assert (
        closed.status_code == 200
        and closed.json()["state"] == "closed"
        and closed.json()["executed"] is False
    )
    late_result = await client.post(ROOT + "/operations", json=late_body)
    assert late_result.status_code == 200 and late_result.json() == closed.json()
    state = await client.get(ROOT + "?limit=200")
    assert state.status_code == 200, state.text
    rows = state.json()["sources"]
    assert any(row["id"] == deposited["source"]["id"] and row["retired"] for row in rows)
    assert {(row["accountKind"], row["currency"]) for row in rows} == {
        ("real", "USD"),
        ("real", "EUR"),
        ("simulated", "USD"),
    }

    async def snapshot():
        tables = (
            "portfolio_records",
            "trade_ledger",
            "trade_operations",
            "cash_ledger_entries",
            "cash_ledger_operations",
            "fund_sources",
            "fund_source_retirements",
            "fund_source_operations",
            "cash_reconciliation_evidence",
            "asset_instrument_versions",
            "asset_instrument_heads",
            "asset_instrument_operations",
            "asset_request_domains",
        )
        async with db.connection() as conn:
            return {
                table: await (
                    await conn.execute(
                        "SELECT to_jsonb(t) value FROM "
                        + table
                        + " t WHERE owner_id=%s ORDER BY to_jsonb(t)::text",
                        (admin,),
                    )
                ).fetchall()
                for table in tables
            }

    before = await snapshot()
    collision = trade_command(record, requestId=opening["requestId"], occurredAt="2026-01-08T12:00:00Z")
    trade_preview = await client.post("/api/trading/preview", json=collision)
    assert trade_preview.status_code == 200, trade_preview.text
    trade = await client.post(
        "/api/trading/operations", json={"data": collision, "preview": trade_preview.json()["preview"]}
    )
    assert trade.status_code == 409, trade.text
    assert await snapshot() == before
    instrument = await client.put(
        "/api/account/asset-instruments/" + record["id"],
        json={
            "requestId": opening["requestId"],
            "recordRevision": record["revision"],
            "revision": 0,
            "kind": "cash_equity",
            "listingStatus": "listed",
        },
    )
    assert instrument.status_code == 409, instrument.text
    assert await snapshot() == before
    async with db.connection() as conn:
        cash = await (
            await conn.execute(
                "SELECT result FROM cash_ledger_operations WHERE owner_id=%s AND request_id=%s",
                (admin, opening["requestId"]),
            )
        ).fetchone()
        assert cash["result"]["entryId"] == first["entryId"]
        original = await (
            await conn.execute(
                "SELECT id,amount FROM cash_ledger_entries WHERE owner_id=%s AND id=%s",
                (admin, deposited["entryId"]),
            )
        ).fetchone()
        assert original and original["amount"] == 25
        difference = await (
            await conn.execute(
                "SELECT registered_before,target_balance,delta,evidence FROM cash_reconciliation_evidence WHERE owner_id=%s AND request_id=%s",
                (admin, reconcile["requestId"]),
            )
        ).fetchone()
        assert str(difference["registered_before"]) == "125.000000000000000001"
        assert str(difference["target_balance"]) == "140.000000000000000001"
        assert difference["evidence"]["reference"] == evidence["reference"]
