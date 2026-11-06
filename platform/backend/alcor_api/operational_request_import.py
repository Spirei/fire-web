"""Capture enrolled request-history pages, then apply them once without native double counting."""

import asyncio
import hashlib
import json
import math
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .operational_source_data import read_logs
from .operational_source_registry import load_operational_sources
from .security import Identity, administrator, lock_mutation_identity
from .source_snapshot import SourceMismatch, canonical, sha

router = APIRouter(prefix="/api", tags=["operational-request-history"])
Admin = Annotated[Identity, Depends(administrator)]
SCOPE = "global-request-history"
KINDS = {"requests", "request_daily", "request_hours"}
SHANGHAI = ZoneInfo("Asia/Shanghai")


class Grant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sourceAlias: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,62}$")
    requestId: UUID
    password: str = Field(min_length=1, max_length=200)
    code: str = Field(min_length=1, max_length=64)


class Capture(Grant):
    kind: str = Field(pattern=r"^(requests|request_daily|request_hours)$")


class Apply(BaseModel):
    model_config = ConfigDict(extra="forbid")
    captureId: UUID
    requestId: UUID
    password: str = Field(min_length=1, max_length=200)
    code: str = Field(min_length=1, max_length=64)


class Close(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: UUID
    password: str = Field(min_length=1, max_length=200)
    code: str = Field(min_length=1, max_length=64)


def instance_of(source):
    return sha(canonical(["operational-request-claim/1", source.owner, source.physical]))


def fingerprint(parts):
    return sha(canonical(parts))


def jsonb(value):
    return None if value is None else Jsonb(value)


async def body(request, model):
    from .profile_http import bounded_body
    from .resource_api import no_duplicate_object

    try:
        return model.model_validate(
            json.loads(await bounded_body(request, 8192), object_pairs_hook=no_duplicate_object)
        )
    except (ValueError, TypeError, ValidationError, UnicodeError):
        raise HTTPException(422, "请求历史字段无效") from None


def source_for(settings, alias):
    try:
        found = load_operational_sources(settings)
    except SourceMismatch:
        raise HTTPException(403, "该运行来源未明确登记") from None
    source = found.get(alias)
    if source is None:
        raise HTTPException(403, "该运行来源未明确登记")
    return source


async def confirm(request, conn, who, password, code):
    await request.app.state.native_passkeys.step_up(conn, who, password, code)
    factor = await request.app.state.native_passkeys.factors.factor(conn, who.id)
    if not factor or not factor["totp_enabled"]:
        raise HTTPException(409, "请先启用二次验证")


async def limited(request, who):
    if not await request.app.state.rate_limit(
        request.app.state.db, "operational-request:" + who.id, 30, window_seconds=3600
    ):
        raise HTTPException(429, "请求历史捕获过于频繁")


async def operation(conn, who, request_id, digest):
    row = await (
        await conn.execute(
            "SELECT fingerprint, result FROM operational_request_operations WHERE actor_id=%s AND request_id=%s",
            (who.id, request_id),
        )
    ).fetchone()
    closed = await (
        await conn.execute(
            "SELECT 1 FROM operational_request_closed_operations WHERE actor_id=%s AND request_id=%s",
            (who.id, request_id),
        )
    ).fetchone()
    if row and row["fingerprint"] == digest:
        return row["result"]
    if closed:
        raise HTTPException(409, "原请求历史操作已关闭，请查询原编号")
    if row:
        raise HTTPException(409, "原操作编号与来源内容不符")
    return None


async def remember(conn, who, request_id, digest, result, action, target):
    await conn.execute(
        "INSERT INTO operational_request_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
        (who.id, request_id, digest, Jsonb(result)),
    )
    await conn.execute(
        "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
        (who.id, action, target, request_id),
    )
    return result


async def claim_for(conn, source):
    instance = instance_of(source)
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("operational-request:" + instance,)
    )
    claim = await (
        await conn.execute("SELECT * FROM operational_request_claims WHERE source_instance=%s", (instance,))
    ).fetchone()
    if claim and (claim["root_identity"] != source.physical or claim["binding_hash"] != source.binding):
        raise HTTPException(409, "来源绑定已变化，请重新核对")
    if claim is None:
        other = await (
            await conn.execute(
                "SELECT 1 FROM operational_request_claims WHERE root_identity=%s", (source.physical,)
            )
        ).fetchone()
        if other:
            raise HTTPException(409, "该运行来源已被认领")
    return instance, claim


def opened(source):
    try:
        source.require_access(SCOPE)
    except SourceMismatch as error:
        if str(error) == "operational_source_scope_not_registered":
            raise HTTPException(403, "该运行来源未授予全局请求历史") from None
        raise HTTPException(409, "运行来源未能核对") from None


async def permission_row(conn, instance, *, lock=True):
    query = "SELECT * FROM operational_request_permissions WHERE source_instance=%s"
    if lock:
        query += " FOR UPDATE"
    return await (await conn.execute(query, (instance,))).fetchone()


async def progress_row(conn, permission_id, kind):
    return await (
        await conn.execute(
            "SELECT * FROM operational_request_progress WHERE permission_id=%s AND kind=%s FOR UPDATE",
            (permission_id, kind),
        )
    ).fetchone()


def flags(page):
    if (
        page.get("captureComplete")
        or page.get("historicalCoverageKnown")
        or not page.get("pageSnapshotComplete")
    ):
        raise HTTPException(409, "来源页不能当作完整历史")
    token = page.get("sourceToken") or {}
    if (
        type(token.get("maxDetailId")) is not int
        or type(token.get("retainedDetailCount")) is not int
        or not isinstance(page.get("rows"), list)
        or len(page["rows"]) > 500
    ):
        raise HTTPException(409, "运行来源未能核对")
    return token


@router.post("/operational-sources/request-history/permissions")
async def grant(request: Request, who: Admin):
    data = await body(request, Grant)
    await limited(request, who)
    source = source_for(request.app.state.settings, data.sourceAlias)
    opened(source)
    digest = fingerprint(
        ["operational-request-permission/1", data.sourceAlias, source.physical, source.binding]
    )
    try:
        async with request.app.state.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            previous = await operation(conn, who, data.requestId, digest)
            if previous:
                return previous
            await confirm(request, conn, who, data.password, data.code)
            instance, claim = await claim_for(conn, source)
            if claim:
                current = await permission_row(conn, instance)
                if current and current["active"]:
                    raise HTTPException(409, "全局请求历史授权已存在，请查询原回执")
                if not current:
                    raise HTTPException(409, "运行来源未能核对")
                revision = current["revision"] + 1
                await conn.execute(
                    "UPDATE operational_request_permissions SET active=true, revision=%s, actor_id=%s WHERE id=%s",
                    (revision, who.id, current["id"]),
                )
                permission_id = current["id"]
            else:
                revision = 1
                permission_id = uuid4()
                await conn.execute(
                    """INSERT INTO operational_request_claims(
                        source_instance,root_identity,source_alias,source_owner,binding_hash)
                       VALUES(%s,%s,%s,%s,%s)""",
                    (instance, source.physical, source.alias, source.owner, source.binding),
                )
                await conn.execute(
                    """INSERT INTO operational_request_permissions(id,source_instance,actor_id,revision,active)
                       VALUES(%s,%s,%s,1,true)""",
                    (permission_id, instance, who.id),
                )
                for kind in ("requests", "request_daily", "request_hours"):
                    await conn.execute(
                        "INSERT INTO operational_request_progress(permission_id,kind) VALUES(%s,%s)",
                        (permission_id, kind),
                    )
            result = {
                "requestId": str(data.requestId),
                "state": "permitted",
                "sourceAlias": source.alias,
                "sourceInstance": instance,
                "scope": SCOPE,
                "revision": revision,
                "captureComplete": False,
                "historicalCoverageKnown": False,
            }
            return await remember(
                conn, who, data.requestId, digest, result, "operational-request.permitted", instance
            )
    except UniqueViolation:
        raise HTTPException(409, "该运行来源已被认领") from None


@router.post("/operational-sources/request-history/revocations")
async def revoke(request: Request, who: Admin):
    data = await body(request, Grant)
    await limited(request, who)
    source = source_for(request.app.state.settings, data.sourceAlias)
    digest = fingerprint(["operational-request-revocation/1", data.sourceAlias, source.physical])
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who)
        previous = await operation(conn, who, data.requestId, digest)
        if previous:
            return previous
        await confirm(request, conn, who, data.password, data.code)
        instance, claim = await claim_for(conn, source)
        current = await permission_row(conn, instance) if claim else None
        if not current or not current["active"]:
            raise HTTPException(409, "全局请求历史授权已撤销")
        revision = current["revision"] + 1
        await conn.execute(
            "UPDATE operational_request_permissions SET active=false, revision=%s WHERE id=%s",
            (revision, current["id"]),
        )
        result = {
            "requestId": str(data.requestId),
            "state": "revoked",
            "sourceAlias": source.alias,
            "sourceInstance": instance,
            "revision": revision,
            "captureComplete": False,
            "historicalCoverageKnown": False,
        }
        return await remember(
            conn, who, data.requestId, digest, result, "operational-request.revoked", instance
        )


@router.post("/operational-sources/request-history/captures")
async def capture(request: Request, who: Admin):
    data = await body(request, Capture)
    await limited(request, who)
    source = source_for(request.app.state.settings, data.sourceAlias)
    opened(source)
    instance = instance_of(source)
    digest = fingerprint(["operational-request-capture/1", instance, data.kind])
    try:
        async with request.app.state.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            previous = await operation(conn, who, data.requestId, digest)
            if previous:
                return previous
            await confirm(request, conn, who, data.password, data.code)
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("operational-request:" + instance,)
            )
            claim = await (
                await conn.execute(
                    "SELECT * FROM operational_request_claims WHERE source_instance=%s", (instance,)
                )
            ).fetchone()
            current = await permission_row(conn, instance)
            if (
                not claim
                or not current
                or not current["active"]
                or claim["binding_hash"] != source.binding
                or claim["root_identity"] != source.physical
            ):
                raise HTTPException(
                    409,
                    "请先确认全局请求历史授权"
                    if not current or not current["active"]
                    else "来源绑定已变化，请重新核对",
                )
            progress = await progress_row(conn, current["id"], data.kind)
            if progress is None:
                raise HTTPException(409, "运行来源未能核对")
            cursor = progress["cursor"]
            if cursor is not None and not isinstance(cursor, list):
                raise HTTPException(409, "来源进度游标无效")
            try:
                page = await asyncio.to_thread(read_logs, source, data.kind, cursor)
            except (OSError, ValueError, TypeError, KeyError, UnicodeError, SourceMismatch):
                raise HTTPException(409, "运行来源未能核对") from None
            token = flags(page)
            if page["cursorBefore"] != cursor:
                raise HTTPException(409, "运行来源未能核对")
            raw = page["rows"]
            raw_sha = sha(canonical(raw))
            capture_id = uuid4()
            await conn.execute(
                """INSERT INTO operational_request_captures(
                    id,permission_id,permission_revision,kind,cursor_before,cursor_after,page_exhausted,
                    page_snapshot_complete,schema_sha256,raw_sha256,max_detail_id,retained_detail_count,row_count,raw)
                   VALUES(%s,%s,%s,%s,%s,%s,%s,true,%s,%s,%s,%s,%s,%s)""",
                (
                    capture_id,
                    current["id"],
                    current["revision"],
                    data.kind,
                    jsonb(page["cursorBefore"]),
                    jsonb(page["cursorAfter"]),
                    page["exhausted"],
                    page["schemaSha256"],
                    raw_sha,
                    token["maxDetailId"],
                    token["retainedDetailCount"],
                    len(raw),
                    Jsonb(raw),
                ),
            )
            result = {
                "requestId": str(data.requestId),
                "state": "captured",
                "sourceAlias": source.alias,
                "sourceInstance": instance,
                "kind": data.kind,
                "captureId": str(capture_id),
                "rowCount": len(raw),
                "cursorAfter": page["cursorAfter"],
                "pageExhausted": page["exhausted"],
                "pageSnapshotComplete": True,
                "captureComplete": False,
                "historicalCoverageKnown": False,
                "rawSha256": raw_sha,
                "applied": False,
            }
            return await remember(
                conn, who, data.requestId, digest, result, "operational-request.captured", str(capture_id)
            )
    except UniqueViolation:
        raise HTTPException(409, "该运行来源已被认领") from None


def bucket_for(kind, row):
    if kind == "request_hours":
        if row.get("total_ms") is not None:
            raise HTTPException(409, "旧小时汇总没有时长，不能补写")
        return "hour", datetime.fromtimestamp(row["hour"] / 1000, UTC), None
    if (
        row.get("total_ms") is None
        or type(row["total_ms"]) not in (int, float)
        or not math.isfinite(row["total_ms"])
    ):
        raise HTTPException(409, "旧日汇总时长缺失，不能补零")
    if row["total_ms"] < 0:
        raise HTTPException(409, "旧日汇总时长无效")
    return "day", datetime.strptime(row["day"], "%Y-%m-%d").replace(tzinfo=SHANGHAI), row["total_ms"]


async def merge_cell(conn, instance, unit, bucket, row, total_ms, capture_id):
    key = (instance, unit, bucket, row["path"], row["method"], row["source"], row["status"])
    existing = await (
        await conn.execute(
            """SELECT count, total_ms FROM operational_request_log_cells
               WHERE source_instance=%s AND unit=%s AND bucket=%s AND path=%s AND method=%s AND source=%s AND status=%s""",
            key,
        )
    ).fetchone()
    if existing is None:
        await conn.execute(
            """INSERT INTO operational_request_log_cells(
                source_instance,unit,bucket,path,method,source,status,count,total_ms,capture_id)
               VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (*key, row["count"], total_ms, capture_id),
        )
        return 1
    if existing["count"] > row["count"] or (
        unit == "day" and existing["total_ms"] is not None and existing["total_ms"] > total_ms
    ):
        raise HTTPException(409, "来源汇总变小或冲突，已保留原值")
    if unit == "hour" and (existing["total_ms"] is not None or total_ms is not None):
        raise HTTPException(409, "旧小时汇总没有时长，不能补写")
    if existing["count"] == row["count"] and existing["total_ms"] == total_ms:
        return 0
    await conn.execute(
        """UPDATE operational_request_log_cells SET count=%s, total_ms=%s, capture_id=%s
           WHERE source_instance=%s AND unit=%s AND bucket=%s AND path=%s AND method=%s AND source=%s AND status=%s""",
        (row["count"], total_ms, capture_id, *key),
    )
    return 0


async def merge_detail(conn, claim, row, capture_id):
    digest = sha(
        canonical(
            [row["id"], row["at"], row["path"], row["method"], row["source"], row["status"], row["duration"]]
        )
    )
    existing = await (
        await conn.execute(
            "SELECT digest FROM operational_request_log_rows WHERE source_instance=%s AND original_id=%s",
            (claim["source_instance"], row["id"]),
        )
    ).fetchone()
    if existing:
        if existing["digest"] != digest:
            raise HTTPException(409, "原请求明细与已捕获内容冲突")
        return 0
    key = UUID(bytes=hashlib.sha256(f"{claim['source_instance']}:{row['id']}".encode()).digest()[:16])
    await conn.execute(
        """INSERT INTO request_observations(observation_key,at,path,method,source,status,duration,imported_source)
           VALUES(%s,%s,%s,%s,%s,%s,%s,%s)""",
        (
            key,
            datetime.fromtimestamp(row["at"] / 1000, UTC),
            row["path"],
            row["method"],
            row["source"],
            row["status"],
            row["duration"],
            claim["root_identity"],
        ),
    )
    await conn.execute(
        """INSERT INTO operational_request_log_rows(source_instance,original_id,observation_key,capture_id,digest)
           VALUES(%s,%s,%s,%s,%s)""",
        (claim["source_instance"], row["id"], key, capture_id, digest),
    )
    return 1


async def perform_apply(request, who, data):
    """Apply one captured page in a single transaction. The route resolves this name when called."""
    digest = fingerprint(["operational-request-apply/1", str(data.captureId)])
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who)
        previous = await operation(conn, who, data.requestId, digest)
        if previous:
            return previous
        await confirm(request, conn, who, data.password, data.code)
        captured = await (
            await conn.execute("SELECT * FROM operational_request_captures WHERE id=%s", (data.captureId,))
        ).fetchone()
        if not captured:
            raise HTTPException(404, "未查到此捕获")
        if captured["capture_complete"] or captured["historical_coverage_known"]:
            raise HTTPException(409, "来源页不能当作完整历史")
        current = await (
            await conn.execute(
                "SELECT * FROM operational_request_permissions WHERE id=%s FOR UPDATE",
                (captured["permission_id"],),
            )
        ).fetchone()
        claim = await (
            await conn.execute(
                "SELECT * FROM operational_request_claims WHERE source_instance=(SELECT source_instance FROM operational_request_permissions WHERE id=%s)",
                (captured["permission_id"],),
            )
        ).fetchone()
        if not current or not current["active"] or current["revision"] != captured["permission_revision"]:
            raise HTTPException(409, "来源授权已变化，请重新捕获")
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
            ("operational-request:" + claim["source_instance"],),
        )
        progress = await progress_row(conn, current["id"], captured["kind"])
        if progress is None or progress["cursor"] != captured["cursor_before"]:
            raise HTTPException(409, "该捕获还不是下一次可应用的页")
        added = 0
        if captured["kind"] == "requests":
            for row in captured["raw"]:
                added += await merge_detail(conn, claim, row, captured["id"])
            await conn.execute(
                "UPDATE request_rollup_state SET revision=greatest(revision,(SELECT coalesce(max(id),0) FROM request_observations)) WHERE singleton"
            )
        else:
            for row in captured["raw"]:
                unit, bucket, total_ms = bucket_for(captured["kind"], row)
                added += await merge_cell(
                    conn, claim["source_instance"], unit, bucket, row, total_ms, captured["id"]
                )
        revised = progress["revision"] + 1
        moved = await conn.execute(
            """UPDATE operational_request_progress
               SET revision=%s, cursor=%s, page_exhausted=%s, applied_rows=applied_rows+%s
               WHERE permission_id=%s AND kind=%s AND revision=%s""",
            (
                revised,
                jsonb(captured["cursor_after"]),
                captured["page_exhausted"],
                added,
                current["id"],
                captured["kind"],
                progress["revision"],
            ),
        )
        if moved.rowcount != 1:
            raise HTTPException(409, "该捕获还不是下一次可应用的页")
        result = {
            "requestId": str(data.requestId),
            "state": "applied",
            "sourceInstance": claim["source_instance"],
            "kind": captured["kind"],
            "captureId": str(captured["id"]),
            "appliedRows": added,
            "pageExhausted": captured["page_exhausted"],
            "pageSnapshotComplete": True,
            "captureComplete": False,
            "historicalCoverageKnown": False,
            "progressRevision": revised,
        }
        if captured["kind"] == "request_hours":
            result["hourTotalMsKnown"] = False
        return await remember(
            conn, who, data.requestId, digest, result, "operational-request.applied", str(captured["id"])
        )


@router.post("/operational-sources/request-history/applications")
async def apply_capture(request: Request, who: Admin):
    data = await body(request, Apply)
    await limited(request, who)
    return await perform_apply(request, who, data)


@router.post("/operational-sources/request-history/closures")
async def close(request: Request, who: Admin):
    data = await body(request, Close)
    await limited(request, who)
    digest = fingerprint(["operational-request-close/1", str(data.requestId)])
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who)
        previous = await operation(conn, who, data.requestId, digest)
        if previous:
            return previous
        await confirm(request, conn, who, data.password, data.code)
        await conn.execute(
            "INSERT INTO operational_request_closed_operations(actor_id,request_id) VALUES(%s,%s)",
            (who.id, data.requestId),
        )
        result = {
            "requestId": str(data.requestId),
            "state": "closed",
            "captureComplete": False,
            "historicalCoverageKnown": False,
        }
        return await remember(
            conn, who, data.requestId, digest, result, "operational-request.closed", str(data.requestId)
        )


@router.get("/operational-sources/request-history/receipts/{request_id}")
async def receipt(request_id: UUID, request: Request, who: Admin):
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who)
        row = await (
            await conn.execute(
                "SELECT result FROM operational_request_operations WHERE actor_id=%s AND request_id=%s",
                (who.id, request_id),
            )
        ).fetchone()
    if not row:
        raise HTTPException(404, "未查到此请求的回执")
    return row["result"]
