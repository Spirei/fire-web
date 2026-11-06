from legacy_fee_source_fixture import old_pg
from decimal import Decimal
from uuid import uuid4

import pytest
from psycopg.errors import CheckViolation
from test_fee_plans import account


async def operation(client, path, data):
    preview = await client.post(path + "/preview", json=data)
    assert preview.status_code == 200, preview.text
    result = await client.post(
        path + "/operations", json={"data": data, "preview": preview.json()["preview"]}
    )
    assert result.status_code == 200, result.text
    return result.json()


async def seed(client, db, legacy=True, *, explicit_zero=False):
    aid = await account(client)
    await operation(
        client,
        "/api/cash",
        {
            "requestId": str(uuid4()),
            "accountId": aid,
            "accountKind": "real",
            "currency": "USD",
            "action": "opening",
            "amount": "1000",
            "occurredAt": "2026-01-01T00:00:00Z",
            "openingBasis": "new_external_opening",
        },
    )
    preview = await client.post(
        "/api/portfolio/records/preview",
        json={
            "kind": "create",
            "data": {
                "name": "Synthetic fee asset",
                "code": "TEST",
                "market": "US",
                "accountMarket": "",
                "price": None,
                "qty": "0",
                "cost": "0",
                "group": "",
                "note": "",
                "brokerAccountId": aid,
            },
        },
    )
    created = await client.post(
        "/api/portfolio/records/confirm",
        json={"previewId": preview.json()["previewId"], "requestId": str(uuid4())},
    )
    record = created.json()["record"]
    # Isolated synthetic historical source only; not an import API or real relabelling.
    if legacy:
        async with db.connection() as conn:
            await conn.execute("ALTER TABLE trade_ledger ALTER COLUMN source SET DEFAULT 'unverified_legacy'")
    data = {
        "requestId": str(uuid4()),
        "recordId": record["id"],
        "recordRevision": record["revision"],
        "side": "buy",
        "quantity": "10",
        "price": "10",
        "amount": "100",
        "fees": "0",
        "currency": "USD",
        "settlementCurrency": "USD",
        "occurredAt": "2026-09-01T12:00:00Z",
        "confirmedActualFill": True,
    }
    if explicit_zero:
        assert not legacy
        data["feeInput"]={"source":"owner_recorded","brokerAccountId":aid,"providerId":"longbridge","confirmed":True,"components":[{"kind":"commission","amount":"0","currency":"USD"}]}
    filled = await operation(client, "/api/trading", data)
    if legacy:
        async with db.connection() as conn:
            await conn.execute("ALTER TABLE trade_ledger ALTER COLUMN source SET DEFAULT 'owner_recorded'")
        from fee_source_test_helpers import import_synthetic, synthetic_snapshot

        await import_synthetic(client, db, await synthetic_snapshot(client, db, filled["tradeId"]))
    return aid, filled


async def request(client, owner, aid):
    snapshot = (await client.get("/api/fees/repairs", params={"brokerAccountId": aid})).json()
    return {
        "requestId": str(uuid4()),
        "accountId": owner,
        "brokerAccountId": aid,
        "providerId": "longbridge",
        "brokerRevision": snapshot["brokerRevision"],
        "snapshotRevision": snapshot["snapshotRevision"],
        "ruleVersion": "2026-10-20.1",
        "plan": {"effectiveFrom": "2025-05-14", "effectiveThrough": "2026-10-20", "confirmed": True},
        "orders": [
            {
                "orderId": r["orderId"],
                "revision": r["revision"],
                "recordRevision": r["recordRevision"],
                "instrumentKind": "us_domestic_equity",
                "wholeOrderConfirmed": True,
                "brokerOwnershipConfirmed": True,
                "legacyImportConfirmed": True,
            }
            for r in snapshot["items"]
        ],
    }


@pytest.mark.asyncio
async def test_append_repair_and_future_trade_economics(client, admin, app, old_pg, pg, tmp_path):
    from legacy_fee_compat_cases import test_append_repair_and_future_trade_economics_are_estimated_only_actual_stays_unknown as verify_original_protection

    await verify_original_protection(client, admin, app, old_pg, pg, tmp_path)


@pytest.mark.asyncio
async def test_manual_zero_protected_and_unknown_confirmation_excluded(client, admin, db):
    aid, _ = await seed(client, db, legacy=False)
    data = await request(client, admin, aid)
    result = await client.post("/api/fees/repairs/preview", json=data)
    assert result.status_code == 200, result.text
    assert result.json()["canSubmit"] is False
    assert result.json()["excluded"][0]["reason"] == "explicit_fee_preserved"
