import json
from copy import deepcopy

import pytest
from alcor_api import migration_catalog as module
from alcor_api.config import ROOT


def inputs():
    return (
        json.loads((ROOT / "contracts/migration-register.json").read_text()),
        json.loads((ROOT / "contracts/api-capabilities.json").read_text()),
    )


def test_count_changes_both_numerator_and_denominator_and_keeps_all_sources():
    register, rules = inputs()
    originals = deepcopy((register, rules))
    before = module._build_protocol_plan(register, rules)
    after = module.build_capability_plan(register, rules)
    assert (register, rules) == originals
    assert before["summary"]["capabilities"] == 315
    assert before["summary"]["implementation_local_verified"] == 315
    assert after["summary"]["capabilities"] == 304
    assert after["summary"]["implementation_local_verified"] == 304
    for key in before["summary"]:
        if key not in {"capabilities", "catalog_capabilities", "implementation_local_verified"}:
            assert after["summary"][key] == before["summary"][key]
    original_bindings = {(b["source_kind"], b["source_id"]): b for b in before["bindings"]}
    mapped = {(b["source_kind"], b["source_id"]): b for b in after["bindings"]}
    assert mapped.keys() == original_bindings.keys()
    assert sum(b["source_kind"] != "dispatch" for b in after["bindings"]) == 516
    assert sum(b["source_kind"] == "dispatch" for b in after["bindings"]) == 54
    caps = {cap["id"]: cap for cap in after["capabilities"]}
    assert all(b["capability_ids"] and set(b["capability_ids"]) <= caps.keys() for b in mapped.values())


def test_every_original_component_evidence_action_client_and_auth_binding_survives_exactly():
    register, rules = inputs()
    before = {c["key"]: c for c in module._build_protocol_plan(register, rules)["capabilities"]}
    after = module.build_capability_plan(register, rules)
    reconstructed = {}
    for cap in after["capabilities"]:
        if "components" not in cap:
            reconstructed[cap["key"]] = cap
            continue
        assert "Web" not in cap["name"] and "web" not in cap["name"]
        for component, matrix in zip(cap["components"], cap["protocol_matrix"], strict=True):
            reconstructed[component["key"]] = component
            for field in ("implementation", "clients", "constraints", "bindings", "action_contracts"):
                assert matrix[field] == component[field]
        assert cap["action_contracts"] == [a for c in cap["components"] for a in c["action_contracts"]]
        assert sorted(cap["bindings"], key=str) == sorted(
            [b for c in cap["components"] for b in c["bindings"]], key=str
        )
    assert reconstructed == before


def test_web_proof_does_not_verify_native_protocol_or_ios_client():
    register, rules = inputs()
    native_key = "GET /api/auth/totp [versioned-auth]"
    rules["implementation_evidence"] = [e for e in rules["implementation_evidence"] if e["key"] != native_key]
    for operation in register["operations"]:
        if operation["method"] == "GET" and operation["path"] in {"/api/v1/auth/totp", "/api/v2/auth/totp"}:
            operation["status"] = "pending"
    result = module.build_capability_plan(register, rules)
    cap = next(c for c in result["capabilities"] if c["key"] == "identity.totp.status")
    native = next(c for c in cap["protocol_matrix"] if c["source_key"] == native_key)
    assert native["implementation"]["status"] == "pending"
    assert all(b["status"] == "pending" for b in native["bindings"])
    assert set(native["clients"].values()) == {"pending"}
    assert cap["implementation"]["status"] == "pending"
    assert cap["clients"]["new_web"] == "local_verified"
    assert cap["clients"]["ios"] == cap["clients"]["legacy_web"] == "pending"


def test_native_proof_does_not_supply_web_client_evidence():
    register, rules = inputs()
    rules["implementation_evidence"] = [
        e for e in rules["implementation_evidence"] if e["key"] != "identity.web.totp-status"
    ]
    cap = next(
        c
        for c in module.build_capability_plan(register, rules)["capabilities"]
        if c["key"] == "identity.totp.status"
    )
    assert set(cap["clients"].values()) == {"pending"}
    web = next(c for c in cap["protocol_matrix"] if c["source_key"] == "identity.web.totp-status")
    assert web["implementation"]["status"] == "pending"


@pytest.mark.parametrize("mutation", ["overlap", "missing", "different_action", "duplicate_key"])
async def test_invalid_merges_fail_closed(mutation):
    register, rules = inputs()
    if mutation == "overlap":
        rules["semantic_merges"][1]["members"] = rules["semantic_merges"][0]["members"]
    elif mutation == "missing":
        rules["semantic_merges"][0]["members"][0] = "nonexistent"
    elif mutation == "different_action":
        rules["semantic_merges"][0]["members"][0] = "identity.web.login"
    else:
        rules["semantic_merges"][1]["key"] = rules["semantic_merges"][0]["key"]
    with pytest.raises(ValueError):
        module.build_capability_plan(register, rules)
