"""Archive the two fixed API documents, then apply one capture through the document transaction.

A finished file read does not make earlier document versions known. Apply uses the archived
bytes and does not open the source again.
"""

import asyncio
import json
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .api_documents import prepare_document
from .operational_source_data import read_document
from .operational_source_registry import load_operational_sources
from .security import Identity, administrator, lock_mutation_identity
from .source_snapshot import SourceMismatch, canonical, sha

router = APIRouter(prefix="/api", tags=["operational-document-import"])
Admin = Annotated[Identity, Depends(administrator)]
SCOPE = "global-api-documents"


class Grant(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sourceAlias: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,62}$")
    requestId: UUID
    password: str = Field(min_length=1, max_length=200)
    code: str = Field(min_length=1, max_length=64)


class Capture(Grant):
    version: int = Field(ge=1, le=2)


class Apply(BaseModel):
    model_config = ConfigDict(extra="forbid")
    captureId: UUID
    requestId: UUID
    expectedRevision: str | None
    password: str = Field(min_length=1, max_length=200)
    code: str = Field(min_length=1, max_length=64)

    @field_validator("expectedRevision")
    @classmethod
    def revision(cls, value):
        if value is not None and (len(value) != 64 or any(c not in "0123456789abcdef" for c in value)):
            raise ValueError("revision")
        return value


class Close(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: UUID
    password: str = Field(min_length=1, max_length=200)
    code: str = Field(min_length=1, max_length=64)


def instance_of(source):
    return sha(canonical(["operational-document-claim/1", source.owner, source.physical]))


def fingerprint(parts):
    return sha(canonical(parts))


async def body(request, model):
    from .profile_http import bounded_body
    from .resource_api import no_duplicate_object

    try:
        return model.model_validate(
            json.loads(await bounded_body(request, 8192), object_pairs_hook=no_duplicate_object)
        )
    except (ValueError, TypeError, ValidationError, UnicodeError):
        raise HTTPException(422, "API文档来源字段无效") from None


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
        request.app.state.db, "operational-document:" + who.id, 30, window_seconds=3600
    ):
        raise HTTPException(429, "API文档捕获过于频繁")


async def operation(conn, who, request_id, digest):
    row = await (
        await conn.execute(
            "SELECT fingerprint, result FROM operational_document_operations WHERE actor_id=%s AND request_id=%s",
            (who.id, request_id),
        )
    ).fetchone()
    closed = await (
        await conn.execute(
            "SELECT 1 FROM operational_document_closed_operations WHERE actor_id=%s AND request_id=%s",
            (who.id, request_id),
        )
    ).fetchone()
    if row and row["fingerprint"] == digest:
        return row["result"]
    if closed:
        raise HTTPException(409, "原API文档来源操作已关闭，请查询原编号")
    if row:
        raise HTTPException(409, "原操作编号与来源内容不符")
    return None


async def remember(conn, who, request_id, digest, result, action, target):
    await conn.execute(
        "INSERT INTO operational_document_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)",
        (who.id, request_id, digest, Jsonb(result)),
    )
    await conn.execute(
        "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
        (who.id, action, target, request_id),
    )
    return result


async def identity_lock(conn, who):
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
    )
    await lock_mutation_identity(conn, who)


async def claim_for(conn, source):
    instance = instance_of(source)
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("operational-document:" + instance,)
    )
    claim = await (
        await conn.execute("SELECT * FROM operational_document_claims WHERE source_instance=%s", (instance,))
    ).fetchone()
    if claim and (claim["root_identity"] != source.physical or claim["binding_hash"] != source.binding):
        raise HTTPException(409, "来源绑定已变化，请重新核对")
    if claim is None:
        other = await (
            await conn.execute(
                "SELECT 1 FROM operational_document_claims WHERE root_identity=%s", (source.physical,)
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
            raise HTTPException(403, "该运行来源未授予全局API文档") from None
        raise HTTPException(409, "运行来源未能核对") from None


async def permission_row(conn, instance):
    return await (
        await conn.execute(
            "SELECT * FROM operational_document_permissions WHERE source_instance=%s FOR UPDATE",
            (instance,),
        )
    ).fetchone()


def receipt(data, source, instance, **extra):
    return {
        "requestId": str(data.requestId),
        "sourceAlias": source.alias,
        "sourceInstance": instance,
        "scope": SCOPE,
        "captureComplete": False,
        "historicalVersionsKnown": False,
        **extra,
    }


@router.post("/operational-sources/api-documents/permissions")
async def grant(request: Request, who: Admin):
    data = await body(request, Grant)
    await limited(request, who)
    source = source_for(request.app.state.settings, data.sourceAlias)
    opened(source)
    digest = fingerprint(
        ["operational-document-permission/1", data.sourceAlias, source.physical, source.binding]
    )
    try:
        async with request.app.state.db.connection() as conn, conn.transaction():
            await identity_lock(conn, who)
            previous = await operation(conn, who, data.requestId, digest)
            if previous:
                return previous
            await confirm(request, conn, who, data.password, data.code)
            instance, claim = await claim_for(conn, source)
            if claim:
                current = await permission_row(conn, instance)
                if current and current["active"]:
                    raise HTTPException(409, "全局API文档授权已存在，请查询原回执")
                if not current:
                    raise HTTPException(409, "运行来源未能核对")
                revision = current["revision"] + 1
                await conn.execute(
                    """UPDATE operational_document_permissions
                       SET active=true, revision=%s, actor_id=%s WHERE id=%s""",
                    (revision, who.id, current["id"]),
                )
                permission_id = current["id"]
            else:
                revision = 1
                permission_id = uuid4()
                await conn.execute(
                    """INSERT INTO operational_document_claims(
                        source_instance,root_identity,source_alias,source_owner,binding_hash)
                       VALUES(%s,%s,%s,%s,%s)""",
                    (instance, source.physical, source.alias, source.owner, source.binding),
                )
                await conn.execute(
                    """INSERT INTO operational_document_permissions(id,source_instance,actor_id,revision,active)
                       VALUES(%s,%s,%s,1,true)""",
                    (permission_id, instance, who.id),
                )
                for version in (1, 2):
                    await conn.execute(
                        "INSERT INTO operational_document_progress(permission_id,version) VALUES(%s,%s)",
                        (permission_id, version),
                    )
            result = receipt(
                data,
                source,
                instance,
                state="permitted",
                revision=revision,
            )
            return await remember(
                conn, who, data.requestId, digest, result, "operational-document.permitted", instance
            )
    except UniqueViolation:
        raise HTTPException(409, "该运行来源已被认领") from None


@router.post("/operational-sources/api-documents/revocations")
async def revoke(request: Request, who: Admin):
    data = await body(request, Grant)
    await limited(request, who)
    source = source_for(request.app.state.settings, data.sourceAlias)
    digest = fingerprint(["operational-document-revocation/1", data.sourceAlias, source.physical])
    async with request.app.state.db.connection() as conn, conn.transaction():
        await identity_lock(conn, who)
        previous = await operation(conn, who, data.requestId, digest)
        if previous:
            return previous
        await confirm(request, conn, who, data.password, data.code)
        instance, claim = await claim_for(conn, source)
        current = await permission_row(conn, instance) if claim else None
        if not current or not current["active"]:
            raise HTTPException(409, "全局API文档授权已撤销")
        revision = current["revision"] + 1
        await conn.execute(
            "UPDATE operational_document_permissions SET active=false, revision=%s WHERE id=%s",
            (revision, current["id"]),
        )
        result = receipt(data, source, instance, state="revoked", revision=revision)
        result.pop("scope")
        return await remember(
            conn, who, data.requestId, digest, result, "operational-document.revoked", instance
        )


def archived(page, version):
    if (
        page.get("version") != version
        or page.get("captureComplete") is not True
        or page.get("historicalVersionsKnown") is not False
        or page.get("readOnly") is not True
        or not isinstance(page.get("content"), str)
    ):
        raise HTTPException(409, "运行来源未能核对")
    encoded = page["content"].encode()
    if page.get("sha256") != sha(encoded) or page.get("bytes") != len(encoded) or b"\x00" in encoded:
        raise HTTPException(409, "运行来源未能核对")
    return encoded


@router.post("/operational-sources/api-documents/captures")
async def capture(request: Request, who: Admin):
    data = await body(request, Capture)
    await limited(request, who)
    source = source_for(request.app.state.settings, data.sourceAlias)
    opened(source)
    instance = instance_of(source)
    digest = fingerprint(["operational-document-capture/1", instance, data.version])
    try:
        async with request.app.state.db.connection() as conn, conn.transaction():
            await identity_lock(conn, who)
            previous = await operation(conn, who, data.requestId, digest)
            if previous:
                return previous
            await confirm(request, conn, who, data.password, data.code)
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                ("operational-document:" + instance,),
            )
            claim = await (
                await conn.execute(
                    "SELECT * FROM operational_document_claims WHERE source_instance=%s", (instance,)
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
                    "请先确认全局API文档授权"
                    if not current or not current["active"]
                    else "来源绑定已变化，请重新核对",
                )
            try:
                page = await asyncio.to_thread(read_document, source, data.version)
            except (OSError, ValueError, TypeError, KeyError, UnicodeError, SourceMismatch):
                raise HTTPException(409, "运行来源未能核对") from None
            encoded = archived(page, data.version)
            capture_id = uuid4()
            await conn.execute(
                """INSERT INTO operational_document_captures(
                    id,permission_id,permission_revision,version,content,content_sha256,byte_count,
                    capture_complete,historical_versions_known)
                   VALUES(%s,%s,%s,%s,%s,%s,%s,true,false)""",
                (
                    capture_id,
                    current["id"],
                    current["revision"],
                    data.version,
                    page["content"],
                    page["sha256"],
                    len(encoded),
                ),
            )
            result = {
                "requestId": str(data.requestId),
                "state": "captured",
                "sourceAlias": source.alias,
                "sourceInstance": instance,
                "version": data.version,
                "captureId": str(capture_id),
                "bytes": len(encoded),
                "contentSha256": page["sha256"],
                "captureComplete": True,
                "historicalVersionsKnown": False,
                "applied": False,
            }
            return await remember(
                conn, who, data.requestId, digest, result, "operational-document.captured", str(capture_id)
            )
    except UniqueViolation:
        raise HTTPException(409, "该运行来源已被认领") from None


def finished(data, captured, document, progress_revision=None):
    failed = document["status"] != 200
    result = {
        "requestId": str(data.requestId),
        "state": "failed" if failed else "applied",
        "status": document["status"],
        "version": captured["version"],
        "captureId": str(captured["id"]),
        "revision": document.get("revision"),
        "captureComplete": True,
        "historicalVersionsKnown": False,
        "applied": not failed,
    }
    if failed:
        result["message"] = document.get("message") or "文档已变化，请重新读取"
    else:
        result["bytes"] = document["bytes"]
        result["saved"] = True
        result["progressRevision"] = progress_revision
    return result


@router.post("/operational-sources/api-documents/applications")
async def apply_capture(request: Request, who: Admin):
    data = await body(request, Apply)
    await limited(request, who)
    digest = fingerprint(["operational-document-apply/1", str(data.captureId), data.expectedRevision])
    try:
        outcome = await apply_archived(request, who, data, digest)
    except UniqueViolation:
        raise HTTPException(409, "该捕获已经应用") from None
    if outcome.get("status", 200) != 200:
        raise HTTPException(outcome["status"], outcome.get("message") or "文档已变化，请重新读取")
    return outcome


async def apply_archived(request, who, data, digest):
    async with request.app.state.db.connection() as conn, conn.transaction():
        await identity_lock(conn, who)
        previous = await operation(conn, who, data.requestId, digest)
        if previous:
            outcome = previous
        else:
            await confirm(request, conn, who, data.password, data.code)
            captured = await (
                await conn.execute(
                    "SELECT * FROM operational_document_captures WHERE id=%s", (data.captureId,)
                )
            ).fetchone()
            if not captured:
                raise HTTPException(404, "未查到此捕获")
            if captured["capture_complete"] is not True or captured["historical_versions_known"] is not False:
                raise HTTPException(409, "运行来源未能核对")
            encoded = captured["content"].encode()
            if sha(encoded) != captured["content_sha256"] or len(encoded) != captured["byte_count"]:
                raise HTTPException(409, "运行来源未能核对")
            current = await (
                await conn.execute(
                    "SELECT * FROM operational_document_permissions WHERE id=%s FOR UPDATE",
                    (captured["permission_id"],),
                )
            ).fetchone()
            claim = await (
                await conn.execute(
                    """SELECT * FROM operational_document_claims
                       WHERE source_instance=(SELECT source_instance FROM operational_document_permissions WHERE id=%s)""",
                    (captured["permission_id"],),
                )
            ).fetchone()
            if (
                not current
                or not claim
                or not current["active"]
                or current["revision"] != captured["permission_revision"]
            ):
                raise HTTPException(409, "来源授权已变化，请重新捕获")
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                ("operational-document:" + claim["source_instance"],),
            )
            applied = await (
                await conn.execute(
                    "SELECT 1 FROM operational_document_applications WHERE capture_id=%s",
                    (captured["id"],),
                )
            ).fetchone()
            if applied:
                raise HTTPException(409, "该捕获已经应用")
            progress = await (
                await conn.execute(
                    """SELECT * FROM operational_document_progress
                       WHERE permission_id=%s AND version=%s FOR UPDATE""",
                    (current["id"], captured["version"]),
                )
            ).fetchone()
            if progress is None:
                raise HTTPException(409, "运行来源未能核对")
            document_data = {
                "content": captured["content"],
                "expectedRevision": data.expectedRevision,
                "requestId": str(data.requestId),
            }
            content, rid, document_fingerprint = prepare_document(captured["version"], document_data)
            document = await request.app.state.api_documents.write(
                conn, who, captured["version"], document_data, content, rid, document_fingerprint
            )
            if document["status"] != 200:
                outcome = await remember(
                    conn,
                    who,
                    data.requestId,
                    digest,
                    finished(data, captured, document),
                    "operational-document.rejected",
                    str(captured["id"]),
                )
            else:
                if document["revision"] != captured["content_sha256"]:
                    raise HTTPException(409, "运行来源未能核对")
                await conn.execute(
                    """INSERT INTO operational_document_applications(
                        capture_id,version,document_revision,actor_id,request_id)
                       VALUES(%s,%s,%s,%s,%s)""",
                    (captured["id"], captured["version"], document["revision"], who.id, data.requestId),
                )
                revised = progress["revision"] + 1
                moved = await conn.execute(
                    """UPDATE operational_document_progress
                       SET revision=%s, applied_capture_id=%s, content_sha256=%s
                       WHERE permission_id=%s AND version=%s AND revision=%s""",
                    (
                        revised,
                        captured["id"],
                        document["revision"],
                        current["id"],
                        captured["version"],
                        progress["revision"],
                    ),
                )
                if moved.rowcount != 1:
                    raise HTTPException(409, "该捕获已经应用")
                outcome = await remember(
                    conn,
                    who,
                    data.requestId,
                    digest,
                    finished(data, captured, document, revised),
                    "operational-document.applied",
                    str(captured["id"]),
                )
    return outcome


@router.post("/operational-sources/api-documents/closures")
async def close(request: Request, who: Admin):
    data = await body(request, Close)
    await limited(request, who)
    digest = fingerprint(["operational-document-close/1", str(data.requestId)])
    async with request.app.state.db.connection() as conn, conn.transaction():
        await identity_lock(conn, who)
        previous = await operation(conn, who, data.requestId, digest)
        if previous:
            return previous
        await confirm(request, conn, who, data.password, data.code)
        await conn.execute(
            "INSERT INTO operational_document_closed_operations(actor_id,request_id) VALUES(%s,%s)",
            (who.id, data.requestId),
        )
        result = {
            "requestId": str(data.requestId),
            "state": "closed",
            "captureComplete": False,
            "historicalVersionsKnown": False,
        }
        return await remember(
            conn, who, data.requestId, digest, result, "operational-document.closed", str(data.requestId)
        )


@router.get("/operational-sources/api-documents/receipts/{request_id}")
async def receipt_for(request_id: UUID, request: Request, who: Admin):
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who)
        row = await (
            await conn.execute(
                "SELECT result FROM operational_document_operations WHERE actor_id=%s AND request_id=%s",
                (who.id, request_id),
            )
        ).fetchone()
    if not row:
        raise HTTPException(404, "未查到此请求的回执")
    return row["result"]
