"""Immutable owner media. PostgreSQL references decide visibility; files are private."""

import hashlib
import io
import os
import stat
import time
from uuid import UUID, uuid4

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

from .backups import BackupFailure, private_dir, private_read


def normalize_background(raw):
    if not 3 <= len(raw) <= 8388608 or raw[:3] != b"\xff\xd8\xff":
        raise HTTPException(400, "需要真实JPEG图片，最大8MiB")
    try:
        with Image.open(io.BytesIO(raw), formats=["JPEG"]) as image:
            if image.width > 2048 or image.height > 2048 or getattr(image, "n_frames", 1) != 1:
                raise ValueError()
            image.load()
            out = io.BytesIO()
            ImageOps.exif_transpose(image).convert("RGB").save(
                out, format="JPEG", quality=90, exif=b"", icc_profile=None
            )
            result = out.getvalue()
            if len(result) > 8388608:
                raise ValueError()
            return result
    except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError):
        raise HTTPException(400, "图片无法安全解码或尺寸超过2048像素") from None


def validate_legacy_avatar(raw, extension):
    # Legacy accepted animated GIF bytes; preserve frames rather than silently flattening.
    ext = extension.lower().removeprefix(".")
    ext = "jpg" if ext == "jpeg" else ext
    signatures = {
        "jpg": raw[:3] == b"\xff\xd8\xff",
        "png": raw[:8] == b"\x89PNG\r\n\x1a\n",
        "gif": raw[:6] in (b"GIF87a", b"GIF89a"),
        "webp": raw[:4] == b"RIFF" and raw[8:12] == b"WEBP",
    }
    if not raw or len(raw) > 5 * 1024 * 1024 or not signatures.get(ext):
        raise HTTPException(400, "头像格式不匹配或超过5MiB")
    return raw, {"jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp"}[ext]


class ProfileMedia:
    def __init__(self, settings):
        self.settings = settings

    def root(self, create=False):
        if self.settings.file_root is None:
            raise HTTPException(503, "私有文件存储尚未配置")
        parent = private_dir(self.settings.file_root) if create else self.settings.file_root
        if not create:
            if parent.is_symlink():
                raise HTTPException(404, "图片不存在")
            parent_info = parent.stat()
            if (
                not stat.S_ISDIR(parent_info.st_mode)
                or parent_info.st_uid != os.getuid()
                or parent_info.st_mode & 0o077
            ):
                raise HTTPException(404, "图片不存在")
        root = parent / "profile-media"
        if create:
            return private_dir(root)
        if root.is_symlink():
            raise HTTPException(404, "图片不存在")
        info = root.stat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise HTTPException(404, "图片不存在")
        return root

    async def stage(self, conn, owner, raw, media_type):
        await conn.execute(
            "SELECT pg_advisory_xact_lock_shared(hashtextextended('profile-media-lifecycle',0))"
        )
        identifier = uuid4()
        root = self.root(True)
        target = root / str(identifier)
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        directory = os.open(root, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        sha = hashlib.sha256(raw).hexdigest()
        await conn.execute(
            "INSERT INTO profile_media_objects(id,owner_id,sha256,media_type,byte_length) VALUES(%s,%s,%s,%s,%s)",
            (identifier, owner, sha, media_type, len(raw)),
        )
        # Never unlink on ambiguous commit failure. Unreferenced files stay private
        # until separately reconciled; a committed reference must never lose bytes.
        return identifier, sha

    async def read(self, conn, owner, identifier):
        row = await (
            await conn.execute(
                "SELECT * FROM profile_media_objects WHERE owner_id=%s AND id=%s",
                (owner, UUID(str(identifier))),
            )
        ).fetchone()
        if not row:
            raise HTTPException(404, "图片不存在")
        try:
            raw = private_read(self.root() / str(row["id"]), 8388608)
        except (OSError, ValueError, BackupFailure):
            raise HTTPException(404, "图片不存在") from None
        if len(raw) != row["byte_length"] or hashlib.sha256(raw).hexdigest() != row["sha256"]:
            raise HTTPException(503, "图片完整性校验失败")
        return raw, row["media_type"]

    async def reconcile_orphans(self, conn, *, minimum_age_seconds=86400):
        """Worker-only maintenance: immutable files lacking committed metadata.

        A shared transaction lock spans stage through commit; the exclusive lock
        proves no staged transaction can still publish an apparently orphan file.
        Retain old committed objects for backup/receipt retention; only proven
        no-metadata orphans are removed here. Never invoked by a read endpoint.
        """
        if minimum_age_seconds < 86400:
            raise ValueError("orphan quarantine must be at least one day")
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('profile-media-lifecycle',0))")
        try:
            root = self.root()
        except FileNotFoundError:
            return 0
        removed = 0
        cutoff = time.time() - minimum_age_seconds
        for path in root.iterdir():
            try:
                identifier = UUID(path.name)
                info = path.lstat()
                if str(identifier) != path.name or not stat.S_ISREG(info.st_mode) or info.st_mtime > cutoff:
                    continue
            except (ValueError, FileNotFoundError):
                continue
            exists = await (
                await conn.execute("SELECT 1 FROM profile_media_objects WHERE id=%s", (identifier,))
            ).fetchone()
            if exists:
                continue
            path.unlink()
            removed += 1
        if removed:
            descriptor = os.open(root, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        return removed
