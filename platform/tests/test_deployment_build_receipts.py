from uuid import uuid4
from datetime import datetime, timezone

import pytest

from alcor_api.deployment_build_receipts import find_run


@pytest.mark.parametrize("title", ["Build and publish Alcor image", "Check Alcor image"])
def test_clean_title_recovers_original_receipt_from_internal_step(title):
    from alcor_api.deployment_build_receipts import lookup_run, GATE_JOB, RECEIPT_STEP

    identifier = uuid4()
    run = {"id": 42, "event": "workflow_dispatch", "path": ".github/workflows/docker-publish.yml",
           "head_branch": "main", "display_title": title}
    step = {"name": RECEIPT_STEP + str(identifier), "status": "completed", "conclusion": "success"}
    calls = []
    def github(_settings, path):
        calls.append(path)
        assert "/dispatches" not in path
        return {"jobs": [{"name": GATE_JOB, "steps": [step]}]} if "/jobs?" in path else {"workflow_runs": [run]}

    assert lookup_run(None, github, identifier, created_at=datetime(2026, 11, 8, tzinfo=timezone.utc)) == run
    assert "created=2026-11-07T23%3A58%3A00%2B00%3A00..2026-11-08T00%3A05%3A00%2B00%3A00" in calls[0]
    assert calls[1] == "/actions/runs/42/jobs?per_page=100"
    assert lookup_run(None, github, uuid4()) is None
    step["conclusion"] = "skipped"
    assert lookup_run(None, github, identifier) is None
    step["conclusion"] = "success"
    run["head_branch"] = "other"
    assert lookup_run(None, github, identifier) is None
    run["head_branch"] = "main"
    run["path"] = ".github/workflows/other.yml"
    assert lookup_run(None, github, identifier) is None


def test_clean_title_never_guesses_receipt_from_sha_or_incomplete_jobs():
    from alcor_api.deployment_build_receipts import lookup_run

    run = {"id": 42, "event": "workflow_dispatch", "path": ".github/workflows/docker-publish.yml",
           "head_branch": "main", "display_title": "Build and publish Alcor image", "head_sha": "a" * 40}
    def github(_settings, path):
        return {"jobs": [], "total_count": 1} if "/jobs?" in path else {"workflow_runs": [run]}
    with pytest.raises(ValueError, match="truncated"):
        lookup_run(None, github, uuid4())

    calls = []
    def bounded(_settings, path):
        calls.append(path)
        return {"jobs": []} if "/jobs?" in path else {"workflow_runs": [{**run, "id": i} for i in range(1, 7)]}
    with pytest.raises(ValueError, match="truncated"):
        lookup_run(None, bounded, uuid4())
    assert sum("/jobs?" in path for path in calls) == 5


def test_receipt_matches_only_original_workflow_uuid():
    ident = uuid4()
    run = {
        "event": "workflow_dispatch",
        "path": ".github/workflows/docker-publish.yml",
        "head_branch": "main",
        "display_title": f"Fire 手动发布：检查并构建当前版本 · {ident}",
    }
    calls = []

    def github(settings, path):
        calls.append(path)
        return {"workflow_runs": [run]}

    assert find_run(None, github, ident)
    run["display_title"] = f"Build and publish Alcor image · {ident}"
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
    assert workflow["name"] == "Build and publish Alcor image"
    title = workflow["run-name"]
    assert "Build and publish Alcor image" in title
    assert "Fire 手动发布" not in title and "Fire 定时发布" not in title
    assert "inputs.request_id" not in title
    assert "github.event.head_commit.message" in title
    assert "github.event.pull_request.title" in title
    receipt = workflow["jobs"]["scheduled-change-gate"]["steps"][0]
    assert receipt["name"] == "Build request receipt · ${{ inputs.request_id }}"
    assert "workflow_dispatch" in receipt["if"] and "inputs.request_id != ''" in receipt["if"]
    assert "inputs.request_id" not in receipt["run"]  # No input interpolation into shell code.
    assert "github.sha" not in title
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
    assert jobs["test"]["strategy"]["matrix"]["shard"] == list(range(8))
    assert jobs["test"]["strategy"]["fail-fast"] is False
    assert any("uv run python tools/test-shard.py --index ${{ matrix.shard }} --count 8" in step.get("run", "") for step in jobs["test"]["steps"])
    steps = jobs["test"]["steps"]
    dependency = next(i for i, step in enumerate(steps) if step.get("run") == "npm ci")
    regression = next(i for i, step in enumerate(steps) if "tools/test-shard.py" in step.get("run", ""))
    assert dependency < regression and "if" not in steps[dependency]
    for step in steps:
        if any(command in step.get("run", "") for command in ("npm run build", "docker build", "docker run")):
            assert step.get("if") == "matrix.shard == 0"
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
