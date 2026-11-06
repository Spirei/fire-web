"""Release evidence cannot substitute another commit, a partial matrix, or skipped tests."""
import copy
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("release_checks_gate", Path(__file__).parents[1] / "tools/release-checks.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


def evidence():
    run = {"id": 12, "head_sha": "a" * 40, "head_branch": "main", "event": "push",
           "path": ".github/workflows/checks.yml", "repository": {"full_name": "example/project"},
           "status": "completed", "conclusion": "success"}
    jobs = [{"name": name, "status": "completed", "conclusion": "success", "steps": [
        {"name": "Run uv run python tools/test-shard.py --index "
         + name.removeprefix("foundation (").removesuffix(")") + " --count 8",
         "status": "completed", "conclusion": "success"}]} for name in sorted(gate.EXPECTED)]
    return run, jobs


def test_exact_completed_checks_are_accepted():
    run, jobs = evidence()
    assert gate.select_run([run], "example/project", "a" * 40) == run
    assert gate.passed(run, jobs)


@pytest.mark.parametrize("field,value", [("head_sha", "b" * 40), ("head_branch", "other"),
    ("event", "pull_request"), ("path", ".github/workflows/other.yml"),
    ("repository", {"full_name": "example/other"})])
def test_unrelated_evidence_is_rejected(field, value):
    run, _ = evidence()
    run[field] = value
    assert gate.select_run([run], "example/project", "a" * 40) is None


def test_latest_attempt_must_pass_and_running_is_not_success():
    run, jobs = evidence()
    newer = {**run, "id": 13, "status": "in_progress", "conclusion": None}
    assert gate.select_run([run, newer], "example/project", "a" * 40) == newer
    assert not gate.passed(newer, [])
    with pytest.raises(ValueError):
        gate.passed({**newer, "status": "completed", "conclusion": "failure"}, jobs)


def test_missing_duplicate_skipped_or_failed_test_is_rejected():
    run, jobs = evidence()
    for altered in [jobs[:-1], [*jobs[:-1], jobs[0]]]:
        with pytest.raises(ValueError):
            gate.passed(run, altered)
    for state in ["skipped", "failure"]:
        altered = copy.deepcopy(jobs)
        altered[0]["steps"][0]["conclusion"] = state
        with pytest.raises(ValueError):
            gate.passed(run, altered)
    altered = copy.deepcopy(jobs)
    altered[0]["steps"][0]["name"] = "Run uv run python tools/test-shard.py --index 7 --count 8"
    with pytest.raises(ValueError):
        gate.passed(run, altered)
