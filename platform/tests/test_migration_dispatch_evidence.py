"""Catch-all verification requires every exact protocol branch, never a parent label."""

from copy import deepcopy

import pytest

from alcor_api.migration_catalog import build_capability_plan, normalized_path
from test_migration_catalog import inputs as catalog_inputs, find_binding


def inputs():
    register, rules = catalog_inputs()
    for e in register["operations"] + register["dispatches"]:
        if "F26" in e["feature_ids"]:
            e["status"] = "pending"
            e.pop("verification", None)
    rules["implementation_evidence"] = [
        p for p in rules["implementation_evidence"] if "/resource-library" not in p["key"]
    ]
    return register, rules


def verified_branch(entry):
    entry["status"] = "local_verified"
    entry["verification"] = {
        "version": "0.1.63",
        "tests": ["tests/test_resource_library.py"],
        "method": entry["method"],
        "path": entry["path"],
        "new_web_path": normalized_path(entry["path"]).replace("{id}", "{identifier}"),
        "auth_review": "native bearer scope and owner isolated",
        "contract_review": "original UUID and legacy envelope tested",
    }


def selected(register):
    parent = next(
        op
        for op in register["operations"]
        if op["method"] == "GET" and op["path"] == "/api/v1/resource-library/[[...action]]"
    )
    branches = [
        e
        for e in register["dispatches"]
        if e["method"] == parent["method"] and e["source_route"] == parent["source"]
    ]
    return parent, branches


def test_partial_branch_does_not_promote_parent_siblings_or_other_protocol():
    register, rules = inputs()
    parent, branches = selected(register)
    verified_branch(branches[0])
    result = build_capability_plan(register, rules)
    cap = find_binding(result, branches[0]["method"], branches[0]["path"])
    statuses = {b["path"]: b["status"] for b in cap["bindings"]}
    assert statuses[branches[0]["path"]] == "local_verified"
    assert statuses[branches[0]["path"].replace("/v1/", "/v2/")] == "pending"
    assert cap["implementation"]["status"] == "pending"
    assert all(c == "pending" for c in cap["clients"].values())
    assert result["summary"]["legacy_local_verified"] == sum(
        op["status"] == "local_verified" for op in register["operations"]
    )
    assert parent["status"] == "pending"


@pytest.mark.parametrize(
    "mutation",
    [
        "parent_only",
        "missing_branch",
        "wrong_target",
        "wrong_path",
        "wrong_method",
        "no_auth",
        "no_contract",
        "no_tests",
        "string_tests",
        "unsafe_test",
        "missing_declaration",
        "duplicate_declaration",
    ],
)
def test_unproved_dynamic_coverage_fails_closed(mutation):
    register, rules = inputs()
    parent, branches = selected(register)
    for e in branches:
        verified_branch(e)
    parent["status"] = "local_verified"
    parent["verification"] = {"dispatches": [{"method": e["method"], "path": e["path"]} for e in branches]}
    proof = branches[0]["verification"]
    if mutation == "parent_only":
        for e in branches:
            e["status"] = "pending"
    elif mutation == "missing_branch":
        branches[-1]["status"] = "pending"
    elif mutation == "wrong_target":
        proof["new_web_path"] = "/api/other"
    elif mutation == "wrong_path":
        proof["path"] = "/api/v2/resource-library"
    elif mutation == "wrong_method":
        proof["method"] = "POST"
    elif mutation == "no_auth":
        proof["auth_review"] = ""
    elif mutation == "no_contract":
        proof["contract_review"] = ""
    elif mutation == "no_tests":
        proof["tests"] = []
    elif mutation == "string_tests":
        proof["tests"] = "tests/test_resource_library.py"
    elif mutation == "unsafe_test":
        proof["tests"] = ["tests/../unverified.py"]
    elif mutation == "missing_declaration":
        parent["verification"]["dispatches"].pop()
    else:
        parent["verification"]["dispatches"].append(deepcopy(parent["verification"]["dispatches"][0]))
    with pytest.raises(ValueError):
        build_capability_plan(register, rules)


def test_complete_explicit_branch_set_verifies_container_without_cutover():
    register, rules = inputs()
    parent, branches = selected(register)
    for e in branches:
        verified_branch(e)
    parent["status"] = "local_verified"
    parent["verification"] = {"dispatches": [{"method": e["method"], "path": e["path"]} for e in branches]}
    result = build_capability_plan(register, rules)
    assert result["summary"]["legacy_accepted"] == 0
    assert result["summary"]["client_integrations_accepted"] == 0
    register["dispatches"].reverse()
    assert build_capability_plan(register, rules)["capabilities"] == result["capabilities"]
