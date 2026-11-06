"""Two fixed PG-backed Markdown references; no filesystem paths are accepted."""

import hashlib
import json
import math
import re
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse
from psycopg import Error as PostgresError
from psycopg.types.json import Jsonb

from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, web_identity
from .profile_http import bounded_body
from .security import COOKIE, Identity, digest, identity, lock_mutation_identity

FILES = {1: "api-spec.md", 2: "api-spec-v2.md"}
MAX_BYTES = 512 * 1024


def version_for(request):
    values = request.query_params.getlist("version")
    if set(request.query_params) - {"version"} or len(values) > 1:
        raise HTTPException(400, "不支持的文档版本")
    value = values[0] if values else "1"
    if value not in {"1", "2", "v1", "v2"}:
        raise HTTPException(400, "不支持的文档版本")
    return int(value.removeprefix("v"))


async def current(conn, version):
    row = await (
        await conn.execute("SELECT content,revision FROM api_documents WHERE version=%s", (version,))
    ).fetchone()
    return (
        {
            "version": version,
            "content": row["content"],
            "revision": row["revision"],
            "path": "docs/" + FILES[version],
        }
        if row
        else {"version": version, "content": None, "revision": None, "path": "docs/" + FILES[version]}
    )


def prepare_document(version, data):
    if (
        not isinstance(data, dict)
        or set(data) != {"content", "expectedRevision", "requestId"}
        or not isinstance(data["content"], str)
    ):
        raise HTTPException(422, "需要文档内容、当前修订与原操作编号")
    try:
        content = data["content"].encode("utf-8")
        rid = str(UUID(data["requestId"]))
    except (UnicodeEncodeError, ValueError, TypeError, AttributeError):
        raise HTTPException(422, "文档或操作编号无效") from None
    if (
        b"\x00" in content
        or len(content) > MAX_BYTES
        or (
            data["expectedRevision"] is not None
            and (
                not isinstance(data["expectedRevision"], str)
                or len(data["expectedRevision"]) != 64
                or any(c not in "0123456789abcdef" for c in data["expectedRevision"])
            )
        )
    ):
        raise HTTPException(422, "文档内容过大或修订无效")
    fingerprint = hashlib.sha256(
        json.dumps({"version": version, **data}, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()
    return content, rid, fingerprint


class ApiDocuments:
    def __init__(self, db):
        self.db = db

    async def read(self, version, who=None):
        async with self.db.connection() as conn, conn.transaction():
            if who:
                await lock_mutation_identity(conn, who, require_admin=True)
            return await current(conn, version)

    async def save(self, who, version, data):
        content, rid, fingerprint = prepare_document(version, data)
        async with self.db.connection() as conn, conn.transaction():
            return await self.write(conn, who, version, data, content, rid, fingerprint)

    async def write(self, conn, who, version, data, content, rid, fingerprint):
        """Apply one document inside the caller's transaction. Archive import uses this same CAS."""
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await lock_mutation_identity(conn, who, require_admin=True)
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('api-documents',0))")
        prior = await (
            await conn.execute(
                "SELECT fingerprint,receipt FROM api_document_operations WHERE actor_id=%s AND request_id=%s",
                (who.id, rid),
            )
        ).fetchone()
        if prior:
            if prior["fingerprint"] != fingerprint:
                raise HTTPException(409, "原操作编号已有不同内容")
            return prior["receipt"]
        old = await current(conn, version)
        if old["revision"] != data["expectedRevision"]:
            result = {
                "requestId": rid,
                "state": "failed",
                "status": 409,
                "revision": old["revision"],
                "message": "文档已变化，请重新读取",
            }
        else:
            revision = hashlib.sha256(content).hexdigest()
            await conn.execute(
                "INSERT INTO api_documents(version,content,revision) VALUES(%s,%s,%s) ON CONFLICT(version) DO UPDATE SET content=excluded.content,revision=excluded.revision,updated_at=clock_timestamp()",
                (version, data["content"], revision),
            )
            result = {
                "requestId": rid,
                "state": "completed",
                "status": 200,
                "saved": True,
                "version": version,
                "bytes": len(content),
                "revision": revision,
            }
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'api.document.saved',%s,%s)",
                (who.id, str(version), rid),
            )
        await conn.execute(
            "INSERT INTO api_document_operations(actor_id,request_id,fingerprint,receipt) VALUES(%s,%s,%s,%s)",
            (who.id, rid, fingerprint, Jsonb(result)),
        )
        return result

    async def legacy_save(self, who, version, content, expected):
        """Reviewed save has no client request id. An omitted revision overwrites; a missing file with one fails."""
        stored, encoded = document_bytes(content)
        revision = hashlib.sha256(encoded).hexdigest()
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                ("identity-management:" + who.id,),
            )
            await lock_mutation_identity(conn, who, require_admin=True)
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('api-documents',0))")
            old = await current(conn, version)
            if expected is not _OMITTED and old["revision"] != expected:
                if old["revision"] is None:
                    raise LegacyDocumentReadFailed
                return None
            await conn.execute(
                """INSERT INTO api_documents(version,content,revision) VALUES(%s,%s,%s)
                   ON CONFLICT(version) DO UPDATE
                   SET content=excluded.content,revision=excluded.revision,updated_at=clock_timestamp()""",
                (version, stored, revision),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'api.document.saved',%s,%s)",
                (who.id, str(version), uuid4()),
            )
        return {"saved": True, "version": version, "bytes": len(encoded), "revision": revision}

    async def receipt(self, who, rid, close=False):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
            )
            await lock_mutation_identity(conn, who, require_admin=True)
            if close:
                await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('api-documents',0))")
            row = await (
                await conn.execute(
                    "SELECT receipt FROM api_document_operations WHERE actor_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if row:
                return row["receipt"]
            if not close:
                raise HTTPException(404, "原操作尚无回执")
            result = {"requestId": str(rid), "state": "closed", "status": 409, "message": "原操作已关闭"}
            await conn.execute(
                "INSERT INTO api_document_operations(actor_id,request_id,fingerprint,receipt) VALUES(%s,%s,'closed',%s)",
                (who.id, rid, Jsonb(result)),
            )
            return result


_OMITTED = object()
_FAT_BEARER = re.compile(r"Bearer fat_[A-Za-z0-9_-]{43}\Z")
_REVISION = re.compile(r"[a-f0-9]{64}\Z")
_VERSION = re.compile(r"v?[1-9]\d*\Z")
_BODY_LIMIT = MAX_BYTES * 6 + 1024


class LegacyDocumentReadFailed(Exception):
    """A conditional save reads the current file first. A missing file is the reviewed 50001."""


def legacy_docs_client(request):
    """Old cookies select the reviewed envelope. An Alcor session keeps the new receipt."""
    if COOKIE in request.cookies:
        return False
    if request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE) or "authorization" in request.headers:
        return True
    return "application/json" not in (request.headers.get("accept") or "").lower()


def legacy_origin_trusted(request):
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return True
    origin = request.headers.get("origin")
    if not origin:
        return request.headers.get("sec-fetch-site") != "cross-site"
    parsed = urlsplit(origin)
    host = (request.headers.get("host") or request.url.netloc).lower()
    return parsed.scheme in {"http", "https"} and parsed.netloc.lower() == host


def js_declared_exceeds(header, limit):
    if header is None:
        return False
    text = header.strip()
    if not text:
        return False
    try:
        if re.fullmatch(r"[+-]?0[xX][0-9A-Fa-f]+", text):
            number = float(int(text, 16))
        else:
            number = float(text)
    except ValueError:
        return False
    if math.isinf(number):
        return number > 0
    return math.isfinite(number) and number > limit


def legacy_version(request):
    values = request.query_params.getlist("version")
    if len(values) > 1:
        return None
    if not values:
        return 1
    value = values[0]
    if not _VERSION.fullmatch(value):
        return None
    version = int(value.removeprefix("v"))
    return version if version in FILES else None


def legacy_fail(code, message, status):
    return JSONResponse(
        status_code=status,
        content={"code": code, "message": message},
        headers={"Cache-Control": "no-store"},
    )


def legacy_ok(data):
    return JSONResponse(
        content={"code": 0, "message": "ok", "data": data},
        headers={"Cache-Control": "no-store, private"},
    )


def legacy_payload(body):
    if (
        not isinstance(body, dict)
        or any(key not in {"content", "expectedRevision"} for key in body)
        or not isinstance(body.get("content"), str)
    ):
        return None
    expected = body.get("expectedRevision", _OMITTED)
    if expected is not _OMITTED and (not isinstance(expected, str) or not _REVISION.fullmatch(expected)):
        return None
    return body["content"], expected


def document_bytes(content):
    encoded = content.encode("utf-8", errors="replace")
    return encoded.decode("utf-8"), encoded


async def legacy_docs_user(request):
    authorization = request.headers.get("authorization") or ""
    if "authorization" in request.headers and (len(request.headers.getlist("authorization")) != 1
            or not authorization.startswith("Bearer ") or not re.fullmatch(r"[a-fA-F0-9]{64}", authorization[7:].strip())):
        return None
    if _FAT_BEARER.fullmatch(authorization):
        return None
    if authorization.startswith("Bearer "):
        token = authorization.removeprefix("Bearer ").strip()
    elif legacy_origin_trusted(request):
        token = request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE) or ""
    else:
        return None
    if not token or len(token) > 128:
        return None
    async with request.app.state.db.connection() as conn:
        row = await (
            await conn.execute(
                """SELECT u.id,u.username,u.role,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
                   WHERE s.token_hash=%s AND s.client_id='legacy-web' AND s.expires_at>clock_timestamp()
                     AND s.session_version=u.session_version AND u.active""",
                (digest(token),),
            )
        ).fetchone()
    if not row:
        return None
    who = Identity(
        id=row["id"],
        username=row["username"],
        role=row["role"],
        token_hash=digest(token),
        csrf="",
        expires_at=row["expires_at"],
    )
    who.legacy_client = True
    return who


async def legacy_body(request):
    if js_declared_exceeds(request.headers.get("content-length"), _BODY_LIMIT):
        return None
    try:
        raw = await request.body()
    except HTTPException as exc:
        if exc.status_code == 413:
            return None
        raise
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        return None


async def legacy_read(request):
    version = legacy_version(request)
    if version is None:
        return legacy_fail(40001, "不支持的文档版本", 400)
    try:
        value = await request.app.state.api_documents.read(version)
    except PostgresError:
        return legacy_fail(50001, "读取文档失败", 500)
    if value["revision"] is None:
        return legacy_fail(50001, "读取文档失败", 500)
    return legacy_ok(
        {
            "version": value["version"],
            "content": value["content"],
            "revision": value["revision"],
            "path": value["path"],
        }
    )


async def legacy_write(request):
    version = legacy_version(request)
    if version is None:
        return legacy_fail(40001, "不支持的文档版本", 400)
    initial = await legacy_docs_user(request)
    if initial is None:
        return legacy_fail(40101, "未登录", 401)
    if initial.role != "admin":
        return legacy_fail(40301, "需要管理员权限", 403)
    parsed = legacy_payload(await legacy_body(request))
    if parsed is None:
        return legacy_fail(40001, "文档参数无效", 400)
    content, expected = parsed
    if len(document_bytes(content)[1]) > MAX_BYTES:
        return legacy_fail(40001, "文档内容过大", 400)
    current_user = await legacy_docs_user(request)
    if current_user is None or current_user.id != initial.id:
        return legacy_fail(40101, "登录已失效", 401)
    if current_user.role != "admin":
        return legacy_fail(40301, "需要管理员权限", 403)
    try:
        result = await request.app.state.api_documents.legacy_save(current_user, version, content, expected)
    except LegacyDocumentReadFailed:
        return legacy_fail(50001, "保存文档失败", 500)
    except HTTPException as exc:
        if exc.status_code == 401:
            return legacy_fail(40101, "登录已失效", 401)
        return legacy_fail(50001, "保存文档失败", 500)
    except PostgresError:
        return legacy_fail(50001, "保存文档失败", 500)
    if result is None:
        return legacy_fail(40901, "文档已被更新，请重新读取后再保存", 409)
    return legacy_ok(result)


def mount_api_documents(app, settings, db):
    service = ApiDocuments(db)
    app.state.api_documents = service

    async def admin(request):
        assert_native_origin(request, settings)
        if "authorization" in request.headers:
            from .legacy_optional_credentials import credentials_present

            credentials_present(request)
            raise HTTPException(403, "请使用当前网页登录会话")
        who = await identity(request) if COOKIE in request.cookies else (await web_identity(request, db, allow_platform=True))[0]
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        return who

    @app.get("/api/api-docs")
    async def read(request: Request, response: Response):
        if legacy_docs_client(request):
            return await legacy_read(request)
        value = await service.read(version_for(request))
        if value["revision"] is None:
            raise HTTPException(503, "文档尚未配置")
        response.headers["Cache-Control"] = "no-store, private"
        return {"code": 0, "message": "ok", "data": value}

    @app.post("/api/api-docs")
    async def save(request: Request, response: Response):
        if legacy_docs_client(request):
            return await legacy_write(request)
        who = await admin(request)
        await bounded_body(request, MAX_BYTES * 6 + 1024)
        try:
            data = await request.json()
        except ValueError:
            raise HTTPException(400, "请求格式无效") from None
        value = await service.save(who, version_for(request), data)
        if value["status"] != 200:
            raise HTTPException(value["status"], value)
        response.headers["Cache-Control"] = "no-store, private"
        return {"code": 0, "message": "ok", "data": value}

    @app.get("/api/system/api-docs")
    async def status(request: Request):
        return await service.read(version_for(request), await admin(request))

    @app.get("/api/system/api-docs/operations/{rid}")
    async def receipt(rid: UUID, request: Request):
        return await service.receipt(await admin(request), rid)

    @app.post("/api/system/api-docs/operations/{rid}/close")
    async def close(rid: UUID, request: Request):
        who = await admin(request)
        await bounded_body(request, 128)
        if request.query_params or (await request.body()).strip() not in (b"", b"{}"):
            raise HTTPException(400, "关闭请求不能携带文档内容")
        return await service.receipt(who, rid, close=True)
