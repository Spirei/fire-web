"""Read immutable profile bytes from the same PG snapshot as a backup dump."""

from contextlib import asynccontextmanager

from fastapi import HTTPException
from psycopg.pq import TransactionStatus

from .backups import BackupFailure
from .profile_media import ProfileMedia


@asynccontextmanager
async def profile_snapshot_media_lock(snapshot):
    """Pin files before the first repeatable-read snapshot can be established.

    A transaction lock acquired by a SELECT inside RR is too late: that SELECT
    may already have taken its snapshot before waiting for the lock. This fresh
    autocommit connection takes a session lock before entering snapshot.transaction.
    Explicit release is backed by the enclosing connection's guaranteed close.
    """
    if not snapshot.autocommit or snapshot.info.transaction_status != TransactionStatus.IDLE:
        raise BackupFailure("媒体保护必须在备份快照事务开始前建立")
    await snapshot.execute("SELECT pg_advisory_lock_shared(hashtextextended('profile-media-lifecycle',0))")
    try:
        yield
    finally:
        await snapshot.execute(
            "SELECT pg_advisory_unlock_shared(hashtextextended('profile-media-lifecycle',0))"
        )


async def capture_profile_media(snapshot, settings, entries):
    present = await (
        await snapshot.execute("SELECT to_regclass('public.profile_media_objects') AS relation")
    ).fetchone()
    if present["relation"] is None:
        return
    rows = await (
        await snapshot.execute("SELECT id,owner_id FROM profile_media_objects ORDER BY id")
    ).fetchall()
    media = ProfileMedia(settings)
    media_count = sum(name.startswith(("files/", "assets/", "profile-media/", "resource-media/")) for name in entries)
    total = sum(len(raw) for raw in entries.values())
    for row in rows:
        if media_count >= 1000:
            raise BackupFailure("文件与素材数量超过备份预算")
        try:
            raw, _ = await media.read(snapshot, row["owner_id"], row["id"])
        except HTTPException:
            raise BackupFailure("个人资料文件缺失或不完整，无法完成可恢复备份") from None
        total += len(raw)
        if total > settings.backup_max_bytes:
            raise BackupFailure("文件与素材总量超过备份预算")
        entries["profile-media/" + str(row["id"])] = raw
        media_count += 1
