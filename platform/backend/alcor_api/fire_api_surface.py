"""Read-only route evidence for Fire's concrete API catalogue, including hidden callbacks."""

import json
import re
from pathlib import Path

from fastapi.routing import iter_route_contexts
from starlette.routing import compile_path


def normalized_path(value):
    value = re.sub(r"\[\[?\.\.\.[^/]+?\]\]?", "{path}", value)
    value = re.sub(r"\[[^/]+\]", "{id}", value)
    return re.sub(r"\{[^/]+\}", "{}", value)


def catalogue(app, *, document=None):
    document = (
        document
        if document is not None
        else json.loads((Path(__file__).resolve().parents[2] / "contracts/fire-api-surface.json").read_text())
    )
    routes = []
    for route in iter_route_contexts(app.routes):
        path = route.path
        if not path or not path.startswith("/api/") or path == "/api/{path:path}":
            continue
        routes.append((path, compile_path(path)[0], set(route.methods or [])))
    items, known = [], set()
    for item in document["operations"]:
        if "[[..." in item["path"]:
            continue
        # Concrete catalogue paths are checked against the actual method-aware router.
        # No request executes here and the unknown-API fallback never counts as evidence.
        candidate = re.sub(r"\[\.?\.?\.?([^/]+)\]", r"{\1}", item.get("upstream", item["path"]))
        candidate = re.sub(r"\{[^/]+\}", "catalogue-id", candidate)
        available = any(
            item["method"] in methods and regex.fullmatch(candidate) for _, regex, methods in routes
        )
        known.add((item["method"], normalized_path(item.get("upstream", item["path"]))))
        items.append(
            {
                **item,
                "backend_available": available,
                "status": "presentation"
                if item.get("owner") == "fire"
                else "connected"
                if available
                else "pending",
                "client_acceptance": "pending",
            }
        )
    for path, _, methods in routes:
        for candidate in (
            [path.replace("{version}", version) for version in ("1", "2")] if "{version}" in path else [path]
        ):
            for method in sorted(methods - {"HEAD", "OPTIONS"}):
                key = method, normalized_path(candidate)
                if key in known:
                    continue
                known.add(key)
                items.append(
                    {
                        "method": method,
                        "path": candidate,
                        "owner": "platform",
                        "backend_available": True,
                        "status": "connected",
                        "client_acceptance": "pending",
                    }
                )
    return {
        "revision": document["revision"],
        "items": items,
        "retirements": document.get("retirements", []),
        "summary": {
            "total": len(items),
            **{
                key: sum(item["status"] == key for item in items)
                for key in ("pending", "connected", "presentation")
            },
            "retired": len(document.get("retirements", [])),
        },
    }
