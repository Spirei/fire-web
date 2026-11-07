"""Independent release discovery and durable, fixed-target host update requests."""

import asyncio
import hashlib
import json
import urllib.error
import urllib.request
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from . import deployment_watchtower as bridge
from .models import InputModel
from .security import Identity, administrator, lock_mutation_identity

router = APIRouter(prefix="/api/deployment", tags=["deployment"])
Admin = Annotated[Identity, Depends(administrator)]


class Release(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    image: str = Field(pattern=r"^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$")
    revision: str = Field(pattern=r"^[a-f0-9]{40}$")
    schema_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class UpdateInput(InputModel):
    request_id: UUID
    release: Release


def schema_hash(directory):
    h = hashlib.sha256()
    for path in sorted(directory.glob("*.sql")):
        h.update(path.name.encode() + b"\0" + path.read_bytes() + b"\0")
    return h.hexdigest()


def configured(settings):
    return bool(settings.deployment_repository and settings.deployment_image)


def already_running(settings, release):
    return bool(release and bridge.runtime_matches(
        settings, release.model_dump(), version=__version__, schema=schema_hash(settings.migration_dir),
    ))


def github_json(settings, path, body=None):
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "AlcorApi-release",
        "Cache-Control": "no-cache",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if settings.deployment_github_token:
        headers["Content-Type"] = "application/json"
        headers["Authorization"] = "Bearer " + settings.deployment_github_token.get_secret_value()
    request = urllib.request.Request(
        "https://api.github.com/repos/" + settings.deployment_repository + path,
        headers=headers,
        data=json.dumps(body).encode() if body is not None else None,
        method="POST" if body is not None else "GET",
    )

    # Never forward repository credentials to a redirected host.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    with urllib.request.build_opener(NoRedirect).open(request, timeout=15 if body is not None else 4) as response:
        if response.status == 204:
            return {}
        data = response.read(1048577)
    if len(data) > 1048576:
        raise ValueError("response budget")
    return json.loads(data)


def release_published_at(raw):
    value = raw.get("published_at") if isinstance(raw, dict) else None
    if not isinstance(value, str):
        return None
    try:
        datetime.fromisoformat(value)
    except ValueError:
        return None
    return value


async def discover(settings):
    if not configured(settings):
        raise HTTPException(409, "尚未配置独立发布仓库")
    try:
        raw = await asyncio.to_thread(github_json, settings, "/releases/latest")
        if raw.get("draft") or raw.get("prerelease"):
            raise ValueError("not a published release")
        release = Release.model_validate_json(raw["body"])
        if release.image.split("@")[0] != settings.deployment_image:
            raise ValueError("wrong image target")
        if raw.get("target_commitish") != release.revision:
            raise ValueError("wrong revision")
        return release, release_published_at(raw)
    except (OSError, ValueError, KeyError, TypeError):
        raise HTTPException(503, "未取得有效发布记录，请检查仓库权限、发布结果与网络") from None


@router.get("")
async def status(request: Request, who: Admin):
    from .deployment_config import effective

    settings, db = await effective(request), request.app.state.db
    await bridge.reconcile(db, settings, version=__version__, schema=schema_hash(settings.migration_dir))
    from .deployment_observations import observation, package_page

    release, release_error, release_published_at = None, None, None
    observed = {
        "package_url": package_page(settings),
        "source": None,
        "check": None,
        "jobs": None,
        "jobs_error": None,
        "source_error": None,
        "build": None,
        "build_error": None,
    }
    if configured(settings):

        async def latest():
            nonlocal release, release_error, release_published_at
            try:
                release, release_published_at = await discover(settings)
            except HTTPException as exc:
                release_error = exc.detail

        async def observations():
            nonlocal observed
            observed = await observation(settings)

        await asyncio.gather(latest(), observations())
    async with db.connection() as conn:
        rows = await (
            await conn.execute(
                "SELECT id,request_id,image,version,revision,schema_hash,status,created_at,claimed_at,finished_at FROM deployment_requests WHERE owner_id=%s ORDER BY created_at DESC LIMIT 20",
                (who.id,),
            )
        ).fetchall()
        builds = await (
            await conn.execute(
                "SELECT request_id,status,created_at FROM deployment_builds WHERE repository=%s AND owner_id=%s ORDER BY created_at DESC LIMIT 10",
                (settings.deployment_repository, who.id),
            )
        ).fetchall()
        active = await (await conn.execute(
            "SELECT 1 FROM deployment_requests WHERE status IN ('queued','running','unknown') LIMIT 1",
        )).fetchone()
        ready = await bridge.runtime_ready(conn, version=__version__)
    runner = await asyncio.to_thread(bridge.probe, settings)
    compatible = bool(release and release.schema_hash == schema_hash(settings.migration_dir))
    matches = already_running(settings, release)
    return {
        "configured": configured(settings),
        "repository": settings.deployment_repository,
        "configuration_revision": settings.deployment_config_revision,
        "running_version": __version__,
        "running_image": settings.deployment_running_image or None,
        "running_revision": settings.source_revision or None,
        "runtime_ready": ready,
        "runtime_matches_release": matches,
        "matches_release": matches and ready,
        "release": release,
        "release_published_at": release_published_at,
        "release_error": release_error,
        **observed,
        "checked_at": datetime.now(UTC),
        "has_token": bool(settings.deployment_github_token),
        "build_requests": builds,
        "can_build": bool(configured(settings) and settings.deployment_github_token),
        "schema_compatible": compatible,
        "runner": runner,
        "receipts": rows,
        "can_update": bool(
            release
            and compatible
            and runner["configured"]
            and runner["online"]
            and not already_running(settings, release)
            and not active
        ),
    }


@router.post("/requests", status_code=202)
async def submit(data: UpdateInput, request: Request, who: Admin):
    from .deployment_config import effective, guard_generation

    settings, db = await effective(request), request.app.state.db
    await bridge.reconcile(db, settings, version=__version__, schema=schema_hash(settings.migration_dir))
    # An accepted UUID remains queryable even when GitHub is unavailable or the process restarted.
    async with db.connection() as conn:
        old = await (
            await conn.execute(
                "SELECT * FROM deployment_requests WHERE owner_id=%s AND request_id=%s",
                (who.id, data.request_id),
            )
        ).fetchone()
    if old:
        if any(old[k] != getattr(data.release, k) for k in ("image", "version", "revision", "schema_hash")):
            raise HTTPException(409, "此请求编号已用于不同版本")
        return public_receipt(old)
    release, _published = await discover(settings)
    if release != data.release:
        raise HTTPException(409, "发布版本已变化，请重新检查")
    if release.schema_hash != schema_hash(settings.migration_dir):
        raise HTTPException(409, "此版本需要单独执行数据库迁移")
    if already_running(settings, release):
        raise HTTPException(409, "此镜像已在运行")
    if not bridge.configured(settings):
        raise HTTPException(409, "尚未配置独立 Watchtower")
    runner = await asyncio.to_thread(bridge.probe, settings)
    if not runner["online"]:
        raise HTTPException(409, "无法连接独立 Watchtower")
    async with db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who, require_admin=True)
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('alcor.deployment',0))")
        await guard_generation(conn, settings)
        old = await (
            await conn.execute(
                "SELECT * FROM deployment_requests WHERE owner_id=%s AND request_id=%s",
                (who.id, data.request_id),
            )
        ).fetchone()
        if old:
            if any(old[k] != getattr(release, k) for k in ("image", "version", "revision", "schema_hash")):
                raise HTTPException(409, "此请求编号已用于不同版本")
            return public_receipt(old)
        active = await (
            await conn.execute("SELECT 1 FROM deployment_requests WHERE status IN ('queued','running','unknown')")
        ).fetchone()
        if active:
            raise HTTPException(409, "已有更新请求，请先核对回执")
        row = await (
            await conn.execute(
                "INSERT INTO deployment_requests (id,owner_id,request_id,image,version,revision,schema_hash,status) VALUES (%s,%s,%s,%s,%s,%s,%s,'queued') RETURNING *",
                (
                    uuid4(),
                    who.id,
                    data.request_id,
                    release.image,
                    release.version,
                    release.revision,
                    release.schema_hash,
                ),
            )
        ).fetchone()
        await conn.execute(
            "INSERT INTO audit_events (actor_id,action,target_id,request_id) VALUES (%s,'deployment.requested',%s,%s)",
            (who.id, str(row["id"]), data.request_id),
        )
    outcome = await bridge.dispatch(db, settings, row["id"])
    return {**public_receipt(outcome["receipt"]), "message": outcome["message"]}


def public_receipt(row):
    return {
        k: row[k]
        for k in ("id", "request_id", "image", "version", "revision", "schema_hash", "status", "created_at", "claimed_at", "finished_at")
    }


@router.get("/requests/{request_id}")
async def receipt(request_id: UUID, request: Request, who: Admin):
    from .deployment_config import effective

    settings, db = await effective(request), request.app.state.db
    await bridge.reconcile(db, settings, version=__version__, schema=schema_hash(settings.migration_dir))
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT * FROM deployment_requests WHERE owner_id=%s AND request_id=%s", (who.id, request_id)
            )
        ).fetchone()
    if not row:
        raise HTTPException(404, "未查到此更新请求")
    return public_receipt(row)


class CloseInput(InputModel):
    release: Release


@router.post("/requests/{request_id}/close")
async def close_request(request_id: UUID, data: CloseInput, request: Request, who: Admin):
    """Explicitly close observation; never cancels or repeats a Watchtower action."""
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who, require_admin=True)
        await conn.execute(bridge.LOCK)
        row = await (await conn.execute(
            "SELECT * FROM deployment_requests WHERE owner_id=%s AND request_id=%s FOR UPDATE",
            (who.id, request_id),
        )).fetchone()
        if not row:
            raise HTTPException(404, "未查到此更新请求")
        if any(row[k] != getattr(data.release, k) for k in ("image", "version", "revision", "schema_hash")):
            raise HTTPException(409, "原更新目标不符，请重新读取原回执")
        if row["status"] == "cancelled":
            return {**public_receipt(row), "message": "原更新记录已关闭"}
        if row["status"] not in {"queued", "running", "unknown"}:
            raise HTTPException(409, "此更新记录已有最终结果，请重新读取")
        row = await (await conn.execute(
            "UPDATE deployment_requests SET status='cancelled',finished_at=clock_timestamp() WHERE id=%s RETURNING *",
            (row["id"],),
        )).fetchone()
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'deployment.observation_closed',%s,%s)",
            (who.id, str(row["id"]), request_id),
        )
    return {**public_receipt(row), "message": "原更新记录已关闭；此操作不会中止已通知的 Watchtower"}


@router.post("/runner/claim", include_in_schema=False)
@router.post("/runner/finish", include_in_schema=False)
async def retired_runner():
    raise HTTPException(410, "自建更新执行器已停用，请使用独立 Watchtower")


class BuildInput(InputModel):
    request_id: UUID
    expected_revision: str | None = Field(default=None, pattern=r"^[a-f0-9]{40}$")


@router.post("/builds", status_code=202)
async def build_source(data: BuildInput, request: Request, who: Admin):
    from .deployment_config import effective, guard_generation

    settings, db = await effective(request), request.app.state.db
    if not configured(settings) or not settings.deployment_github_token:
        raise HTTPException(409, "尚未配置发布权限")
    # Replay needs no provider connectivity; never hold PG identity locks while
    # waiting for independent GitHub reads.
    async with db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who, require_admin=True)
        await guard_generation(conn, settings)
        old = await (await conn.execute(
            "SELECT request_id,status,created_at FROM deployment_builds WHERE owner_id=%s AND request_id=%s",
            (who.id, data.request_id),
        )).fetchone()
        if old:
            return old
    from .deployment_publication import preflight
    revision = await asyncio.to_thread(preflight, settings, github_json, Release)
    if data.expected_revision is not None and data.expected_revision != revision:
        raise HTTPException(409, "main 已变化，请刷新后重新确认构建目标")
    async with db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who, require_admin=True)
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('alcor.build',0))")
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('alcor.deployment',0))")
        await guard_generation(conn, settings)
        old = await (await conn.execute(
            "SELECT request_id,status,created_at FROM deployment_builds WHERE owner_id=%s AND request_id=%s",
            (who.id, data.request_id),
        )).fetchone()
        if old:
            return old
        active = await (await conn.execute(
            "SELECT 1 FROM deployment_builds WHERE repository=%s AND status<>'failed' AND created_at>clock_timestamp()-interval '5 minutes'",
            (settings.deployment_repository,),
        )).fetchone()
        if active:
            raise HTTPException(409, "刚刚已有构建请求，请核对 GitHub 构建状态")
        await conn.execute(
            "INSERT INTO deployment_builds (owner_id,request_id,status,repository) VALUES (%s,%s,'dispatching',%s)",
            (who.id, data.request_id, settings.deployment_repository),
        )
        await conn.execute(
            "INSERT INTO audit_events (actor_id,action,request_id) VALUES (%s,'deployment.build_requested',%s)",
            (who.id, data.request_id),
        )
    # Commit acceptance first. A crash or a lost HTTP response must never cause redispatch.
    state = "submitted"
    message = None
    try:
        await asyncio.to_thread(
            github_json,
            settings,
            "/actions/workflows/docker-publish.yml/dispatches",
            {"ref": "main", "inputs": {"request_id": str(data.request_id), "expected_revision": revision}},
        )
    except urllib.error.HTTPError as exc:
        # An explicit rejection is different from losing the dispatch response.
        # Never surface provider bodies: they may contain credentials or private context.
        if 400 <= exc.code < 500 and exc.code != 408:
            state = "failed"
            message = {
                401: "GitHub 授权已失效，请重新配置发布 Token",
                403: "GitHub 拒绝构建，请核对发布 Token 的 Actions 读写权限及仓库访问权限",
                404: "GitHub 未找到发布工作流或授权无权访问仓库，请核对仓库与 Token",
                422: "GitHub 拒绝了工作流参数，请核对 main 分支的发布工作流",
                429: "GitHub 请求过于频繁，请稍后再试",
            }.get(exc.code, "GitHub 未接受构建请求，请核对发布配置")
        else:
            state = "unknown"
    except (OSError, ValueError, KeyError, TypeError):
        state = "unknown"
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                "UPDATE deployment_builds SET status=%s WHERE owner_id=%s AND request_id=%s RETURNING request_id,status,created_at",
                (state, who.id, data.request_id),
            )
        ).fetchone()
    return {**row, **({"message": message} if message else {})}


@router.get("/builds/{request_id}")
async def build_receipt(request_id: UUID, request: Request, who: Admin):
    async with request.app.state.db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT request_id,status,created_at FROM deployment_builds WHERE owner_id=%s AND request_id=%s",
                (who.id, request_id),
            )
        ).fetchone()
    if not row:
        raise HTTPException(404, "未查到此构建请求")
    if row["status"] in {"unknown", "dispatching", "submitted"}:
        from .deployment_build_receipts import lookup_run
        from .deployment_config import effective

        settings = await effective(request)
        try:
            matched = await asyncio.to_thread(lookup_run, settings, github_json, request_id, created_at=row["created_at"])
        except (OSError, ValueError, KeyError, TypeError):
            matched = False
        if matched:
            status = "failed" if matched.get("status") == "completed" and matched.get("conclusion") != "success" else "submitted"
            async with request.app.state.db.connection() as conn:
                row = await (await conn.execute(
                    "UPDATE deployment_builds SET status=%s WHERE owner_id=%s AND request_id=%s AND status IN ('unknown','dispatching','submitted') RETURNING request_id,status,created_at",
                    (status, who.id, request_id),
                )).fetchone() or row
            if status == "failed":
                row = {**row, "message": "GitHub 镜像构建未成功，请查看对应运行日志"}
    return row
