"""Private original bytes, deduplicated by SHA; owner rows authorize every read."""

import asyncio
import hashlib
import os
import re
import stat
import time

from fastapi import HTTPException

from .backups import BackupFailure, private_dir
from .resource_contract import UPLOAD_LIMIT

LIFECYCLE = "hashtextextended('profile-media-lifecycle',0)"


def durable_private_dir(path):
    missing = []
    current = path
    while not current.exists():
        missing.append(current)
        current = current.parent
    for candidate in reversed(missing):
        private_dir(candidate)
        descriptor = os.open(candidate.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    return private_dir(path)


def verified_root(settings, create=False):
    if settings.file_root is None:
        raise HTTPException(503, "私有文件存储尚未配置")
    parent = settings.file_root
    for path in (parent, *parent.parents):
        if path.is_symlink():
            raise HTTPException(503, "私有文件路径不可包含符号链接")
    if create:
        durable_private_dir(parent)
    for path in (parent, parent / "resource-media"):
        if create:
            durable_private_dir(path)
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise HTTPException(503, "私有文件目录不安全")
    return parent / "resource-media"


def persist(settings, sha, raw):
    root = verified_root(settings, True)
    target = root / sha
    try:
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        # Never replace a committed original, including when corruption is detected.
        existing = read_bytes(settings, sha, len(raw))
        if existing != raw:
            raise HTTPException(503, "已有原文件校验失败")
        # An earlier rollback or failed fsync may have left valid cached bytes;
        # reusing a digest still requires a fresh durable file boundary.
        descriptor = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    else:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    descriptor = os.open(root, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def open_verified(settings, sha, size):
    stream = None
    try:
        if not re.fullmatch(r"[0-9a-f]{64}", sha):
            raise ValueError()
        descriptor = os.open(verified_root(settings) / sha, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        stream = os.fdopen(descriptor, "rb")
        before = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_uid != os.getuid()
            or before.st_mode & 0o077
            or before.st_size != size
            or size > UPLOAD_LIMIT
        ):
            raise ValueError()
        hashed = hashlib.sha256()
        while chunk := stream.read(1024 * 1024):
            hashed.update(chunk)
        after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ) or hashed.hexdigest() != sha:
            raise ValueError()
        stream.seek(0)
        return stream
    except (OSError, ValueError, BackupFailure):
        if stream is not None:
            stream.close()
        raise HTTPException(503, "原文件缺失或完整性校验失败") from None


def read_bytes(settings, sha, size):
    with open_verified(settings, sha, size) as stream:
        return stream.read(UPLOAD_LIMIT + 1)


class ResourceMedia:
    def __init__(self, settings):
        self.settings = settings

    async def stage(self, conn, owner, raw):
        sha = hashlib.sha256(raw).hexdigest()
        await conn.execute("SELECT pg_advisory_xact_lock_shared(" + LIFECYCLE + ")")
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("resource-sha:" + sha,))
        # Locks cover fsync through transaction commit. Failures leave only quarantined,
        # inaccessible files; uncertain commit must never remove a published original.
        await asyncio.to_thread(persist, self.settings, sha, raw)
        await conn.execute(
            """INSERT INTO resource_media_objects(owner_id,sha256,byte_length)
            VALUES(%s,%s,%s) ON CONFLICT(owner_id,sha256) DO NOTHING""",
            (owner, sha, len(raw)),
        )
        return sha

    async def read(self, conn, owner, sha):
        row = await (
            await conn.execute(
                "SELECT byte_length FROM resource_media_objects WHERE owner_id=%s AND sha256=%s", (owner, sha)
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "文件不存在")
        return await asyncio.to_thread(read_bytes, self.settings, sha, row["byte_length"])

    async def open(self, conn, owner, sha):
        row = await (
            await conn.execute(
                "SELECT byte_length FROM resource_media_objects WHERE owner_id=%s AND sha256=%s", (owner, sha)
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "文件不存在")
        return await asyncio.to_thread(open_verified, self.settings, sha, row["byte_length"])

    async def reconcile_orphans(self, conn, minimum_age_seconds=86400):
        if minimum_age_seconds < 86400:
            raise ValueError("orphan quarantine must be at least one day")
        await conn.execute("SELECT pg_advisory_xact_lock(" + LIFECYCLE + ")")
        try:
            root = verified_root(self.settings)
        except FileNotFoundError:
            return 0
        removed = 0
        for path in root.iterdir():
            info = path.lstat()
            if (
                not re.fullmatch(r"[0-9a-f]{64}", path.name)
                or not stat.S_ISREG(info.st_mode)
                or info.st_mtime > time.time() - minimum_age_seconds
            ):
                continue
            from .shared_attachment_media import media_referenced
            exists = await media_referenced(conn, path.name)
            if not exists:
                path.unlink()
                removed += 1
        if removed:
            descriptor = os.open(root, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        return removed


async def capture_resource_media(snapshot, settings, entries):
    from .shared_attachment_media import media_inventory
    rows = await media_inventory(snapshot)
    count = sum(n.startswith(("files/", "assets/", "profile-media/", "resource-media/")) for n in entries)
    total = sum(len(raw) for raw in entries.values())
    for row in rows:
        if count >= 1000:
            raise BackupFailure("文件与素材数量超过备份预算")
        try:
            if row["size"] != row["max_size"]:
                raise ValueError()
            raw = await asyncio.to_thread(read_bytes, settings, row["sha256"], row["size"])
        except (HTTPException, ValueError):
            raise BackupFailure("资源库原文件缺失或不完整，无法完成可恢复备份") from None
        total += len(raw)
        if total > settings.backup_max_bytes:
            raise BackupFailure("文件与素材总量超过备份预算")
        entries["resource-media/" + row["sha256"]] = raw
        count += 1
