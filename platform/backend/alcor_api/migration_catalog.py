"""Read-only capability projection over the immutable legacy coverage register.

Proposal grouping is never routing, authorization, or acceptance evidence.
"""

import hashlib
import re
from copy import deepcopy

METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
CLIENTS = ("new_web", "legacy_web", "ios")


def normalized_path(path):
    return re.sub(r"^/api/v[12]/", "/api/", path)


def stable_id(key):
    return "cap-" + hashlib.sha256(key.encode()).hexdigest()[:16]


def apply_subcontract_evidence(capabilities, register, rules):
    """A proved leaf never promotes its whole protocol, sibling actions or clients."""
    operations = {op["id"]: op for op in register["operations"]}
    seen = set()
    proofs = rules.get("action_implementation_evidence", [])
    if not isinstance(proofs, list):
        raise ValueError("Invalid subcontract evidence")  # noqa: TRY004 -- stable catalog error contract
    for proof in proofs:
        if not isinstance(proof, dict) or set(proof) != {"key", "action", "version", "tests", "operation_ids"}:
            raise ValueError("Invalid subcontract evidence boundary")
        key, name = proof["key"], proof["action"]
        if not isinstance(key, str) or not isinstance(name, str) or (key, name) in seen:
            raise ValueError("Duplicate or invalid subcontract evidence")
        seen.add((key, name))
        cap = capabilities.get(stable_id(key))
        action = next((a for a in cap["action_contracts"] if a["action"] == name), None) if cap else None
        tests, identifiers = proof["tests"], proof["operation_ids"]
        if (
            not cap or cap["implementation"]["status"] == "retired" or not action
            or not isinstance(tests, list) or not tests or len(tests) > 32
            or any(not isinstance(t, str) or not t.startswith("tests/") or len(t) > 512 or ".." in t.split("/") for t in tests)
            or not isinstance(identifiers, list) or not identifiers
            or any(not isinstance(identifier, str) for identifier in identifiers)
            or len(identifiers) != len(set(identifiers))
            or action["evidence"]["version"] != proof["version"]
            or not set(action["evidence"]["tests"]) <= set(tests)
        ):
            raise ValueError("Subcontract lacks exact action evidence")
        bound = {binding["source_id"] for binding in cap["bindings"]}
        if not set(identifiers) <= bound:
            raise ValueError("Subcontract evidence crosses a protocol binding")
        for identifier in identifiers:
            op = operations.get(identifier)
            claims = op.get("subcontract_verification", []) if op else []
            expected = {
                "action": name, "capability_key": key, "method": action["method"], "path": action["path"],
                "version": proof["version"], "tests": tests, "source_sha256": op.get("source_sha256") if op else None,
            }
            if not op or op.get("status") == "retired" or not isinstance(op.get("source_sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", op["source_sha256"]) or not isinstance(claims, list) or claims.count(expected) != 1:
                raise ValueError("Subcontract lacks exact legacy source evidence")
        action["status"] = "local_verified"
        action["verified_operation_ids"] = sorted(identifiers)


def retired_operations(register):
    """Explicit user removal is a separate outcome from implementation or acceptance."""
    retired = {o["id"] for o in register["operations"] if o.get("status") == "retired"}
    declared = set()
    by_id = {o["id"]: o for o in register["operations"]}
    for decision in register.get("retirements", []):
        ids = decision.get("operation_ids", [])
        if (
            decision.get("id") not in {"legacy_web_smart_assistant", "global_asset_allocation", "removed_3d_showcase", "removed_app_distribution"}
            or decision.get("authorization") != "user_requested"
            or not decision.get("version")
            or not decision.get("reason")
            or not isinstance(ids, list)
            or not ids
            or len(ids) != len(set(ids))
        ):
            raise ValueError("Invalid user retirement decision")
        for identifier in ids:
            op = by_id.get(identifier)
            if (
                not op
                or identifier in declared
                or not (
                    decision["id"] == "legacy_web_smart_assistant"
                    and op["feature_ids"] == ["F23"]
                    and (op["path"] == "/api/assistant" or op["path"].startswith("/api/assistant/"))
                    or decision["id"] == "global_asset_allocation"
                    and op["feature_ids"] == ["F14"]
                    and normalized_path(op["path"])
                    in {"/api/asset-allocation", "/api/asset-allocation/assign"}
                    or decision["id"] == "removed_3d_showcase"
                    and op["feature_ids"] == ["F29"]
                    or decision["id"] == "removed_app_distribution"
                    and op["feature_ids"] == ["F36"]
                )
                or op.get("accepted")
                or op.get("verification")
            ):
                raise ValueError("Retirement cannot remove an unrelated or verified operation")
            declared.add(identifier)
    if declared != retired:
        raise ValueError("Retired operation lacks exact user decision coverage")
    return retired


def _build_protocol_plan(register, rules):
    if rules.get("schema_version") != 1:
        raise ValueError("Unsupported capability catalog")
    retired = retired_operations(register)
    overrides = rules["overrides"]
    groups = rules["groups"]
    capabilities, bindings, seen = {}, [], set()
    operations = {(op["method"], op["path"]): op for op in register["operations"]}
    if len(operations) != len(register["operations"]):
        raise ValueError("Duplicate legacy method binding")
    domain_ids = {d["id"] for d in register["domains"]}

    def add(method, path, feature_ids, source_id, source_kind, verified=False, accepted=False):
        signature = method + " " + normalized_path(path)
        if method not in METHODS or not path.startswith("/api/") or not set(feature_ids) <= domain_ids:
            raise ValueError("Invalid legacy binding")
        # Auth protocol differences require explicit review; common spelling alone is not equivalence.
        version = re.match(r"^/api/(v[12])/", path)
        protocol = version[1] if version else "web"
        auth_family = "web-auth" if protocol == "web" else "versioned-auth"
        group_key = overrides.get(method + " " + path)
        if group_key is None and (not version or not normalized_path(path).startswith("/api/auth/")):
            group_key = overrides.get(signature)
        if group_key is None:
            group_key = signature + (
                " [" + auth_family + "]" if normalized_path(path).startswith("/api/auth/") else ""
            )
        template = groups.get(group_key, {})
        target = template.get("path", normalized_path(path))
        delivery = template.get("delivery", "api")
        if delivery not in {"api", "static"}:
            raise ValueError("Invalid delivery mode")
        if delivery == "api" and (
            not target.startswith("/api/") or re.match(r"^/api/(?:v\d+|platform)/", target)
        ):
            raise ValueError("New API proposals must use the unversioned root")
        if delivery == "static" and not target.startswith("/assets/"):
            raise ValueError("Invalid static resource proposal")
        actions = deepcopy(template.get("action_contracts", []))
        if not isinstance(actions, list) or len(actions) > 32:
            raise ValueError("Invalid action contracts")
        action_names = set()
        for action in actions:
            if (
                not isinstance(action, dict)
                or not isinstance(action.get("action"), str)
                or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", action["action"])
                or action["action"] in action_names
                or not isinstance(action.get("method"), str)
                or action.get("method") not in METHODS
                or not isinstance(action.get("path"), str)
                or not action["path"].startswith("/api/")
                or re.match(r"^/api/(?:v\d+|platform)/", action["path"])
                or not isinstance(action.get("auth"), str)
                or not 1 <= len(action["auth"]) <= 256
            ):
                raise ValueError("Invalid action contract boundary")
            evidence = action.get("evidence", {})
            if (
                not isinstance(evidence, dict)
                or not isinstance(evidence.get("version"), str)
                or not 1 <= len(evidence["version"]) <= 64
                or not isinstance(evidence.get("tests"), list)
                or not 1 <= len(evidence["tests"]) <= 32
                or any(
                    not isinstance(test, str)
                    or not test.startswith("tests/")
                    or len(test) > 512
                    or ".." in test.split("/")
                    for test in evidence["tests"]
                )
            ):
                raise ValueError("Action contract lacks verification evidence")
            action_names.add(action["action"])
            action["status"] = "pending"
        cap_id = stable_id(group_key)
        if cap_id not in capabilities:
            financial = any(fid in feature_ids for fid in ("F05", "F09", "F10", "F11", "F12", "F14", "F41"))
            capabilities[cap_id] = {
                "id": cap_id,
                "key": group_key,
                "name": template.get("name", signature),
                "method": template.get("method", method),
                "proposed_path": target,
                "delivery": delivery,
                "feature_ids": [],
                "bindings": [],
                "disposition": template.get(
                    "disposition", "retain_boundary" if financial else "shared_candidate"
                ),
                "constraints": list(template.get("constraints", [])),
                "action_contracts": actions,
                "implementation": {"status": "pending", "evidence": []},
                "clients": {client: "pending" for client in CLIENTS},
                "design_status": "proposed",
            }
        cap = capabilities[cap_id]
        if (source_kind, source_id, cap_id) in seen:
            raise ValueError("Duplicate capability binding")
        seen.add((source_kind, source_id, cap_id))
        if method != cap["method"] and not template.get("method_conversion_review"):
            raise ValueError("Method changes require explicit review")
        for fid in feature_ids:
            if fid not in cap["feature_ids"]:
                cap["feature_ids"].append(fid)
        cap["bindings"].append(
            {
                "source_id": source_id,
                "source_kind": source_kind,
                "method": method,
                "path": path,
                "protocol": protocol,
                "status": "retired"
                if source_kind == "operation" and source_id in retired
                else "local_verified"
                if verified
                else "pending",
                "accepted": bool(accepted),
                "auth_review": "separate_protocol_review_required",
            }
        )
        return cap_id

    # Catch-all handlers are containers, not extra business operations. Expand their known actions.
    dispatches = register.get("dispatches", [])
    dispatch_caps, dispatch_entries = {}, {}
    for entry in dispatches:
        parent = operations.get(
            (
                entry["method"],
                "/api/" + entry["source_route"].removeprefix("app/api/").removesuffix("/route.ts"),
            )
        )
        if not parent or not parent.get("requires_action_expansion"):
            raise ValueError("Dynamic action has no matching container")
        dispatch_id = (
            "dispatch-" + hashlib.sha256((entry["method"] + " " + entry["path"]).encode()).hexdigest()[:16]
        )
        verified = entry.get("status") == "local_verified"
        if verified:
            proof = entry.get("verification", {})
            tests = proof.get("tests")
            if (
                not isinstance(proof.get("version"), str)
                or not proof["version"]
                or not isinstance(tests, list)
                or not tests
                or any(
                    not isinstance(t, str) or not t.startswith("tests/") or ".." in t.split("/")
                    for t in tests
                )
                or not proof.get("auth_review")
                or not proof.get("contract_review")
                or proof.get("method") != entry["method"]
                or proof.get("path") != entry["path"]
            ):
                raise ValueError("Dynamic binding lacks explicit protocol evidence")
        cap_id = add(entry["method"], entry["path"], entry["feature_ids"], dispatch_id, "dispatch", verified)
        if verified and proof.get("new_web_path") != capabilities[cap_id]["proposed_path"]:
            raise ValueError("Dynamic evidence targets a different capability")
        dispatch_entries.setdefault(parent["id"], []).append(entry)
        dispatch_caps.setdefault(parent["id"], set()).add(cap_id)
        bindings.append({"source_id": dispatch_id, "source_kind": "dispatch", "capability_ids": [cap_id]})

    for op in register["operations"]:
        if op["id"] in dispatch_caps:
            cap_ids = sorted(dispatch_caps[op["id"]])
            role = "dispatch_container"
            if op.get("status") == "local_verified":
                entries = dispatch_entries[op["id"]]
                declared = op.get("verification", {}).get("dispatches", [])
                expected = {(e["method"], e["path"]) for e in entries}
                actual = {(e.get("method"), e.get("path")) for e in declared}
                if (
                    len(declared) != len(expected)
                    or actual != expected
                    or not all(e.get("status") == "local_verified" for e in entries)
                ):
                    raise ValueError("Verified dynamic container coverage is incomplete")
        else:
            cap_ids = [
                add(
                    op["method"],
                    op["path"],
                    op["feature_ids"],
                    op["id"],
                    "operation",
                    op.get("status") == "local_verified",
                    op.get("accepted", False),
                )
            ]
            role = "operation"
            if op.get("requires_action_expansion"):
                capabilities[cap_ids[0]]["constraints"].append(
                    "通配路径需核对资源路径或子动作，不推定已完整展开"
                )
        bindings.append({"source_id": op["id"], "source_kind": role, "capability_ids": cap_ids})
        verified_actions = op.get("verification", {}).get("actions", [])
        if op.get("status") == "local_verified" and verified_actions:
            actual = {
                (action["action"], action["method"], action["path"])
                for cap_id in cap_ids
                for action in capabilities[cap_id]["action_contracts"]
            }
            expected = {
                (action["action"], action["method"], action["new_web_path"]) for action in verified_actions
            }
            if actual != expected:
                raise ValueError("Verified action coverage is incomplete")

    for cap in capabilities.values():
        if all(b["status"] == "retired" for b in cap["bindings"]):
            cap["implementation"] = {"status": "retired", "evidence": []}
            cap["clients"] = {client: "retired" for client in CLIENTS}
            cap["design_status"] = "retired"
            cap["disposition"] = "user_requested_removal"
            cap["constraints"].append("按用户要求移除，不再迁移；保留原接口追溯。")

    # Implementation and client claims require their own evidence, never inferred from URL deduplication.
    for proof in rules.get("implementation_evidence", []):
        cap = capabilities.get(stable_id(proof["key"]))
        if not cap or not proof.get("tests") or not proof.get("version"):
            raise ValueError("Invalid capability implementation evidence")
        if not any(b["status"] == "local_verified" for b in cap["bindings"]):
            raise ValueError("Capability evidence lacks a verified protocol binding")
        if "runtime_routes" in proof:
            routes = proof["runtime_routes"]
            verified_bindings = [b for b in cap["bindings"] if b["status"] == "local_verified"]
            expected = set()
            for binding in verified_bindings:
                if not re.match(r"^/api/v[12]/", binding["path"]):
                    raise ValueError("Legacy-only runtime evidence requires versioned bindings")
                path = re.sub(r"\[([^/\[\]]+)\]", r"{\1}", binding["path"])
                expected.add((binding["method"], path))
            if (
                proof.get("verification_scope") != "legacy_protocol_only"
                or not isinstance(routes, list)
                or not routes
                or any(not isinstance(route, dict) or set(route) != {"method", "path"}
                       or not isinstance(route["method"], str) or not isinstance(route["path"], str)
                       for route in routes)
                or {(route["method"], path) for route in routes
                    for path in ([route["path"].replace("{version}", str(version)) for version in (1, 2)]
                                 if "{version}" in route["path"] else [route["path"]])} != expected
                or not isinstance(proof.get("clients", {}), dict)
                or any(state != "pending" for state in proof.get("clients", {}).values())
            ):
                raise ValueError("Runtime evidence must exactly cover verified legacy bindings without client acceptance")
        cap["implementation"] = {"status": "local_verified", "evidence": deepcopy(proof)}
        cap["design_status"] = "local_verified"
        # A verified protocol/service does not prove a client has a usable screen.
        client_proofs = proof.get("clients", {})
        if not isinstance(client_proofs, dict) or set(client_proofs) - set(CLIENTS):
            raise ValueError("Invalid client evidence")
        for client, state in client_proofs.items():
            if state not in {"pending", "local_verified"}:
                raise ValueError("Client acceptance requires independent end-to-end evidence")
            cap["clients"][client] = state
        for action in cap["action_contracts"]:
            if action["evidence"]["version"] != proof["version"] or not set(
                action["evidence"]["tests"]
            ) <= set(proof["tests"]):
                raise ValueError("Action evidence does not match capability verification")
            action["status"] = "local_verified"

    apply_subcontract_evidence(capabilities, register, rules)
    result = sorted(capabilities.values(), key=lambda c: (min(c["feature_ids"]), c["key"]))
    for cap in result:
        cap["feature_ids"].sort()
        cap["bindings"].sort(key=lambda b: (b["path"], b["method"]))
        cap["legacy_verified_count"] = sum(b["status"] == "local_verified" for b in cap["bindings"])
        if cap["disposition"] == "shared_candidate" and len(cap["bindings"]) == 1:
            cap["disposition"] = "direct_candidate"

    normalized = {(op["method"], normalized_path(op["path"])) for op in register["operations"]}
    return {
        "schema_version": 1,
        "revision": rules["revision"],
        "summary": {
            "capabilities": sum(c["implementation"]["status"] != "retired" for c in result),
            "catalog_capabilities": len(result),
            "retired_capabilities": sum(c["implementation"]["status"] == "retired" for c in result),
            "baseline_legacy_methods": len(register["operations"]),
            "retired_legacy_methods": len(retired),
            "implementation_local_verified": sum(
                c["implementation"]["status"] == "local_verified" for c in result
            ),
            "legacy_methods": len(register["operations"]) - len(retired),
            "legacy_local_verified": sum(
                op.get("status") == "local_verified" for op in register["operations"]
            ),
            "legacy_accepted": sum(bool(op.get("accepted")) for op in register["operations"]),
            "client_integrations_accepted": sum(
                c["clients"][client] == "accepted" for c in result for client in ("legacy_web", "ios")
            ),
            "normalized_method_candidates": len(normalized),
            "duplicate_prefix_candidates": len(register["operations"]) - len(normalized),
            "dynamic_actions": len(dispatches),
        },
        "capabilities": result,
        "bindings": bindings,
        "non_api_work": deepcopy(rules["non_api_work"]),
    }


def build_capability_plan(register, rules):
    """Group proved domain actions without rewriting their protocol evidence.

    Components remain the exact former projections. No credential, permission,
    binding status or client evidence is copied from one component to another.
    """
    result = _build_protocol_plan(register, rules)
    merges = rules.get("semantic_merges", [])
    if not isinstance(merges, list):
        raise TypeError("Invalid semantic merge catalog")
    by_key = {cap["key"]: cap for cap in result["capabilities"]}
    used, replacements, merged = set(), {}, []
    output_keys = set(by_key)
    for proposal in merges:
        key, name, members = proposal.get("key"), proposal.get("name"), proposal.get("members")
        if (
            not isinstance(key, str)
            or not key
            or key in output_keys
            or not isinstance(name, str)
            or not name
            or not isinstance(members, list)
            or len(members) < 2
            or any(not isinstance(member, str) for member in members)
            or len(set(members)) != len(members)
            or any(member not in by_key or member in used for member in members)
        ):
            raise ValueError("Invalid or overlapping semantic merge")
        parts = [by_key[member] for member in members]
        # Differing endpoint semantics need their own reviewed design, not this limited merge.
        if len({(part["method"], part["proposed_path"], part["delivery"]) for part in parts}) != 1:
            raise ValueError("Semantic merge crosses action boundaries")
        cap = deepcopy(parts[0])
        cap.update(
            {
                "id": stable_id(key),
                "key": key,
                "name": name,
                "components": deepcopy(parts),
                "disposition": "retain_boundary",
                "feature_ids": sorted({fid for part in parts for fid in part["feature_ids"]}),
                "bindings": sorted(
                    [deepcopy(binding) for part in parts for binding in part["bindings"]],
                    key=lambda binding: (binding["path"], binding["method"]),
                ),
                "constraints": list(
                    dict.fromkeys(
                        [constraint for part in parts for constraint in part["constraints"]]
                        + proposal.get("constraints", [])
                        + ["共享领域动作；各协议认证、Scope、挑战、客户端及验收证据仍分别保留"]
                    )
                ),
                # Preserve each action/evidence even where names coincide across protocols.
                "action_contracts": [
                    deepcopy(action) for part in parts for action in part["action_contracts"]
                ],
                "protocol_matrix": [
                    {
                        "source_key": part["key"],
                        "implementation": deepcopy(part["implementation"]),
                        "clients": deepcopy(part["clients"]),
                        "constraints": deepcopy(part["constraints"]),
                        "bindings": deepcopy(part["bindings"]),
                        "action_contracts": deepcopy(part["action_contracts"]),
                    }
                    for part in parts
                ],
            }
        )
        verified = all(part["implementation"]["status"] == "local_verified" for part in parts)
        cap["implementation"] = {
            "status": "local_verified" if verified else "pending",
            "evidence": {
                "components": [
                    {"source_key": part["key"], "evidence": deepcopy(part["implementation"]["evidence"])}
                    for part in parts
                ]
            },
        }
        cap["design_status"] = "local_verified" if verified else "proposed"
        # Aggregate only explicit evidence for the *same named client*, never protocol-to-client inference.
        cap["clients"] = {
            client: "local_verified"
            if any(part["clients"][client] == "local_verified" for part in parts)
            else "pending"
            for client in CLIENTS
        }
        cap["legacy_verified_count"] = sum(
            binding["status"] == "local_verified" for binding in cap["bindings"]
        )
        for part in parts:
            replacements[part["id"]] = cap["id"]
        used.update(members)
        output_keys.add(key)
        merged.append(cap)
    result["capabilities"] = sorted(
        [cap for cap in result["capabilities"] if cap["key"] not in used] + merged,
        key=lambda cap: (min(cap["feature_ids"]), cap["key"]),
    )
    for binding in result["bindings"]:
        binding["capability_ids"] = sorted({replacements.get(cid, cid) for cid in binding["capability_ids"]})
    result["summary"]["catalog_capabilities"] = len(result["capabilities"])
    result["summary"]["retired_capabilities"] = sum(
        c["implementation"]["status"] == "retired" for c in result["capabilities"]
    )
    result["summary"]["capabilities"] = (
        len(result["capabilities"]) - result["summary"]["retired_capabilities"]
    )
    result["summary"]["implementation_local_verified"] = sum(
        cap["implementation"]["status"] == "local_verified" for cap in result["capabilities"]
    )
    return result
