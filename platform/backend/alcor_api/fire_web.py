"""Fire Web administration over the existing native PG authorities.

The legacy browser session is explicit here. Native bearer tokens and unrelated
platform cookies never acquire infrastructure-management permissions.
"""

import re
import secrets
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from starlette.responses import JSONResponse, Response
from pydantic import Field

from . import tasks
from .admin_verification import VerificationInput, verify_admin_access
from .connection_models import ConnectionInput, ConnectionReceiptOut, ConnectionSettingsOut, Kind
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, public_profile, web_identity
from .models import OverviewOut, TaskDetail, TaskInput, TaskList, TaskOut, TaskStatus
from .security import Identity, csrf_token, trusted_origin
from .system_overview import read_overview

router = APIRouter(prefix="/api/fire", tags=["fire-web"])


class FireConnectionInput(ConnectionInput):
    reuse_current_password: bool = Field(default=False, strict=True)


async def member(request: Request):
    if request.headers.get("authorization") is not None:
        raise HTTPException(403, "请使用 Fire 网页会话")
    current, old = request.cookies.get(WEB_COOKIE), request.cookies.get(OLD_COOKIE)
    if current and old and current != old:
        raise HTTPException(403, "网页登录身份不一致，请重新登录")
    who, _, token = await web_identity(request, request.app.state.db, origin_checked=True)
    expected = csrf_token(token)
    binding = request.headers.get("x-csrf-token")
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        trusted_origin(request)
        if (
            binding is None
            or not re.fullmatch(r"[0-9a-f]{64}", binding)
            or not secrets.compare_digest(binding, expected)
        ):
            raise HTTPException(403, "操作校验已失效，请刷新页面")
    elif binding is not None and (
        not re.fullmatch(r"[0-9a-f]{64}", binding) or not secrets.compare_digest(binding, expected)
    ):
        raise HTTPException(
            403, "登录身份已变化，请重新读取当前账号", headers={"X-Alcor-Session-Changed": "true"}
        )
    who.csrf = expected
    return who


async def administrator(who: Annotated[Identity, Depends(member)]):
    if who.role != "admin":
        raise HTTPException(403, "需要管理员权限")
    return who


Member = Annotated[Identity, Depends(member)]
Admin = Annotated[Identity, Depends(administrator)]


@router.get("/session")
async def session(request: Request, who: Member):
    async with request.app.state.db.connection() as conn:
        user = await public_profile(conn, who.id)
    return {"user": user, "csrf": who.csrf, "instance_id": str(request.app.state.settings.instance_id)}


@router.get("/funds")
async def funds(request: Request, who: Member):
    from .legacy_fund_sources import LegacyFunds

    service = LegacyFunds(request.app.state.db)
    async with service.funds.context(who, shared_read=True) as conn:
        return await service.state_on_connection(conn, who)


@router.get("/system/overview", response_model=OverviewOut)
async def overview(request: Request, who: Admin):
    result = await read_overview(request.app, who)
    if getattr(request.app.state, "fire_version", ""):
        result["version"] = request.app.state.fire_version
    return result


@router.get("/connections/{kind}", response_model=ConnectionSettingsOut)
async def connection(kind: Kind, request: Request, who: Admin):
    result = await request.app.state.connections.read(kind)
    if result["config"] is None and (kind == "postgresql" or request.app.state.db.settings.redis_url):
        from .connections import current_config

        config, password = current_config(request.app.state.db.settings, kind)
        result.update(effective=config, password_set=bool(password))
    return result


@router.get('/system/interface-checks')
async def interface_checks(request: Request, who: Admin):
    from .interface_checks import snapshot
    from .security import digest
    if not await request.app.state.rate_limit(request.app.state.db, digest('interface-checks:' + who.id), 30, window_seconds=60):
        raise HTTPException(429, '检测记录读取过于频繁')
    return await snapshot(request.app, who)


@router.get('/system/interface-checks/receipts/{identifier}')
async def interface_check_receipt(identifier: UUID, request: Request, who: Admin):
    authority = request.app.state.market_authority
    async with authority.db.connection() as conn, conn.transaction():
        from .security import lock_mutation_identity
        await lock_mutation_identity(conn, who, require_admin=True)
        result = await authority.receipt(conn, who.id, identifier)
        if result.get('kind') != 'futu.test':
            raise HTTPException(404, '检测回执不存在')
        await authority.config(conn, who.id, UUID(result['sourceRevision']))
        return result


@router.post("/connections/reauthenticate", status_code=204)
async def verify_connection(data: VerificationInput, request: Request, who: Admin):
    return await verify_admin_access(data, request, who, "connection")


@router.post("/connections/{kind}/test", response_model=ConnectionReceiptOut)
async def test_connection(kind: Kind, data: FireConnectionInput, request: Request, who: Admin):
    if data.config.kind != kind:
        raise HTTPException(422, "连接类型不匹配")
    return await request.app.state.connections.operate(who, data, "test")


@router.put("/connections/{kind}", response_model=ConnectionReceiptOut)
async def save_connection(kind: Kind, data: FireConnectionInput, request: Request, who: Admin):
    if data.config.kind != kind:
        raise HTTPException(422, "连接类型不匹配")
    return await request.app.state.connections.operate(who, data, "save")


@router.get("/connections/{kind}/receipts/{request_id}", response_model=ConnectionReceiptOut)
async def connection_receipt(kind: Kind, request_id: UUID, request: Request, who: Admin):
    async with request.app.state.db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT result FROM connection_receipts WHERE owner_id=%s AND kind=%s AND request_id=%s",
                (who.id, kind, request_id),
            )
        ).fetchone()
    if not row:
        raise HTTPException(404, "未查到此请求的回执")
    result = dict(row["result"])
    if result["status"] == "pending" and request.app.state.connections.applied.get(kind) == UUID(
        result["revision"]
    ):
        result.update(status="saved", message="已保存并应用")
    return result


@router.get("/tasks", response_model=TaskList)
async def task_list(
    request: Request,
    who: Admin,
    limit: int = Query(25, ge=1, le=100),
    cursor: str | None = Query(None, max_length=256),
    status: TaskStatus | None = None,
):
    return await tasks.list_tasks(request.app.state.db, who, limit, cursor, status)


@router.post("/tasks", response_model=TaskOut, status_code=202)
async def create_task(data: TaskInput, request: Request, who: Admin):
    return await tasks.submit(request.app.state.db, who, data)


@router.get("/tasks/receipts/{request_id}", response_model=TaskOut)
async def task_receipt(request_id: UUID, request: Request, who: Admin):
    async with request.app.state.db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT * FROM tasks WHERE owner_id=%s AND request_id=%s", (who.id, request_id)
            )
        ).fetchone()
    if not row:
        raise HTTPException(404, "未查到此请求的受理回执")
    return row


@router.get("/tasks/{task_id}", response_model=TaskDetail)
async def task_detail(task_id: UUID, request: Request, who: Admin):
    return await tasks.detail(request.app.state.db, who, task_id)


@router.post("/tasks/{task_id}/cancel", response_model=TaskOut)
async def cancel_task(task_id: UUID, request: Request, who: Admin):
    return await tasks.cancel(request.app.state.db, who, task_id)


@router.get("/system/api-migration")
async def api_migration(request: Request, who: Admin):
    from .fire_api_surface import read_catalogue
    from .request_timing import measure

    try:
        with measure('catalogue'):
            result = await read_catalogue(request.app)
        etag = result["etag"]
        candidates = request.headers.get("if-none-match", "").split(",")
        if any(value.strip().removeprefix("W/") == etag.removeprefix("W/") or value.strip() == "*" for value in candidates):
            return Response(status_code=304, headers={"etag": etag, "cache-control": "private, no-store"})
        with measure('json_encode'):
            return JSONResponse(result, headers={"etag": etag, "cache-control": "private, no-store"})
    except (OSError, ValueError):
        raise HTTPException(503, "Fire API 清单尚未生成") from None


@router.get("/backups")
async def backup_list(request: Request, who: Admin):
    import hashlib

    from .backup_stream_codec import StreamFailure
    from .backup_stream_storage import existing_key
    from .backups import list_backups

    result = await list_backups(request, who)
    result["key_fingerprint"] = None
    result["key_error"] = None
    try:
        key = existing_key(request.app.state.settings)
        result["key_fingerprint"] = hashlib.sha256(key).hexdigest()
    except FileNotFoundError:
        if result["items"]:
            result["key_error"] = "恢复密钥缺失，请找回原 backup.key，不能重新生成替代密钥。"
    except (OSError, ValueError, StreamFailure):
        if result["configured"]:
            result["key_error"] = "恢复密钥或目录权限不正确，请核对私有密钥目录。"
    async with request.app.state.db.connection() as conn:
        row = await (await conn.execute(
            "SELECT coalesce(bool_or(observed_at>clock_timestamp()-interval '30 seconds'),false) AS online FROM worker_heartbeats"
        )).fetchone()
    result["worker_available"] = row["online"]
    return result


@router.post("/backups/prepare")
async def prepare_backup(request: Request, who: Admin):
    import asyncio
    import hashlib

    from .backups import BackupFailure, backup_key, private_dir, tools
    from .backup_stream_storage import existing_key
    from .backup_stream_codec import StreamFailure
    from .client_auth import recent
    from .security import lock_mutation_identity

    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who)
        await recent(conn, who)
        try:
            settings = request.app.state.settings
            # Validate tools/configuration before creating any recovery material.
            tools(settings, "pg_dump")
            tools(settings, "pg_restore")
            if not (settings.backup_dir and settings.backup_secret_dir and settings.connection_secret_dir):
                raise BackupFailure("请先配置私有备份目录和独立恢复密钥目录")
            try:
                key = await asyncio.to_thread(existing_key, settings)
            except FileNotFoundError:
                previous = await (await conn.execute("SELECT 1 FROM backups LIMIT 1")).fetchone()
                if previous:
                    raise BackupFailure("恢复密钥缺失，请找回原 backup.key，不能重新生成替代密钥。")
                key = await asyncio.to_thread(backup_key, settings)
            await asyncio.to_thread(private_dir, settings.backup_dir)
        except BackupFailure as exc:
            raise HTTPException(422, str(exc)) from None
        except (OSError, ValueError, StreamFailure):
            raise HTTPException(422, "备份目录不可写或恢复密钥权限不正确") from None
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action) VALUES(%s,'fire.backup.key.prepared')", (who.id,)
        )
    return {"key_fingerprint": hashlib.sha256(key).hexdigest()}


@router.get("/backups/{backup_id}/download")
async def backup_download(backup_id: UUID, request: Request, who: Admin):
    from .backups import download

    return await download(backup_id, request, who)
