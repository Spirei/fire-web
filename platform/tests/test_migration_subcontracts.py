"""Partial evidence must stay scoped to its exact source leaf and preserve totals."""

import json
from copy import deepcopy

import pytest
from alcor_api.config import ROOT
from alcor_api.migration_catalog import build_capability_plan


def inputs():
    return json.loads((ROOT/"contracts/migration-register.json").read_text()),json.loads((ROOT/"contracts/api-capabilities.json").read_text())


def capability(result,key):
    return next(cap for cap in result["capabilities"] if cap["key"]==key)


def test_partial_watch_fee_and_upsert_proofs_do_not_promote_whole_methods_or_clients():
    register,rules=inputs();before=deepcopy((register,rules));result=build_capability_plan(register,rules)
    assert (register,rules)==before
    assert result["summary"]["legacy_methods"]==464 and result["summary"]["retired_legacy_methods"]==52
    assert result["summary"]["capabilities"]==304
    assert result["summary"]["legacy_local_verified"]==464
    assert result["summary"]["implementation_local_verified"]==304
    assert result["summary"]["legacy_accepted"]==0 and result["summary"]["dynamic_actions"]==54
    cap=capability(result,"POST /api/app-state")
    assert cap["implementation"]["status"]=="local_verified"
    assert all(binding["status"]=="local_verified" for binding in cap["bindings"])
    assert {action["action"]:action["status"] for action in cap["action_contracts"]}=={"watch-write":"local_verified","fees-write":"local_verified"}
    assert set(cap["clients"].values())=={"pending"}
    alert=capability(result,"POST /api/price-alerts/operations/[requestId]")
    assert len(alert["action_contracts"])==20
    assert all(action["status"]=="local_verified" for action in alert["action_contracts"])
    assert all(a["status"]=="local_verified" for a in alert["action_contracts"] if a["action"].startswith("qq-"))
    # Removing whole-capability proof must still leave only its proved action leaves green.
    rules["implementation_evidence"]=[e for e in rules["implementation_evidence"] if e["key"] not in {"POST /api/quotes","GET /api/quote-pool"}]
    result=build_capability_plan(register,rules)
    assert capability(result,"POST /api/quotes")["implementation"]["status"]=="pending"
    assert capability(result,"GET /api/quote-pool")["implementation"]["status"]=="pending"


def test_partial_evidence_removed_or_reordered_cannot_leave_stale_green_states():
    register,rules=inputs();first=build_capability_plan(register,rules)
    rules["action_implementation_evidence"].reverse();register["operations"].reverse()
    assert build_capability_plan(register,rules)["capabilities"]==first["capabilities"]
    # A complete capability proof also proves its exact action set. Remove
    # both proof layers before checking that partial evidence cannot stay green.
    rules["implementation_evidence"]=[proof for proof in rules["implementation_evidence"] if proof["key"]!="GET /api/app-state"]
    rules["action_implementation_evidence"]=[]
    pending=capability(build_capability_plan(register,rules),"GET /api/app-state")
    assert pending["implementation"]["status"]=="pending"
    assert all(action["status"]=="pending" for action in pending["action_contracts"])


@pytest.mark.parametrize("change",["source_hash","other_method","missing_source_claim","duplicate","unknown_action","client_claim","evidence_version","missing_test"])
def test_subcontract_requires_matching_source_action_version_tests_and_protocol(change):
    register,rules=inputs();proof=rules["action_implementation_evidence"][0]
    op=next(op for op in register["operations"] if op["id"]==proof["operation_ids"][0])
    if change=="source_hash":op["source_sha256"]="0"*64
    elif change=="other_method":proof["operation_ids"]=["0d5164d3caf43f69"]
    elif change=="missing_source_claim":op["subcontract_verification"]=[]
    elif change=="duplicate":rules["action_implementation_evidence"].append(deepcopy(proof))
    elif change=="unknown_action":proof["action"]="not-implemented"
    elif change=="client_claim":proof["clients"]={"ios":"local_verified"}
    elif change=="evidence_version":proof["version"]="not-the-tested-version"
    elif change=="missing_test":proof["tests"]=["tests/unrelated.py"]
    with pytest.raises(ValueError):build_capability_plan(register,rules)
