"""Read-only GitHub observations adapted from fire-web deploy-status.
Never interpret a missing response as a successful check, zero history or a deployed image.
"""

import asyncio
import re
from datetime import datetime
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request

from .deployments import Admin, configured, github_json

router = APIRouter(prefix="/api/deployment", tags=["deployment"])

STAGE_ORDER = {
    "Check scheduled source changes": 0,
    "检查定时源码变更": 0,
    "核对发布条件": 0,
    "TypeScript check": 1,
    "TypeScript 检查": 1,
    "完整平台检查": 1,
    "Publish linux/amd64 image": 2,
    "构建 linux/amd64 镜像": 2,
    "发布 linux/amd64 镜像": 2,
    "发布不可变版本清单": 3,
    "Publish immutable Fire manifest": 3,
}


def run_view(settings, raw):
    ident = raw.get("id")
    if not isinstance(ident, int) or ident < 1:
        raise ValueError("invalid workflow id")
    sha = raw.get("head_sha", "")
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("invalid workflow revision")
    return {
        "id": ident,
        "name": raw.get("name", ""),
        "title": raw.get("display_title") or raw.get("name", ""),
        "sha": sha,
        "status": raw.get("status"),
        "conclusion": raw.get("conclusion"),
        "event": raw.get("event"),
        "workflow_path": raw.get("path", ""),
        "started_at": raw.get("run_started_at") or raw.get("created_at"),
        "updated_at": raw.get("updated_at"),
        "url": f"https://github.com/{settings.deployment_repository}/actions/runs/{ident}",
    }


def package_page(settings, owner_type=None):
    image = settings.deployment_image.removeprefix("ghcr.io/")
    if "/" not in image:
        return None
    owner, name = image.split("/", 1)
    if not owner or not name:
        return None
    if owner_type not in {"User", "Organization"}:
        return f"https://github.com/{quote(owner, safe='')}?tab=packages"
    group = "orgs" if owner_type == "Organization" else "users"
    return f"https://github.com/{group}/{quote(owner, safe='')}/packages/container/{quote(name, safe='')}"


async def observation(settings):
    result = {
        "source": None,
        "package_url": package_page(settings),
        "check": None,
        "jobs": None,
        "jobs_error": None,
        "source_error": None,
        "build": None,
        "build_error": None,
    }

    async def source():
        try:
            raw = await asyncio.to_thread(github_json, settings, "/commits/main")
            sha = raw["sha"]
            if not re.fullmatch(r"[a-f0-9]{40}", sha):
                raise ValueError("invalid source")
            result["source"] = {
                "sha": sha,
                "url": f"https://github.com/{settings.deployment_repository}/commit/{sha}",
            }
            checks = await asyncio.to_thread(
                github_json,
                settings,
                "/actions/workflows/" + getattr(settings, 'deployment_checks_workflow', 'checks.yml') + "/runs?branch=main&per_page=1&head_sha=" + sha,
            )
            runs = checks.get("workflow_runs", [])
            if runs:
                check = run_view(settings, runs[0])
                if check["sha"] == sha:
                    result["check"] = check
        except (OSError, ValueError, KeyError, TypeError):
            result["source_error"] = "源码或当前提交检查暂不可用"

    async def build():
        try:
            raw = await asyncio.to_thread(
                github_json, settings, "/actions/workflows/docker-publish.yml/runs?per_page=1&branch=main"
            )
            runs = raw.get("workflow_runs", [])
            if not runs:
                return
            latest = run_view(settings, runs[0])
            result["build"] = {**latest, "head_sha": latest["sha"], "created_at": latest["started_at"]}
            try:
                raw_jobs = await asyncio.to_thread(
                    github_json, settings, f"/actions/runs/{latest['id']}/jobs?per_page=20"
                )
                if not isinstance(raw_jobs.get("jobs"), list):
                    raise TypeError("jobs missing")
                result["jobs"] = [
                    {
                        "id": j["id"],
                        "name": j["name"],
                        "status": j["status"],
                        "conclusion": j.get("conclusion"),
                        "started_at": j.get("started_at"),
                        "completed_at": j.get("completed_at"),
                        "steps": [
                            {
                                k: s.get(k)
                                for k in (
                                    "number",
                                    "name",
                                    "status",
                                    "conclusion",
                                    "started_at",
                                    "completed_at",
                                )
                            }
                            for s in j.get("steps", [])
                        ],
                    }
                    for j in raw_jobs["jobs"][:20]
                ]
                result["jobs"].sort(key=lambda job: (STAGE_ORDER.get(job["name"], 50), job["id"]))
            except (OSError, ValueError, KeyError, TypeError):
                result["jobs_error"] = "构建阶段暂不可用"
        except (OSError, ValueError, KeyError, TypeError):
            result["build_error"] = "构建状态暂不可用"

    async def package():
        try:
            repo = await asyncio.to_thread(github_json, settings, "")
            owner = repo.get("owner", {})
            image_owner = settings.deployment_image.removeprefix("ghcr.io/").split("/", 1)[0]
            if owner.get("login", "").lower() == image_owner.lower():
                result["package_url"] = package_page(settings, owner.get("type"))
        except (OSError, ValueError, KeyError, TypeError):
            pass  # Repository metadata failure cannot hide a valid source or release check.

    await asyncio.gather(source(), build(), package())
    return result


@router.get("/history")
async def history(request: Request, who: Admin, page: int = Query(1, ge=1, le=200)):
    return await history_page(request, who, page=page)


async def history_page(request, who, *, page=1, per_page=5):
    if not 1 <= page <= 200 or not 1 <= per_page <= 100:
        raise HTTPException(422, "运行记录分页无效")
    from .deployment_config import effective

    settings = await effective(request)
    if not configured(settings):
        return {
            "items": [],
            "total": None,
            "page": page,
            "configured": False,
            "repository": settings.deployment_repository,
        }
    try:
        raw = await asyncio.to_thread(
            github_json, settings, f"/actions/runs?branch=main&per_page={per_page}&page={page}"
        )
        items = [run_view(settings, r) for r in raw["workflow_runs"]]
        return {
            "items": items,
            "total": raw.get("total_count"),
            "page": page,
            "configured": True,
            "repository": settings.deployment_repository,
        }
    except (OSError, ValueError, KeyError, TypeError):
        raise HTTPException(503, "运行记录暂不可用") from None


@router.get("/activity")
async def activity(request: Request, who: Admin):
    from .deployment_config import effective

    settings = await effective(request)
    year = datetime.now(ZoneInfo("Asia/Shanghai")).year
    if not configured(settings):
        return {
            "counts": None,
            "complete": False,
            "year": year,
            "loaded": None,
            "repository": settings.deployment_repository,
        }

    # Four bounded pages in parallel. Truncation/failure is explicitly partial; no invented zero days.
    async def page(number):
        try:
            return await asyncio.to_thread(
                github_json,
                settings,
                f"/commits?sha=main&per_page=50&page={number}&since={year}-01-01T00:00:00%2B08:00&until={year + 1}-01-01T00:00:00%2B08:00",
            )
        except (OSError, ValueError, KeyError, TypeError):
            return None

    pages = await asyncio.gather(*(page(number) for number in range(1, 5)))
    if pages[0] is None:
        raise HTTPException(503, "提交热力图暂不可用")
    complete = False
    counts = {}
    seen = set()
    for items in pages:
        if items is None or not isinstance(items, list):
            break
        for item in items:
            try:
                if item["sha"] in seen:
                    continue
                stamp = item["commit"]["committer"]["date"]
                day = datetime.fromisoformat(stamp).astimezone(ZoneInfo("Asia/Shanghai")).strftime("%Y-%m-%d")
                if day.startswith(str(year) + "-"):
                    seen.add(item["sha"])
                    counts[day] = counts.get(day, 0) + 1
            except (ValueError, KeyError, TypeError):
                return {
                    "counts": counts,
                    "complete": False,
                    "year": year,
                    "loaded": len(seen),
                    "repository": settings.deployment_repository,
                }
        if len(items) < 50:
            complete = True
            break
    return {
        "counts": counts,
        "complete": complete,
        "year": year,
        "loaded": len(seen),
        "repository": settings.deployment_repository,
    }
