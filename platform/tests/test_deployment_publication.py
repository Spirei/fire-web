"""Synthetic provider preflight protects both deployment entry points without real dispatch."""

from uuid import uuid4

import pytest
from alcor_api import deployments
from alcor_api.deployment_publication import ACTIVE, WORKFLOW
from test_deployment_requests import configure


@pytest.mark.parametrize("state", ACTIVE)
async def test_active_publication_never_admits_or_dispatches(client, admin, app, db, monkeypatch, state):
    _, calls, _ = configure(app, monkeypatch)
    original = deployments.github_json

    def github(settings, path, body=None):
        if "status=" + state + "&" in path:
            return {"workflow_runs": [{"event": "workflow_dispatch", "path": WORKFLOW}]}
        return original(settings, path, body)

    monkeypatch.setattr(deployments, "github_json", github)
    result = await client.post("/api/deployment/builds", json={"request_id": str(uuid4())})
    assert result.status_code == 409, result.text
    assert not any(path.endswith("/dispatches") for path, _ in calls)
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM deployment_builds")).fetchone()


@pytest.mark.parametrize(
    "scenario", ["published", "wrong-image", "truncated-active", "incomplete-release", "offline"]
)
async def test_published_or_unverifiable_state_never_dispatches(
    client, admin, app, db, monkeypatch, scenario
):
    release, calls, _ = configure(app, monkeypatch)
    original = deployments.github_json

    def github(settings, path, body=None):
        if scenario == "offline":
            raise TimeoutError("Synthetic provider private detail")
        if scenario == "truncated-active" and "status=queued" in path:
            return {"workflow_runs": [{"event": "push", "path": WORKFLOW}] * 100}
        if path == "/commits/main":
            return {"sha": release.revision}
        if path.startswith("/releases?"):
            if scenario == "incomplete-release":
                return {"missing": "list"}
            manifest = release.model_dump()
            if scenario == "wrong-image":
                manifest["image"] = "ghcr.io/other/image@sha256:" + "a" * 64
            return [
                {
                    "draft": False,
                    "prerelease": False,
                    "target_commitish": release.revision,
                    "body": deployments.Release(**manifest).model_dump_json(),
                }
            ]
        return original(settings, path, body)

    monkeypatch.setattr(deployments, "github_json", github)
    result = await client.post("/api/deployment/builds", json={"request_id": str(uuid4())})
    assert result.status_code == (409 if scenario == "published" else 502), result.text
    assert "Synthetic provider private detail" not in result.text
    assert not any(path.endswith("/dispatches") for path, _ in calls)
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM deployment_builds")).fetchone()


async def test_ordinary_pushes_and_unpublished_draft_do_not_fake_publication(client, admin, app, monkeypatch):
    release, calls, _ = configure(app, monkeypatch)
    original = deployments.github_json

    def github(settings, path, body=None):
        if "status=" in path:
            return {"workflow_runs": [{"event": "push", "path": WORKFLOW}]}
        if path == "/commits/main":
            return {"sha": release.revision}
        if path.startswith("/releases?"):
            return [
                {
                    "draft": True,
                    "prerelease": False,
                    "target_commitish": release.revision,
                    "body": release.model_dump_json(),
                }
            ]
        return original(settings, path, body)

    monkeypatch.setattr(deployments, "github_json", github)
    result = await client.post("/api/deployment/builds", json={"request_id": str(uuid4())})
    assert result.status_code == 202 and result.json()["status"] == "submitted", result.text
    assert sum(path.endswith("/dispatches") for path, _ in calls) == 1
