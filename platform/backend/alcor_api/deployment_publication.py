"""Fail-closed publication preflight shared by every deployment protocol.

The new workflow's immutable release manifest is the publication proof; a
successful/skipped Actions job alone never proves a new image was published.
"""

import re
from concurrent.futures import ThreadPoolExecutor

from fastapi import HTTPException

ACTIVE = ("queued", "in_progress", "waiting", "pending", "requested")
WORKFLOW = ".github/workflows/docker-publish.yml"


def preflight(settings, github, release_type):
    try:
        def active_runs(status):
            return github(settings, f"/actions/workflows/docker-publish.yml/runs?branch=main&status={status}&per_page=100")

        # These independent reads must not consume five sequential network timeouts.
        with ThreadPoolExecutor(max_workers=len(ACTIVE)) as pool:
            results = list(pool.map(active_runs, ACTIVE))
        for result in results:
            runs = result["workflow_runs"]
            if not isinstance(runs, list) or len(runs) >= 100:
                raise ValueError("incomplete active history")
            for run in runs:
                if (
                    not isinstance(run, dict)
                    or not isinstance(run.get("event"), str)
                    or not isinstance(run.get("path"), str)
                ):
                    raise TypeError("incomplete run")
                if run.get("path") != WORKFLOW or run["event"] not in {"schedule", "workflow_dispatch"}:
                    continue
                raise HTTPException(409, "已有镜像发布正在排队或运行，请等待完成")
        main = github(settings, "/commits/main")["sha"]
        if not isinstance(main, str) or not re.fullmatch(r"[a-f0-9]{40}", main):
            raise ValueError("main revision unavailable")
        for page in range(1, 21):
            releases = github(settings, f"/releases?per_page=100&page={page}")
            if not isinstance(releases, list):
                raise TypeError("release history unavailable")
            for raw in releases:
                if not isinstance(raw, dict):
                    raise TypeError("release history malformed")
                if raw.get("draft") or raw.get("prerelease") or raw.get("target_commitish") != main:
                    continue
                release = release_type.model_validate_json(raw["body"])
                if release.revision != main or release.image.split("@")[0] != settings.deployment_image:
                    raise ValueError("published target mismatch")
                raise HTTPException(409, "当前 main 提交已有可用镜像，无需重复构建")
            if len(releases) < 100:
                return main
        raise ValueError("release history truncated")
    except HTTPException:
        raise
    except (OSError, ValueError, KeyError, TypeError):
        raise HTTPException(502, "无法完整核对已有镜像，暂未触发构建，请稍后重试") from None
