"""Read-only GitHub observations adapted from fire-web deploy-status.
Never interpret a missing response as a successful check, zero history or a deployed image.
"""

import asyncio
import hashlib
import re
import time
from datetime import datetime
from functools import partial
from urllib.parse import quote
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Query, Request

from .deployments import GITHUB_EXECUTOR, Admin, configured, github_json

router = APIRouter(prefix="/api/deployment", tags=["deployment"])


async def github_read(settings, path, body=None):
    """Use the deploy executor, while keeping this module's provider hook patchable."""
    call = partial(github_json, settings, path) if body is None else partial(github_json, settings, path, body)
    return await asyncio.get_running_loop().run_in_executor(GITHUB_EXECUTOR, call)

# Commit history and repository owner metadata change rarely; live runs do not.
_ACTIVITY_CACHE = {}
_PACKAGE_CACHE = {}


def _scope_key(settings):
    token = getattr(settings, "deployment_github_token", None)
    return (
        getattr(settings, "deployment_repository", ""),
        getattr(settings, "deployment_image", ""),
        str(getattr(settings, "deployment_config_revision", "")),
        hashlib.sha256(token.get_secret_value().encode()).hexdigest() if token else "",
    )


STAGE_ORDER = {
    "Check scheduled source changes": 0,
    "检查定时源码变更": 0,
    "核对发布条件": 0,
    "源码与启动快检": 0.5,
    "TypeScript check": 1,
    "TypeScript 检查": 1,
    "完整平台检查": 1,
    "Publish linux/amd64 image": 2,
    "构建 linux/amd64 镜像": 2,
    "发布 linux/amd64 镜像": 2,
    "发布不可变版本清单": 3,
    "Publish immutable Fire manifest": 3,
}


async def publication_results(settings, runs, *, cache=None, limit=12, budget=3.0):
    """Historical job observations only; never a deployable-release proof.

    Completed publication evidence is immutable, so it is reused for the life
    of the process. A page can list a hundred runs; checking every older daily
    release on every refresh (and again when a short cache expires) could open
    dozens of jobs requests and exceed the reverse-proxy timeout. Unchecked or
    unavailable evidence stays "unknown" and is retried after a short grace.
    """
    gate = asyncio.Semaphore(5)
    deadline = time.monotonic() + budget
    checked = 0

    def remember(key, result):
        if cache is None:
            return
        ttl = 24 * 60 * 60 if result in {"published", "reused"} else 15
        if len(cache) >= 512:
            cache.pop(next(iter(cache)))
        cache[key] = (time.monotonic() + ttl, result)

    async def outcome(run):
        nonlocal checked
        if run["workflow_path"] != ".github/workflows/docker-publish.yml" or run["event"] not in {
            "schedule", "workflow_dispatch"
        }:
            return None
        if run["status"] != "completed":
            return "pending"
        if run["conclusion"] != "success":
            return "failed"
        token = getattr(settings, "deployment_github_token", None)
        key = (getattr(settings, "deployment_repository", ""),
               str(getattr(settings, "deployment_config_revision", "")),
               hashlib.sha256(token.get_secret_value().encode()).hexdigest() if token else "",
               run["id"], run["sha"], run["updated_at"])
        cached = cache.get(key) if cache is not None else None
        if cached and cached[0] > time.monotonic():
            return cached[1]
        if checked >= limit or time.monotonic() >= deadline:
            return "unknown"
        checked += 1
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return "unknown"
        try:
            async with gate:
                raw = await asyncio.wait_for(
                    github_read(settings, f"/actions/runs/{run['id']}/jobs?per_page=100"),
                    timeout=remaining,
                )
            jobs = raw.get("jobs")
            if not isinstance(jobs, list) or raw.get("total_count", len(jobs)) > len(jobs):
                remember(key, "unknown")
                return "unknown"
            publish = [j for j in jobs if j.get("name") == "Publish linux/amd64 image"]
            if len(publish) == 1 and publish[0].get("status") == "completed":
                result = {"success": "published", "skipped": "reused"}.get(
                    publish[0].get("conclusion"), "unknown"
                )
                remember(key, result)
                return result
        except (TimeoutError, OSError, ValueError, KeyError, TypeError, AttributeError):
            remember(key, "unknown")
        return "unknown"

    return dict(zip((r["id"] for r in runs), await asyncio.gather(*(outcome(r) for r in runs))))


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
            raw, checks = await asyncio.gather(
                github_read(settings, "/commits/main"),
                github_read(
                    settings,
                    "/actions/workflows/" + getattr(settings, 'deployment_checks_workflow', 'docker-publish.yml') + "/runs?branch=main&event=push&per_page=5",
                ),
            )
            sha = raw["sha"]
            if not re.fullmatch(r"[a-f0-9]{40}", sha):
                raise ValueError("invalid source")
            result["source"] = {
                "sha": sha,
                "url": f"https://github.com/{settings.deployment_repository}/commit/{sha}",
            }
            for item in checks.get("workflow_runs", []):
                if item.get("head_sha") != sha:
                    continue
                check = run_view(settings, item)
                if check["sha"] == sha:
                    result["check"] = check
                break
        except (OSError, ValueError, KeyError, TypeError):
            result["source_error"] = "源码或当前提交检查暂不可用"

    async def build():
        try:
            # Push runs perform checks only. Keep the last actual publication
            # visible even when a newer main revision is being checked.
            pages = await asyncio.gather(*(
                github_read(settings,
                    f"/actions/workflows/docker-publish.yml/runs?per_page=1&branch=main&event={event}")
                for event in ("workflow_dispatch", "schedule")
            ))
            runs = [r for page in pages for r in page["workflow_runs"]
                    if r.get("event") in {"workflow_dispatch", "schedule"}
                    and r.get("path") == ".github/workflows/docker-publish.yml"]
            if not runs:
                return
            latest = run_view(settings, max(runs, key=lambda r: r["id"]))
            result["build"] = {**latest, "head_sha": latest["sha"], "created_at": latest["started_at"]}
            try:
                raw_jobs = await github_read(
                    settings, f"/actions/runs/{latest['id']}/jobs?per_page=20"
                )
                if not isinstance(raw_jobs.get("jobs"), list) or raw_jobs.get("total_count", len(raw_jobs.get("jobs") or [])) > len(raw_jobs.get("jobs") or []):
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
        key = _scope_key(settings)
        cached = _PACKAGE_CACHE.get(key)
        if cached and cached[0] > time.monotonic():
            if cached[1]:
                result["package_url"] = cached[1]
            return
        try:
            repo = await github_read(settings, "")
            owner = repo.get("owner", {})
            image_owner = settings.deployment_image.removeprefix("ghcr.io/").split("/", 1)[0]
            url = None
            if owner.get("login", "").lower() == image_owner.lower():
                url = package_page(settings, owner.get("type"))
                result["package_url"] = url
            if len(_PACKAGE_CACHE) >= 128:
                _PACKAGE_CACHE.pop(next(iter(_PACKAGE_CACHE)))
            _PACKAGE_CACHE[key] = (time.monotonic() + 60 * 60, url)
        except (OSError, ValueError, KeyError, TypeError):
            pass  # Repository metadata failure cannot hide a valid source or release check.

    try:
        await asyncio.wait_for(asyncio.gather(source(), build(), package()), timeout=5)
    except TimeoutError:
        # One provider read must not hold the whole status response past the
        # reverse-proxy timeout; return the observations that already landed.
        if result["source"] is None and result["source_error"] is None:
            result["source_error"] = "源码读取超时"
        if result["build"] is None and result["build_error"] is None:
            result["build_error"] = "构建状态读取超时"
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
        # 100 GitHub run records can exceed the fixed 1 MiB response budget.
        # Preserve the requested history window using bounded provider pages.
        size = min(per_page, 20)
        start = (page - 1) * per_page
        first_page = start // size + 1
        raw = await github_read(
            settings, f"/actions/runs?branch=main&per_page={size}&page={first_page}"
        )
        records = raw["workflow_runs"]
        offset = start % size
        if len(records) == size and offset + per_page > size:
            remaining = min(offset + per_page - size, max(0, raw.get("total_count", start + per_page) - (first_page - 1) * size - size))
            pages = await asyncio.gather(*(
                github_read(settings,
                    f"/actions/runs?branch=main&per_page={size}&page={number}")
                for number in range(first_page + 1, first_page + 1 + (remaining + size - 1) // size)
            ))
            records = records + [run for result in pages for run in result["workflow_runs"]]
        items = list({r["id"]: run_view(settings, r) for r in records[offset:offset + per_page]}.values())
        if not hasattr(request.app.state, "deployment_publications"):
            request.app.state.deployment_publications = {}
        outcomes = await publication_results(settings, items, cache=request.app.state.deployment_publications)
        for item in items:
            item["publication"] = outcomes[item["id"]]
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

    cache_key = (*_scope_key(settings), year)
    cached = _ACTIVITY_CACHE.get(cache_key)
    if cached and cached[0] > time.monotonic():
        return {**cached[1], "counts": dict(cached[1]["counts"])}

    def remember(payload, ttl):
        if len(_ACTIVITY_CACHE) >= 128:
            _ACTIVITY_CACHE.pop(next(iter(_ACTIVITY_CACHE)))
        _ACTIVITY_CACHE[cache_key] = (time.monotonic() + ttl, payload)

    # Four bounded pages in parallel. Truncation/failure is explicitly partial; no invented zero days.
    async def page(number):
        try:
            return await github_read(
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
                payload = {
                    "counts": counts,
                    "complete": False,
                    "year": year,
                    "loaded": len(seen),
                    "repository": settings.deployment_repository,
                }
                remember(payload, 5 * 60)
                return payload
        if len(items) < 50:
            complete = True
            break
    payload = {
        "counts": counts,
        "complete": complete,
        "year": year,
        "loaded": len(seen),
        "repository": settings.deployment_repository,
    }
    # The yearly commit heatmap is not a live signal; one query per hour keeps
    # the page off GitHub's commit history between pushes. Partial data retries
    # sooner so a transient provider failure can recover.
    remember(payload, 60 * 60 if complete else 5 * 60)
    return payload
