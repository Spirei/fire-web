"""Publish only after the complete independent checks for this exact main commit pass."""
import argparse
import json
import os
import re
import time
import urllib.parse
import urllib.request

EXPECTED = {f"foundation ({index})" for index in range(8)}


def select_run(runs, repository, revision):
    selected = [r for r in runs if r.get("head_sha") == revision
                and r.get("head_branch") == "main" and r.get("event") == "push"
                and r.get("path") == ".github/workflows/checks.yml"
                and r.get("repository", {}).get("full_name", "").lower() == repository.lower()]
    return max(selected, key=lambda r: r["id"], default=None)


def passed(run, jobs):
    if any(j.get("conclusion") in {"failure", "cancelled", "timed_out", "action_required"} for j in jobs):
        raise ValueError("同一提交的检查未通过，拒绝发布")
    if run.get("status") != "completed":
        return False
    if run.get("conclusion") != "success":
        raise ValueError("完整检查未成功，拒绝发布")
    if len(jobs) != len(EXPECTED) or {j.get("name") for j in jobs} != EXPECTED:
        raise ValueError("缺少规定的完整检查任务")
    for job in jobs:
        if job.get("status") != "completed" or job.get("conclusion") != "success":
            raise ValueError("检查任务尚未全部成功")
        steps = job.get("steps", [])
        required = ("Run uv run python tools/test-shard.py --index "
                    + job["name"].removeprefix("foundation (").removesuffix(")") + " --count 8")
        if not any(s.get("name", "").startswith(required) and s.get("conclusion") == "success"
                   and s.get("status") == "completed" for s in steps):
            raise ValueError("缺少实际执行成功的测试步骤")
        if any(s.get("conclusion") in {"failure", "cancelled", "timed_out"} for s in steps):
            raise ValueError("检查包含失败步骤")
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--timeout", type=int, default=7200)
    args = parser.parse_args()
    repository, revision = os.environ["GH_REPO"], os.environ["REVISION"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("发布来源标识无效")
    def get(path):
        request = urllib.request.Request("https://api.github.com/repos/" + repository + path,
            headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
                     "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    deadline = time.monotonic() + max(1, min(args.timeout, 7200))
    while True:
        query = urllib.parse.urlencode({"head_sha": revision, "branch": "main", "event": "push", "per_page": 100})
        run = select_run(get("/actions/workflows/checks.yml/runs?" + query)["workflow_runs"], repository, revision)
        if run:
            result = get(f"/actions/runs/{run['id']}/jobs?filter=latest&per_page=100")
            if result["total_count"] != len(result["jobs"]):
                raise ValueError("检查任务列表不完整")
            if passed(run, result["jobs"]):
                print(json.dumps({"完整检查": "通过", "revision": revision, "run": run["id"]}, ensure_ascii=False))
                return
        if time.monotonic() >= deadline:
            raise TimeoutError("等待完整检查超时，未发布镜像")
        print("等待同一提交的完整检查；不重复执行全量测试。", flush=True)
        time.sleep(min(30, max(0, deadline - time.monotonic())))


if __name__ == "__main__":
    main()
