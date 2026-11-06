from uuid import uuid4

import pytest
from test_fee_repairs import seed


@pytest.mark.asyncio
async def test_current_fee_details_bind_preview_and_are_immutable(client, admin, db):
    aid, original = await seed(client, db, legacy=False)
    record = original["record"]
    data = {
        "requestId": str(uuid4()),
        "recordId": record["id"],
        "recordRevision": record["revision"],
        "side": "buy",
        "quantity": "10",
        "price": "10",
        "amount": "100",
        "fees": "1.03",
        "currency": "USD",
        "settlementCurrency": "USD",
        "occurredAt": "2026-09-02T12:00:00Z",
        "confirmedActualFill": True,
        "feeInput": {
            "source": "rule_calculated",
            "brokerAccountId": aid,
            "providerId": "longbridge",
            "confirmed": True,
            "ruleVersion": "2026-10-23.1",
            "instrumentKind": "us_domestic_equity",
            "plan": {"effectiveFrom": "2025-07-01", "effectiveThrough": "2026-10-23", "overrides": {}},
        },
    }
    preview = await client.post("/api/trading/preview", json=data)
    assert preview.status_code == 200, preview.text
    assert preview.json()["feeDetail"]["source"] == "rule_calculated"
    changed = {**data, "feeInput": {**data["feeInput"], "instrumentKind": "us_etf"}}
    assert (
        await client.post(
            "/api/trading/operations", json={"data": changed, "preview": preview.json()["preview"]}
        )
    ).status_code == 409
    result = await client.post(
        "/api/trading/operations", json={"data": data, "preview": preview.json()["preview"]}
    )
    assert result.status_code == 200, result.text
    listed = await client.get("/api/trading/fills", params={"recordId": record["id"]})
    assert listed.status_code == 200, listed.text
    row = next(r for r in listed.json()["items"] if r["id"] == result.json()["tradeId"])
    assert row["feeSource"] == "rule_calculated" and row["feeBreakdown"][0]["kind"] == "commission"
    assert row["feeDetail"]["ruleSnapshot"]["brokerBill"] is False


def test_old_estimate_rule_never_becomes_today_rate_and_manual_zero_stays_known_zero():
    from alcor_api.current_fees import calculate

    data = {"fees": "0", "occurredAt": "2026-11-01T12:00:00Z", "side": "buy", "quantity": "1", "price": "10"}
    record = {"market": "US", "account_market": "", "broker_account_id": "test-account"}
    account = {"id": "test-account", "provider_id": "longbridge", "holding_source": "manual", "revision": 1}
    manual = {
        "source": "owner_recorded",
        "brokerAccountId": "test-account",
        "providerId": "longbridge",
        "confirmed": True,
    }
    actual = calculate(data, record, account, manual)
    assert actual["total"] == "0" and actual["components"] is None
    assert actual["ruleVersion"] is None and actual["ruleSnapshot"] is None
    estimated = {
        **manual,
        "source": "rule_calculated",
        "ruleVersion": "2026-10-23.1",
        "instrumentKind": "us_domestic_equity",
        "plan": {"effectiveFrom": "2025-07-01", "effectiveThrough": "2026-12-31", "overrides": {}},
    }
    with pytest.raises(ValueError, match="fee_period_unconfirmed"):
        calculate(data, record, account, estimated)
