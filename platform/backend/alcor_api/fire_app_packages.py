"""Administrator package delivery: PG receipts and immutable private originals."""

import asyncio
import hashlib
import os
import re
import stat
import tempfile
import unicodedata
from pathlib import Path
from urllib.parse import quote, unquote_to_bytes
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Request

from .backup_stream_codec import StreamFailure
from .backup_stream_storage import existing_directory
from .fire_web import Admin
from .resource_api import PrivateResourceResponse
from .security import digest, lock_mutation_identity

router = APIRouter(prefix="/api/app-packages", tags=["fire-packages"])
LIMIT = 2 * 1024**3
CHUNK = 1024**2


def item(row):
    return {
        "id": row["id"].hex,
        "name": row["name"],
        "size": row["byte_length"],
        "platform": row["platform"],
        "createdAt": row["created_at"].isoformat(),
        "sha256": row["sha256"],
    }


def private_root(settings):
    try:
        return existing_directory(settings.file_root)
    except (OSError, ValueError, StreamFailure):
        raise HTTPException(503, "私有文件目录未配置或权限不正确") from None


def open_original(root, sha, size):
    descriptor = os.open(root / sha, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    original = os.fdopen(descriptor, "rb")
    try:
        before = os.fstat(original.fileno())
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != os.getuid()
            or before.st_mode & 0o077
            or before.st_nlink != 1
            or before.st_size != size
        ):
            raise ValueError()
        hasher = hashlib.sha256()
        while chunk := original.read(CHUNK):
            hasher.update(chunk)
        after = os.fstat(original.fileno())
        if hasher.hexdigest() != sha or (
            before.st_ino,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        ) != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError()
        original.seek(0)
        return original
    except BaseException:
        original.close()
        raise


@router.get("")
async def listing(request: Request, who: Admin):
    async with request.app.state.db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who)
        rows = await (
            await conn.execute("SELECT * FROM fire_app_packages ORDER BY created_at DESC,id DESC LIMIT 1000")
        ).fetchall()
        total = (await (await conn.execute("SELECT count(*) AS n FROM fire_app_packages")).fetchone())["n"]
    try:
        private_root(request.app.state.db.settings)
        ready = True
    except HTTPException:
        ready = False
    return {
        "packages": [item(row) for row in rows],
        "total": total,
        "maxBytes": LIMIT,
        "canUpload": ready,
        "storageConfigured": ready,
    }


@router.post("", status_code=201)
async def upload(request: Request, who: Admin):
    try:
        encoded = request.headers.get("x-file-name", "")
        if re.search(r"%(?![0-9a-fA-F]{2})", encoded):
            raise ValueError()
        name = unquote_to_bytes(encoded).decode("utf-8")
        request_id = UUID(request.headers.get("x-alcor-request-id", ""))
        if (
            not 1 <= len(name) <= 240
            or any(c in "/\\" or unicodedata.category(c).startswith("C") for c in name)
            or not re.search(r"\.(apk|ipa)$", name, re.IGNORECASE)
        ):
            raise ValueError()
        length = request.headers.get("content-length", "")
        if not re.fullmatch(r"[0-9]{1,12}", length):
            raise ValueError()
        size = int(length)
    except (ValueError, UnicodeError):
        raise HTTPException(400, "安装包名称、长度或原请求编号无效") from None
    if not 4 <= size <= LIMIT:
        raise HTTPException(413, "安装包需大于 3 字节且不超过 2 GB")
    if request.headers.get("content-type", "").split(";")[0] != "application/octet-stream":
        raise HTTPException(415, "请上传原始安装包文件")
    db = request.app.state.db
    if not await request.app.state.rate_limit(db, digest("fire-package:" + who.id), 20, window_seconds=3600):
        raise HTTPException(429, "上传过于频繁，请稍后再试")
    root = private_root(db.settings)
    staging = root / "app-packages"
    staging.mkdir(mode=0o700, exist_ok=True)
    existing_directory(staging)
    fd, temporary = tempfile.mkstemp(prefix=".upload-", dir=staging)
    path = Path(temporary)
    hasher, signature, received = hashlib.sha256(), bytearray(), 0
    try:
        with os.fdopen(fd, "wb") as output:
            async for chunk in request.stream():
                received += len(chunk)
                if received > size:
                    raise HTTPException(413, "上传字节超过声明长度")
                if len(signature) < 4:
                    signature.extend(chunk[: 4 - len(signature)])
                hasher.update(chunk)
                await asyncio.to_thread(output.write, chunk)
            if received != size or signature != b"PK\x03\x04":
                raise HTTPException(400, "安装包不完整或不是 ZIP 容器")
            await asyncio.to_thread(output.flush)
            await asyncio.to_thread(os.fsync, output.fileno())
        sha = hasher.hexdigest()
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('profile-media-lifecycle',0))")
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                (f"fire-package:{who.id}:{request_id}",),
            )
            previous = await (
                await conn.execute(
                    "SELECT * FROM fire_app_packages WHERE uploaded_by=%s AND request_id=%s",
                    (who.id, request_id),
                )
            ).fetchone()
            if previous:
                if (previous["name"], previous["byte_length"], previous["sha256"]) != (name, size, sha):
                    raise HTTPException(409, "原请求编号已用于不同安装包")
                original = await asyncio.to_thread(open_original, root, sha, size)
                original.close()
                return item(previous)
            try:
                os.link(path, root / sha, follow_symlinks=False)
            except FileExistsError:
                original = await asyncio.to_thread(open_original, root, sha, size)
                original.close()
            path.unlink()
            directory_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                await asyncio.to_thread(os.fsync, directory_fd)
            finally:
                os.close(directory_fd)
            # Immutable originals may be shared. A later DB failure never removes an existing original.
            row = await (
                await conn.execute(
                    "INSERT INTO fire_app_packages(id,request_id,uploaded_by,name,platform,byte_length,sha256) VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING *",
                    (
                        uuid4(),
                        request_id,
                        who.id,
                        name,
                        "Android" if name.lower().endswith(".apk") else "iOS",
                        size,
                        sha,
                    ),
                )
            ).fetchone()
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'fire.package.uploaded',%s,%s)",
                (who.id, str(row["id"]), request_id),
            )
            return item(row)
    except (OSError, ValueError):
        raise HTTPException(422, "安装包原件无法安全保存或核对") from None
    finally:
        path.unlink(missing_ok=True)


@router.get("/download/{package_id}")
async def download(package_id: str, request: Request, who: Admin):
    if not re.fullmatch("[a-f0-9]{32}", package_id):
        raise HTTPException(404, "安装包不存在")
    db = request.app.state.db
    async with db.connection() as conn, conn.transaction():
        await lock_mutation_identity(conn, who)
        row = await (
            await conn.execute("SELECT * FROM fire_app_packages WHERE id=%s", (UUID(package_id),))
        ).fetchone()
    if not row:
        raise HTTPException(404, "安装包不存在")
    try:
        original = await asyncio.to_thread(
            open_original, private_root(db.settings), row["sha256"], row["byte_length"]
        )
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
    except (OSError, ValueError):
        if "original" in locals():
            original.close()
        raise HTTPException(422, "安装包原件缺失或校验不通过") from None
    except BaseException:
        if "original" in locals():
            original.close()
        raise

    def chunks():
        while raw := original.read(CHUNK):
            yield raw

    return PrivateResourceResponse(
        original,
        chunks(),
        media_type="application/octet-stream",
        headers={
            "Content-Length": str(row["byte_length"]),
            "Content-Disposition": "attachment; filename*=UTF-8''" + quote(row["name"], safe=""),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Alcor-Content-SHA256": row["sha256"],
        },
    )
