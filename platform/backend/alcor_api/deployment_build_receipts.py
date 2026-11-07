"""Read-only recovery of dispatch receipts; never submits another workflow."""
import re
from datetime import timedelta
from urllib.parse import quote

RECEIPT_STEP = "Build request receipt · "
GATE_JOB = "Check scheduled source changes"
CLEAN_TITLES = {"Build and publish Alcor image", "Check Alcor image"}


def lookup_run(settings, github, request_id, *, created_at=None):
    marker = re.compile(r"(?<![a-zA-Z0-9-])" + re.escape(str(request_id)) + r"(?![a-zA-Z0-9-])")
    # Dispatch happens once, immediately after acceptance. Bound both ends so
    # later requests cannot crowd the original receipt out of recovery.
    since = "" if created_at is None else "&created=" + quote(
        (created_at - timedelta(minutes=2)).isoformat() + ".."
        + (created_at + timedelta(minutes=5)).isoformat(), safe=""
    )
    candidates = []
    complete = False
    for page in range(1, 6):
        runs = github(settings, f"/actions/workflows/docker-publish.yml/runs?event=workflow_dispatch&branch=main&per_page=100&page={page}{since}")["workflow_runs"]
        if not isinstance(runs, list):
            raise TypeError("invalid workflow runs")
        for run in runs:
            if not isinstance(run, dict) or not isinstance(run.get("display_title", ""), str):
                raise TypeError("invalid workflow run")
            if (run.get("event") != "workflow_dispatch"
                or run.get("path") != ".github/workflows/docker-publish.yml"
                or run.get("head_branch") != "main"):
                continue
            if marker.search(run.get("display_title", "")):
                return run
            if run.get("display_title") in CLEAN_TITLES:
                candidates.append(run)
        if len(runs) < 100:
            complete = True
            break
    if not complete:
        raise ValueError("build history truncated")
    for run in candidates[:5]:
        ident = run.get("id")
        if type(ident) is not int or ident < 1:
            raise TypeError("invalid workflow id")
        raw = github(settings, f"/actions/runs/{ident}/jobs?per_page=100")
        jobs = raw["jobs"]
        if not isinstance(jobs, list):
            raise TypeError("invalid workflow jobs")
        if raw.get("total_count", len(jobs)) > len(jobs):
            raise ValueError("build jobs truncated")
        for job in jobs:
            if not isinstance(job, dict) or not isinstance(job.get("steps", []), list):
                raise TypeError("invalid workflow job")
            if job.get("name") == GATE_JOB:
                for step in job.get("steps", []):
                    if not isinstance(step, dict):
                        raise TypeError("invalid workflow step")
                    if (step.get("name") == RECEIPT_STEP + str(request_id)
                        and step.get("status") == "completed" and step.get("conclusion") == "success"):
                        return run
    if len(candidates) > 5:
        raise ValueError("build receipt search truncated")
    return None


def find_run(settings, github, request_id):
    return lookup_run(settings, github, request_id) is not None
