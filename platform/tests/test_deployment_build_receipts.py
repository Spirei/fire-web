from uuid import uuid4

from alcor_api.deployment_build_receipts import find_run


def test_receipt_matches_only_original_workflow_uuid():
    ident = uuid4()
    run = {
        "event": "workflow_dispatch",
        "path": ".github/workflows/docker-publish.yml",
        "head_branch": "main",
        "display_title": f"构建发布 {ident}",
    }
    calls = []

    def github(settings, path):
        calls.append(path)
        return {"workflow_runs": [run]}

    assert find_run(None, github, ident)
    assert not find_run(None, github, uuid4())
    run["path"] = ".github/workflows/ci.yml"
    assert not find_run(None, github, ident)
    assert all("/runs?" in path for path in calls)


def test_release_workflow_indexes_request_and_checks_confirmed_commit_before_build():
    from pathlib import Path

    import yaml

    root = Path(__file__).parents[2]
    workflow = yaml.safe_load((root / ".github/workflows/docker-publish.yml").read_text())
    assert "inputs.request_id" in workflow["run-name"]
    jobs = workflow["jobs"]
    inputs = workflow.get("on", workflow.get(True))["workflow_dispatch"]["inputs"]
    assert {"request_id", "expected_revision", "verify_only"} <= inputs.keys()
    assert jobs["test"]["needs"] == "scheduled-change-gate"
    assert jobs["publish"]["needs"] == ["test", "scheduled-change-gate"]
    assert jobs["release"]["needs"] == ["scheduled-change-gate", "publish"]
    guard = next(step for step in jobs["scheduled-change-gate"]["steps"] if step.get("id") == "gate")
    assert guard["env"]["EXPECTED_REVISION"] == "${{ inputs.expected_revision }}"
    script = (root / "scripts/check-image-published.mjs").read_text()
    assert script.index("confirmRevision(EXPECTED_REVISION, CURRENT_SHA)") < script.index(
        "await findPublishedRelease"
    )
    assert any("uv run pytest -q" in step.get("run", "") for step in jobs["test"]["steps"])
    assert any("docker build --build-arg" in step.get("run", "") for step in jobs["test"]["steps"])
    assert (
        "!inputs.verify_only" in jobs["publish"]["if"]
        and "github.event_name == 'schedule'" in jobs["publish"]["if"]
    )
    assert any("docker/build-push-action@" in step.get("uses", "") for step in jobs["publish"]["steps"])
    release_steps = jobs["release"]["steps"]
    assert any(
        "gh release create" in step.get("run", "") and "--notes-file release-manifest.json" in step["run"]
        for step in release_steps
    )
    assert not any("updater" in str(step) for step in jobs["publish"]["steps"] + release_steps)


def test_fire_release_schema_identity_matches_backend_without_node_dependencies():
    import json
    import subprocess
    from pathlib import Path

    from alcor_api.deployments import schema_hash

    root = Path(__file__).parents[2]
    code = "import {releaseIdentity} from './lib/deployReleaseManifest.mjs';console.log(JSON.stringify(releaseIdentity(process.cwd(),'synthetic/fire-web','a'.repeat(40))));"
    value = json.loads(
        subprocess.check_output(["node", "--input-type=module", "-e", code], cwd=root, text=True)
    )
    assert value["schema_hash"] == schema_hash(root / "platform/migrations")
    assert value["version"] == json.loads((root / "package.json").read_text())["version"]


def test_release_published_at_keeps_only_parsed_timestamps():
    from alcor_api.deployments import release_published_at

    assert release_published_at({"published_at": "2026-11-05T22:25:00Z"}) == "2026-11-05T22:25:00Z"
    assert release_published_at({"published_at": "nope"}) is None
    assert release_published_at(None) is None
    assert release_published_at({"published_at": 1}) is None


def test_malformed_or_truncated_history_is_not_reported_absent():
    import pytest
    from alcor_api.deployment_build_receipts import lookup_run

    for value in (None, [None], [{"display_title": None}]):
        with pytest.raises(TypeError):
            lookup_run(None, lambda *_, value=value: {"workflow_runs": value}, uuid4())
    calls = []

    def github(_settings, path):
        calls.append(path)
        return {"workflow_runs": [{} for _ in range(100)]}

    with pytest.raises(ValueError, match="truncated"):
        lookup_run(None, github, uuid4())
    assert len(calls) == 5
