import json
from pathlib import Path

from alcor_api.fire_api_surface import catalogue
from test_fire_web import fire_login


async def test_all_45_decisions_have_real_method_routes_or_are_retired(app, client, admin):
    await fire_login(client)
    root = Path(__file__).parents[2]
    decisions = json.loads((root / "contracts/fire-api-decisions.json").read_text())["items"]
    assert len(decisions) == 45 and len({(x["method"], x["path"]) for x in decisions}) == 45
    view = catalogue(app)
    assert view["summary"]["pending"] == 0
    assert sum(x["decision"] == "keep" for x in decisions) == 33
    assert sum(x["decision"] == "migrated" for x in decisions) == 3
    assert sum(x["decision"] == "retired" for x in decisions) == 9
    available = {(x["method"], x["path"]): x for x in view["items"]}
    for item in decisions:
        key = item["method"], item["path"]
        if item["decision"] == "retired":
            assert key not in available
            if "[" not in item["path"]:
                assert (
                    await client.request(
                        item["method"], item["path"], json={} if item["method"] == "POST" else None
                    )
                ).status_code == 404
        else:
            assert available[key]["backend_available"], key
    assert any(
        x["path"] == "/api/deploy-status/github/callback" and x["backend_available"] for x in view["items"]
    )


def test_unknown_fallback_wrong_method_and_nested_router_are_not_completion():
    from fastapi import APIRouter, FastAPI

    app = FastAPI()
    nested = APIRouter(prefix="/api/nested")

    @nested.get("/known", include_in_schema=False)
    async def known():
        raise AssertionError("catalogue must never execute requests")

    app.include_router(nested)

    @app.get("/api/{path:path}")
    async def fallback(path: str):
        raise AssertionError("fallback must never count")

    doc = {
        "revision": 1,
        "operations": [
            {"method": method, "path": path}
            for method, path in [
                ("GET", "/api/nested/known"),
                ("POST", "/api/nested/known"),
                ("GET", "/api/unknown"),
            ]
        ],
    }
    view = catalogue(app, document=doc)
    selected = {(item["method"], item["path"]): item["status"] for item in view["items"]}
    assert selected["GET", "/api/nested/known"] == "connected"
    assert selected["POST", "/api/nested/known"] == "pending"
    assert selected["GET", "/api/unknown"] == "pending"
    assert "/api/{path:path}" not in {item["path"] for item in view["items"]}
