"""Coverage and acceptance boundaries for the capability projection, without source/DB writes."""

import json
import re
from copy import deepcopy

import pytest
from alcor_api.config import ROOT
from alcor_api.migration_catalog import build_capability_plan


def inputs():
    return (
        json.loads((ROOT / "contracts/migration-register.json").read_text()),
        json.loads((ROOT / "contracts/api-capabilities.json").read_text()),
    )


def plan():
    return build_capability_plan(*inputs())


def find_binding(result, method, path):
    return next(
        cap
        for cap in result["capabilities"]
        if any(binding["method"] == method and binding["path"] == path for binding in cap["bindings"])
    )


def test_all_legacy_methods_and_dynamic_actions_keep_traceable_targets_without_mutating_baseline():
    register, rules = inputs()
    original, original_rules = deepcopy(register), deepcopy(rules)
    result = build_capability_plan(register, rules)
    assert register == original and rules == original_rules
    methods = {op["id"] for op in register["operations"]}
    mapped = [binding for binding in result["bindings"] if binding["source_kind"] != "dispatch"]
    assert len(mapped) == 516 and {entry["source_id"] for entry in mapped} == methods
    assert len([entry for entry in result["bindings"] if entry["source_kind"] == "dispatch"]) == 54
    assert len([entry for entry in mapped if entry["source_kind"] == "dispatch_container"]) == 12
    cap_ids = {cap["id"] for cap in result["capabilities"]}
    assert all(
        entry["capability_ids"] and set(entry["capability_ids"]) <= cap_ids for entry in result["bindings"]
    )
    assert {fid for cap in result["capabilities"] for fid in cap["feature_ids"]} | {
        work["feature_id"] for work in result["non_api_work"]
    } == {domain["id"] for domain in register["domains"]}
    # Domain overlap must not inflate the global candidate count.
    assert result["summary"]["capabilities"] + result["summary"]["retired_capabilities"] == len(cap_ids)
    assert result["summary"]["duplicate_prefix_candidates"] == 185
    assert result["summary"]["normalized_method_candidates"] == 331


def test_shared_market_service_and_auth_protocols_are_not_treated_as_the_same_problem():
    result = plan()
    quotes = [find_binding(result, "POST", p) for p in ("/api/quotes", "/api/v1/quotes", "/api/v2/quotes")]
    assert len({cap["id"] for cap in quotes}) == 1
    assert quotes[0]["implementation"]["status"] == "local_verified"
    assert set(quotes[0]["clients"].values()) == {"pending"}
    web = find_binding(result, "POST", "/api/auth/login")
    native = find_binding(result, "POST", "/api/v2/auth/login")
    assert web["id"] != native["id"]
    assert web["proposed_path"] == "/api/session/login"
    assert native["implementation"]["status"] == "local_verified"
    assert set(native["clients"].values()) == {"pending"}
    # v1 can serve Web as well as App: the UI must not assume version prefix equals client completion.
    watch = find_binding(result, "GET", "/api/v1/watch-groups")
    assert set(watch["clients"].values()) == {"pending"}


def test_financial_commands_remain_separate_and_historical_behavior_is_flagged_for_review():
    result = plan()
    prefix = "/api/v1/account-assets/trading"
    preview, submit = (
        find_binding(result, "POST", prefix + suffix) for suffix in ("/preview", "/submissions")
    )
    assert preview["id"] != submit["id"]
    assert preview["disposition"] == submit["disposition"] == "retain_boundary"
    orders = find_binding(result, "GET", "/api/v1/orders")
    dividends = find_binding(result, "POST", "/api/v1/dividends")
    assert orders["disposition"] == dividends["disposition"] == "replacement_review"
    assert orders["implementation"]["status"] == "local_verified"
    assert orders["implementation"]["evidence"]["verification_scope"] == "legacy_protocol_only"
    assert set(orders["clients"].values()) == {"pending"}
    assert any("GET" in constraint and "显式" in constraint for constraint in orders["constraints"])
    assert dividends["implementation"]["status"] == "local_verified"
    assert dividends["proposed_path"] == "/api/dividends/receipts/operations"
    assert set(dividends["clients"].values()) == {"pending"}
    history = find_binding(result, "GET", "/api/kline/full")
    assert any("OHLC" in constraint for constraint in history["constraints"])
    fixed = find_binding(result, "GET", "/api/system-assets/passkey")
    assert fixed["delivery"] == "static"
    private = find_binding(result, "GET", "/api/private-reports/[...path]")
    assert private["delivery"] == "api" and private["id"] != fixed["id"]


def test_dynamic_containers_expand_without_double_counting_or_losing_receipt_operations():
    result = plan()
    upload = find_binding(result, "GET", "/api/v1/resource-library/uploads/{id}")
    delete = find_binding(result, "GET", "/api/v1/resource-library/deletions/{id}")
    assert upload["id"] != delete["id"]
    assert len(upload["bindings"]) == 2
    assert all(
        "[[...action]]" not in binding["path"]
        for cap in result["capabilities"]
        for binding in cap["bindings"]
    )
    assert (
        find_binding(result, "GET", "/api/managed-upload/[...path]")["bindings"][0]["source_kind"]
        == "operation"
    )


def test_reordering_inputs_does_not_change_capability_identity_or_promote_status():
    register, rules = inputs()
    first = build_capability_plan(register, rules)
    register["operations"].reverse()
    register["dispatches"].reverse()
    second = build_capability_plan(register, rules)
    assert first["capabilities"] == second["capabilities"]
    assert first["summary"] == second["summary"]
    assert first["summary"]["implementation_local_verified"] == 304
    assert first["summary"]["legacy_local_verified"] == 464
    assert first["summary"]["legacy_accepted"] == first["summary"]["client_integrations_accepted"] == 0
    rules["implementation_evidence"] = []
    assert build_capability_plan(register, rules)["summary"]["implementation_local_verified"] == 0


def test_passkey_body_actions_remain_individually_traceable_without_inflating_static_dispatches():
    register, rules = inputs()
    result = build_capability_plan(register, rules)
    cap = find_binding(result, "POST", "/api/auth/passkeys")
    assert {(action["action"], action["method"], action["path"]) for action in cap["action_contracts"]} == {
        ("login-options", "POST", "/api/session/passkeys"),
        ("login-verify", "POST", "/api/session/passkeys"),
        ("register-options", "POST", "/api/account/passkeys"),
        ("register-verify", "POST", "/api/account/passkeys"),
    }
    assert all(action["status"] == "local_verified" for action in cap["action_contracts"])
    assert result["summary"]["dynamic_actions"] == len(register["dispatches"]) == 54
    assert all(binding["protocol"] == "web" for binding in cap["bindings"])
    # A caller editing its projection cannot change the source evidence.
    cap["action_contracts"][0]["evidence"]["tests"].append("tests/synthetic-added.py")
    assert (
        "tests/synthetic-added.py"
        not in rules["groups"][cap["key"]]["action_contracts"][0]["evidence"]["tests"]
    )
    rules["implementation_evidence"] = []
    pending = find_binding(build_capability_plan(register, rules), "POST", "/api/auth/passkeys")
    assert all(action["status"] == "pending" for action in pending["action_contracts"])


def test_versioned_auth_never_inherits_an_unversioned_web_override():
    register, rules = inputs()
    rules["overrides"].pop("GET /api/v2/auth/passkeys")
    rules["implementation_evidence"] = [
        proof
        for proof in rules["implementation_evidence"]
        if proof["key"] != "GET /api/auth/passkeys [versioned-auth]"
    ]
    result = build_capability_plan(register, rules)
    web = find_binding(result, "GET", "/api/auth/passkeys")
    versioned = find_binding(result, "GET", "/api/v2/auth/passkeys")
    assert web["id"] == versioned["id"]  # Shared domain action, not shared credential boundary.
    native = next(
        part
        for part in versioned["protocol_matrix"]
        if part["source_key"] == "GET /api/auth/passkeys [versioned-auth]"
    )
    assert native["implementation"]["status"] == "pending"
    assert all(binding["protocol"] != "web" for binding in native["bindings"])
    assert set(native["clients"].values()) == {"pending"}


@pytest.mark.parametrize(
    "change", ["missing_action", "duplicate", "versioned", "no_evidence", "bad_evidence", "no_auth"]
)
def test_incomplete_or_invalid_action_contracts_cannot_claim_complete_verification(change):
    register, rules = inputs()
    actions = rules["groups"]["identity.web.passkey-exchange"]["action_contracts"]
    if change == "missing_action":
        actions.pop()
    elif change == "duplicate":
        actions.append(deepcopy(actions[0]))
    elif change == "versioned":
        actions[0]["path"] = "/api/v2/auth/passkeys"
    elif change == "no_evidence":
        actions[0]["evidence"]["tests"] = []
    elif change == "bad_evidence":
        actions[0]["evidence"]["tests"] = "tests/unverified.py"
    else:
        actions[0]["auth"] = ""
    with pytest.raises(ValueError):
        build_capability_plan(register, rules)


@pytest.mark.parametrize("mutation", ["versioned_target", "bad_evidence", "missing_container"])
def test_invalid_or_unproven_proposals_fail_closed(mutation):
    register, rules = inputs()
    if mutation == "versioned_target":
        rules["groups"]["market.history.read"]["path"] = "/api/v3/history"
    elif mutation == "bad_evidence":
        rules["implementation_evidence"][0]["tests"] = []
    else:
        register["operations"] = [
            op for op in register["operations"] if not op["path"].endswith("feed/[[...action]]")
        ]
    with pytest.raises(ValueError):
        build_capability_plan(register, rules)


async def test_admin_projection_is_read_only_and_missing_rules_do_not_hide_legacy_coverage(
    client, admin, app, settings, tmp_path
):
    before = json.loads(settings.inventory_file.read_text())
    response = await client.get("/api/system/migration")
    assert response.status_code == 200
    data = response.json()
    assert data["operations"] == before["operations"]
    assert data["capability_plan"]["summary"]["implementation_local_verified"] == 304
    assert json.loads(settings.inventory_file.read_text()) == before
    # An invalid catalog is an explicit error, never a fake successful empty migration list.
    settings.capability_file = tmp_path / "missing-catalog.json"
    assert (await client.get("/api/system/migration")).status_code == 503
    settings.capability_file = ROOT / "contracts/api-capabilities.json"
    from fastapi.routing import iter_route_contexts
    from alcor_api.fire_api_surface import catalogue
    # Historical source evidence remains immutable. Explicit Fire retirements
    # are verified as 404 separately, rather than required as active handlers.
    retired = {(item['method'].lower(), item['path']) for item in catalogue(app)['retirements']}
    for cap in data["capability_plan"]["capabilities"]:
        if cap["implementation"]["status"] == "local_verified":
            proof = cap["implementation"]["evidence"]
            routes = proof.get("runtime_routes", [{"method": cap["method"], "path": cap["proposed_path"]}])
            for route in routes:
                # Some adapters register v1/v2 separately, others use a version
                # parameter. Both must cover each concrete protocol, with parameter
                # spelling allowed to differ between inventory and Python handlers.
                def concrete_paths(path):
                    return [path.replace("{version}", str(v)) for v in (1, 2)] if "{version}" in path else [path]
                def shape(path):
                    return re.sub(r"\{[^{}]+\}", "{}", re.sub(r"\{[^{}]+:path\}", "<PATH>", path))
                required = [path for path in concrete_paths(route['path']) if (route['method'].lower(),path) not in retired]
                if not required:
                    continue
                live = {(method.lower(), shape(path)) for handler in iter_route_contexts(app.routes)
                        if getattr(handler, "path", None) not in {"/api/{path:path}", "/{path:path}"}
                        for path in concrete_paths(getattr(handler, "path", ""))
                        for method in (getattr(handler, "methods", None) or ())}
                live.update((method, shape(path)) for template, methods in app.openapi()["paths"].items()
                            for path in concrete_paths(template) for method in methods)
                # A verified literal action can be served by a shared {action} handler.
                # The action tests prove its semantics; this check proves the route exists.
                assert all(any(method == route["method"].lower() and re.fullmatch(
                    re.escape(template).replace(r"\{\}", r"[^/]+").replace("<PATH>", ".+"), shape(path))
                    for method, template in live) for path in required), route
        for action in cap["action_contracts"]:
            if action["status"] == "local_verified" and (action['method'].lower(),action['path']) not in retired:
                assert action["method"].lower() in app.openapi()["paths"][action["path"]]
    # F16 now implements this route; an incomplete query must not trigger collection.
    assert (await client.get("/api/market/history")).status_code == 400


async def test_capability_and_legacy_mapping_remain_admin_only(client, settings):
    from alcor_api.cli import create_user

    assert (await client.get("/api/system/migration")).status_code == 401
    await create_user(settings, "CatalogReader", "SyntheticCatalog9", role="user")
    login = await client.post(
        "/api/session/login", json={"login": "CatalogReader", "password": "SyntheticCatalog9"}
    )
    assert login.status_code == 200
    assert (await client.get("/api/system/migration")).status_code == 403


def test_service_evidence_does_not_imply_client_screen_acceptance():
    register, rules = inputs()
    proof = next(e for e in rules["implementation_evidence"] if e["key"] == "GET /api/countries")
    proof.pop("clients", None)
    result = build_capability_plan(register, rules)
    capability = next(c for c in result["capabilities"] if c["key"] == proof["key"])
    assert capability["implementation"]["status"] == "local_verified"
    assert capability["clients"] == {"new_web": "pending", "legacy_web": "pending", "ios": "pending"}
    proof["clients"] = {"ios": "accepted"}
    with pytest.raises(ValueError, match="independent end-to-end"):
        build_capability_plan(register, rules)


def test_reference_calendar_and_rates_local_proof_keep_client_cutover_separate():
    result = plan()
    single = find_binding(result, "GET", "/api/v2/market-calendar")
    batch = find_binding(result, "GET", "/api/v2/market-calendar/batch")
    assert single["id"] == batch["id"]
    assert single["proposed_path"] == "/api/reference/calendar"
    assert single["implementation"]["status"] == "local_verified"
    assert len(single["bindings"]) == 2
    for path in ("/api/rates", "/api/v1/rates", "/api/v2/rates"):
        rates = find_binding(result, "GET", path)
        assert rates["implementation"]["status"] == "local_verified"
        assert set(rates["clients"].values()) == {"pending"}
    assert result["summary"]["legacy_accepted"] == 0
    assert result["summary"]["client_integrations_accepted"] == 0


def test_legacy_runtime_evidence_cannot_claim_a_different_route_or_client():
    register, rules = inputs()
    proof = next(p for p in rules['implementation_evidence'] if p['key'] == 'GET /api/broker-accounts/[accountId]')
    original = deepcopy(proof)
    proof['runtime_routes'][0]['path'] = '/api/broker-accounts/{account_id}'
    with pytest.raises(ValueError, match='exactly cover'):
        build_capability_plan(register, rules)
    proof.clear()
    proof.update(original)
    proof['clients'] = {'new_web': 'local_verified'}
    with pytest.raises(ValueError, match='without client acceptance'):
        build_capability_plan(register, rules)


def test_single_version_write_proof_cannot_invent_a_second_protocol():
    register, rules = inputs()
    proof = next(p for p in rules['implementation_evidence'] if p['key'] == 'POST /api/brokers')
    assert proof['runtime_routes'] == [{'method': 'POST', 'path': '/api/v1/brokers'}]
    result = build_capability_plan(register, rules)
    cap = find_binding(result, 'POST', '/api/v1/brokers')
    assert cap['implementation']['status'] == 'local_verified'
    proof['runtime_routes'][0]['path'] = '/api/v{version}/brokers'
    with pytest.raises(ValueError, match='exactly cover'):
        build_capability_plan(register, rules)
    proof['runtime_routes'][0]['path'] = '/api/v2/brokers'
    with pytest.raises(ValueError, match='exactly cover'):
        build_capability_plan(register, rules)
