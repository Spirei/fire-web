"""Explicit removals retain their original bindings without becoming completed work."""

from copy import deepcopy
import json

import pytest

from alcor_api.migration_catalog import build_capability_plan
from test_migration_catalog import inputs, find_binding


def test_user_removed_assistant_and_allocation_keep_baseline_but_leave_active_denominators():
    register, rules = inputs()
    before = deepcopy(register)
    result = build_capability_plan(register, rules)
    assert register == before
    summary = result["summary"]
    assert (
        summary["baseline_legacy_methods"],
        summary["legacy_methods"],
        summary["retired_legacy_methods"],
    ) == (516, 464, 52)
    assert (summary["catalog_capabilities"], summary["capabilities"], summary["retired_capabilities"]) == (
        346,
        304,
        42,
    )
    assert summary["implementation_local_verified"] == 304 and summary["legacy_local_verified"] == 464
    assert summary["legacy_accepted"] == summary["client_integrations_accepted"] == 0
    retired = [o for o in register["operations"] if o["status"] == "retired"]
    assert len(retired) == 52 and {fid for o in retired for fid in o["feature_ids"]} == {"F14", "F23", "F29", "F36"}
    assert len(result["bindings"]) == 570
    for op in retired:
        cap = find_binding(result, op["method"], op["path"])
        assert cap["implementation"]["status"] == "retired"
        assert cap["disposition"] == "user_requested_removal"
        assert set(cap["clients"].values()) == {"retired"}
        assert all(b["status"] == "retired" and not b["accepted"] for b in cap["bindings"])
    # The user withdrew the stock-pool removal; quotes and independent Agent work remain.
    pool = find_binding(result, "GET", "/api/quote-pool")
    assert pool["implementation"]["status"] == "local_verified"
    assert all(b["status"] == "local_verified" and not b["accepted"] for b in pool["bindings"])
    assert any(w["feature_id"] == "F39" for w in result["non_api_work"])
    assert find_binding(result, "GET", "/api/rates")["implementation"]["status"] == "local_verified"


@pytest.mark.parametrize(
    "mutation",
    [
        "missing_decision",
        "missing_id",
        "duplicate_id",
        "unrelated_cash",
        "fake_verified",
        "fake_accepted",
        "undeclared_retirement",
        "missing_authority",
    ],
)
def test_removal_cannot_silently_shrink_unrelated_scope_or_invent_acceptance(mutation):
    register, rules = inputs()
    decision = register["retirements"][0]
    op = next(o for o in register["operations"] if o["id"] == decision["operation_ids"][0])
    if mutation == "missing_decision":
        register["retirements"] = []
    elif mutation == "missing_id":
        decision["operation_ids"].pop()
    elif mutation == "duplicate_id":
        decision["operation_ids"].append(decision["operation_ids"][0])
    elif mutation == "unrelated_cash":
        other = next(o for o in register["operations"] if "F09" in o["feature_ids"])
        decision["operation_ids"].append(other["id"])
        other["status"] = "retired"
    elif mutation == "fake_verified":
        op["verification"] = {"version": "unproved"}
    elif mutation == "fake_accepted":
        op["accepted"] = True
    elif mutation == "undeclared_retirement":
        next(o for o in register["operations"] if o["path"] == "/api/quote-pool")["status"] = "retired"
    else:
        decision["authorization"] = "inferred"
    with pytest.raises(ValueError):
        build_capability_plan(register, rules)


async def test_removed_routes_stay_unavailable_without_financial_or_account_effects(client, admin, app):
    register, _ = inputs()
    from pathlib import Path
    fire_decisions=json.loads((Path(__file__).parents[2]/'contracts/fire-api-decisions.json').read_text())
    fire_only={(item['method'],item['path']) for item in fire_decisions['items'] if item['decision']=='migrated'}
    async with app.state.db.connection() as conn:
        before = await (
            await conn.execute(
                "SELECT (SELECT count(*) FROM trade_ledger) trades,(SELECT count(*) FROM cash_ledger_entries) cash,(SELECT count(*) FROM users) users"
            )
        ).fetchone()
    for op in register["operations"]:
        if op["status"] == "retired":
            response = await client.request(
                op["method"], op["path"], json={} if op["method"] != "GET" else None
            )
            # Fire's private package center is an explicit newer decision. The
            # retired native/platform session still cannot access its authority.
            expected={401,403} if (op['method'],op['path']) in fire_only else {404}
            assert response.status_code in expected, (op["method"], op["path"], response.text)
            if (op['method'],op['path']) not in fire_only:
                assert op["path"] not in app.openapi()["paths"]
    # Preserve implemented independent currency/calendar and financial endpoints.
    assert "/api/reference/calendar" in app.openapi()["paths"]
    assert "/api/cash/preview" in app.openapi()["paths"]
    async with app.state.db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT (SELECT count(*) FROM trade_ledger) trades,(SELECT count(*) FROM cash_ledger_entries) cash,(SELECT count(*) FROM users) users"
                )
            ).fetchone()
            == before
        )
