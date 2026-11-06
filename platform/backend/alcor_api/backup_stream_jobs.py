"""Joint snapshot, bounded IO, ownership guards and publication for v2 backups."""

import asyncio
import hashlib
import json
import os
import shutil
import stat
import tempfile
import threading
import time
from datetime import UTC, datetime
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from . import __version__, backups
from .backup_stream_archive import Blob, pack_archive
from .backup_stream_codec import CHUNK, StreamFailure
from .backup_stream_storage import existing_directory, limits_for
from .connections import Vault
from .profile_backup import profile_snapshot_media_lock
from .profile_media import ProfileMedia


def check_space(path, needed):
    if shutil.disk_usage(path).free < needed:
        raise StreamFailure("可用磁盘不足以安全完成备份或恢复")


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def file_hash(path, maximum):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != os.getuid()
            or before.st_mode & 0o077
            or before.st_nlink != 1
            or before.st_size > maximum
        ):
            raise StreamFailure("备份原文件身份、权限或大小无效")
        hashed = hashlib.sha256()
        while raw := stream.read(CHUNK):
            hashed.update(raw)
        after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise StreamFailure("备份原文件读取期间发生变化")
        return before.st_size, hashed.hexdigest()


async def checked_work(db, task, function):
    cancel = threading.Event()
    running = asyncio.create_task(asyncio.to_thread(function, cancel))
    started = time.monotonic()
    try:
        while not running.done():
            await asyncio.wait({running}, timeout=0.5)
            await backups.guard(db, task)
            if time.monotonic() - started > db.settings.backup_stream_seconds:
                raise backups.BackupFailure("备份或恢复超过执行预算")
        return await running
    except BaseException:
        cancel.set()
        await asyncio.shield(asyncio.gather(running, return_exceptions=True))
        raise


async def collect_sources(snapshot, settings):
    from .media_storage import valid_asset_name

    limits = limits_for(settings)
    blobs = []
    for prefix, value in [("files", settings.file_root), ("assets", settings.asset_root)]:
        if value is None or not Path(value).exists():
            continue
        root = existing_directory(value)
        for path in root.iterdir():
            if len(blobs) >= limits.max_objects:
                raise StreamFailure("备份原件数量超过预算")
            if prefix == "files" and path.name in {"profile-media", "resource-media", "app-packages"}:
                existing_directory(path)
                continue
            if prefix == "files":
                import re

                if not re.fullmatch("[0-9a-f]{64}", path.name):
                    raise StreamFailure("文件目录包含未登记文件")
                info = path.lstat()
                blobs.append(Blob.file(prefix + "/" + path.name, path, info.st_size, path.name))
            else:
                if not valid_asset_name(path.name):
                    raise StreamFailure("素材名称无效")
                size, sha = await asyncio.to_thread(file_hash, path, limits.max_bytes)
                blobs.append(Blob.file(prefix + "/" + path.name, path, size, sha))
    packages = await (await snapshot.execute("SELECT to_regclass('public.fire_app_packages') AS relation")).fetchone()
    if packages['relation']:
        indexed = {blob.name:blob.size for blob in blobs}
        rows = await (await snapshot.execute('SELECT sha256,min(byte_length) AS bytes,max(byte_length) AS maximum FROM fire_app_packages GROUP BY sha256')).fetchall()
        if any(row['bytes'] != row['maximum'] or indexed.get('files/'+row['sha256']) != row['bytes'] for row in rows):
            raise StreamFailure('安装包原件缺失或登记长度不一致，无法完成联合备份')
    profile = await (
        await snapshot.execute("SELECT to_regclass('public.profile_media_objects') AS relation")
    ).fetchone()
    if profile["relation"]:
        rows = await (
            await snapshot.execute(
                "SELECT id,sha256,byte_length FROM profile_media_objects ORDER BY id LIMIT %s",
                (limits.max_objects + 1,),
            )
        ).fetchall()
        if rows:
            root = ProfileMedia(settings).root()
            for row in rows:
                blobs.append(
                    Blob.file(
                        "profile-media/" + str(row["id"]),
                        root / str(row["id"]),
                        row["byte_length"],
                        row["sha256"],
                    )
                )
    from .shared_attachment_media import media_inventory
    rows = await media_inventory(snapshot, limits.max_objects + 1)
    if rows:
        root = existing_directory(settings.file_root) / "resource-media"
        existing_directory(root)
        for row in rows:
            if row["size"] != row["max_size"]:
                raise StreamFailure("资源库或共享附件原件大小记录不一致")
            blobs.append(Blob.file("resource-media/" + row["sha256"], root / row["sha256"], row["size"], row["sha256"]))
    if len(blobs) > limits.max_objects or sum(blob.size for blob in blobs) > limits.max_bytes:
        raise StreamFailure("备份原件超过已配置容量或数量预算")
    small = {}
    await backups.capture_provider_key(snapshot, settings, small)
    for name, raw in small.items():
        blobs.append(Blob.memory(name, raw))
    return blobs


async def create_stream_backup(settings, db, task):
    from .worker import checkpoint, owned_row

    try:
        root = backups.private_dir(settings.backup_dir)
        key = backups.backup_key(settings)
        if not await checkpoint(db, task, "backup_snapshot"):
            raise backups.BackupFailure("任务已取消")
        await backups.guard(db, task)
        async with db.connection() as conn:
            existing = await (
                await conn.execute("SELECT * FROM backups WHERE id=%s", (task["id"],))
            ).fetchone()
        if existing:
            return {"scope": "backup", "backup_id": str(existing["id"]), "message": "备份已完成"}
        vault = Vault(backups.private_dir(settings.connection_secret_dir))
        vault.key()
        with tempfile.TemporaryDirectory(prefix=".creating-stream-", dir=root) as temporary:
            directory = Path(temporary)
            directory.chmod(0o700)
            dump = directory / "database.dump"
            backups.write_private(dump, b"")
            capsule = directory / "bundle.enc"
            async with (
                await psycopg.AsyncConnection.connect(
                    backups.source_dsn(db),
                    autocommit=True,
                    row_factory=dict_row,
                    connect_timeout=3,
                    options="-c idle_in_transaction_session_timeout=0 -c statement_timeout=5000",
                ) as snapshot,
                profile_snapshot_media_lock(snapshot),
                snapshot.transaction(),
            ):
                await snapshot.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                acquired = await (
                    await snapshot.execute(
                        "SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) AS ok",
                        ("backup:" + str(settings.instance_id),),
                    )
                ).fetchone()
                if not acquired["ok"]:
                    raise backups.BackupFailure("已有备份正在执行")
                await backups.verify_identity(snapshot, db.settings)
                exported = (await (await snapshot.execute("SELECT pg_export_snapshot() AS id")).fetchone())[
                    "id"
                ]
                blobs = await collect_sources(snapshot, settings)
                blobs.append(
                    Blob.memory(
                        "secrets/connections.key",
                        backups.private_read(Path(settings.connection_secret_dir) / "connections.key", 128),
                    )
                )
                current = await (
                    await snapshot.execute("SELECT revision FROM connection_settings WHERE kind='postgresql'")
                ).fetchone()
                if current:
                    raw = backups.private_read(vault.bootstrap_path(settings.instance_id), 65536)
                    decoded = json.loads(vault.decrypt(raw.decode(), "bootstrap", settings.instance_id))
                    if decoded["revision"] != str(current["revision"]):
                        raise backups.BackupFailure("连接启动快照尚未同步，请稍后备份")
                    blobs.append(Blob.memory("secrets/bootstrap.enc", raw))
                database_size = (
                    await (
                        await snapshot.execute("SELECT pg_database_size(current_database()) AS size")
                    ).fetchone()
                )["size"]
                reserve = settings.backup_stream_disk_reserve_bytes
                check_space(root, sum(blob.size for blob in blobs) + database_size * 2 + reserve)
                hashes = await backups.tables_and_hashes(snapshot)
                await backups.command(
                    settings,
                    db,
                    task,
                    "pg_dump",
                    [
                        "--format=custom",
                        "--no-owner",
                        "--no-privileges",
                        "--schema=public",
                        "--exclude-table=public.alcor_restore_target",
                        "--snapshot=" + exported,
                        "--file=" + str(dump),
                    ],
                    backups.source_dsn(db),
                    directory,
                    output=dump,
                    output_limit=settings.backup_stream_max_bytes,
                    seconds=settings.backup_stream_seconds,
                )
                size, sha = await asyncio.to_thread(file_hash, dump, settings.backup_stream_max_bytes)
                blobs.append(Blob.file("database.dump", dump, size, sha))
                check_space(root, sum(blob.size for blob in blobs) + len(blobs) * 1024 + reserve)
                namespaces = {blob.name.split("/")[0] for blob in blobs}
                media_contract = (
                    "immutable-sha256+profile-uuid+resource-sha-v1"
                    if "resource-media" in namespaces
                    else "immutable-sha256+profile-uuid-v1"
                    if "profile-media" in namespaces
                    else "immutable-sha256-v1"
                )
                manifest = {
                    "format": 2,
                    "backup_id": str(task["id"]),
                    "instance_id": str(settings.instance_id),
                    "environment": settings.environment,
                    "software_version": __version__,
                    "created_at": datetime.now(UTC).isoformat(),
                    "schema": db.expected_migrations,
                    "tables": hashes,
                    "source_database_bytes": database_size,
                    "media_contract": media_contract,
                    "roles": "restore-with-enrolled-target-owner",
                }
                if not await checkpoint(db, task, "backup_encrypt"):
                    raise backups.BackupFailure("任务已取消")

                def encode(cancel):
                    fd = os.open(capsule, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(fd, "wb") as output:
                        _manifest, count, sha = pack_archive(
                            output, key, manifest, blobs, limits_for(settings), cancel
                        )
                        output.flush()
                        os.fsync(output.fileno())
                    return count, sha

                count, sha = await checked_work(db, task, encode)
            # Media pin remains held until all original bytes have been sealed.
            # Revalidate complete encrypted bytes before a publication transaction.
            probe = {"id": task["id"], "source_instance": settings.instance_id, "bytes": count, "sha256": sha}

            def verify(cancel):
                from .backup_stream_storage import read_archive

                configured = settings.model_copy(update={"backup_dir": directory})
                os.rename(capsule, directory / (str(task["id"]) + ".enc"))
                read_archive(configured, probe, cancelled=cancel)
                os.rename(directory / (str(task["id"]) + ".enc"), capsule)

            await checked_work(db, task, verify)
            async with db.connection() as conn, conn.transaction():
                owned = await owned_row(conn, task)
                if not owned or owned["status"] != "running":
                    raise backups.BackupFailure("执行权已变化")
                await backups.authorized_job(conn,task,settings)
                # Must recheck under task-row ownership before replacing a path.
                prior = await (
                    await conn.execute("SELECT id FROM backups WHERE id=%s", (task["id"],))
                ).fetchone()
                if prior:
                    return {"scope": "backup", "backup_id": str(prior["id"]), "message": "备份已完成"}
                os.replace(capsule, root / (str(task["id"]) + ".enc"))
                sync_directory(root)
                await conn.execute(
                    "INSERT INTO backups(id,owner_id,source_instance,software_version,bytes,sha256,verified_at) VALUES(%s,%s,%s,%s,%s,%s,clock_timestamp())",
                    (task["id"], task["owner_id"], settings.instance_id, __version__, count, sha),
                )
                await conn.execute(
                    "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'backup.created',%s,%s)",
                    (task["owner_id"], str(task["id"]), task["request_id"]),
                )
        return {
            "scope": "backup",
            "backup_id": str(task["id"]),
            "bytes": count,
            "sha256": sha,
            "message": "备份已完成",
        }
    except (StreamFailure, OSError, ValueError) as exc:
        raise backups.BackupFailure(
            str(exc) if isinstance(exc, StreamFailure) else "流式备份存储或配置无法安全读取"
        ) from None


async def restore_stream_backup(settings, db, task, row, manifest, entries, restore_core):
    """Authenticate first, stage once on the recovery filesystem, reuse PG guards."""
    try:
        target = backups.target_for(settings, task["payload"]["target_id"])
        ticket = backups.ticket_data(
            settings, task["payload"]["restore_ticket"], task["owner_id"], row["id"], target
        )
        if ticket["sha256"] != row["sha256"]:
            raise backups.BackupFailure("备份已变化")
        await backups.guard(db, task)
        conn = await backups.target_connection(target)
        await conn.close()
        recovery = existing_directory(backups.private_dir(target.recovery_directory))
        if list(recovery.iterdir()):
            raise backups.BackupFailure("恢复目录非空，未执行覆盖")
        reserve = settings.backup_stream_disk_reserve_bytes
        database_bytes = manifest.get("source_database_bytes")
        if type(database_bytes) is not int or database_bytes < 0:
            raise StreamFailure("备份缺少恢复磁盘预算")
        requirements = [
            (recovery.parent, sum(info["bytes"] for info in manifest["files"].values())),
            (target.data_directory, database_bytes * 4),
            (settings.backup_dir, manifest["files"]["database.dump"]["bytes"]),
        ]
        grouped = {}
        for path, needed in requirements:
            path = Path(path)
            device = path.stat().st_dev
            if device not in grouped:
                grouped[device] = [path, reserve]
            grouped[device][1] += needed
        for path, needed in grouped.values():
            check_space(path, needed)
        with tempfile.TemporaryDirectory(prefix=".alcor-restoring-", dir=recovery.parent) as temporary:
            directory = Path(temporary)
            directory.chmod(0o700)
            staged = await checked_work(
                db, task, lambda cancel: entries.materialize(directory, cancelled=cancel)
            )
            return await restore_core(settings, db, task, row, manifest, staged)
    except (StreamFailure, OSError, ValueError) as exc:
        raise backups.BackupFailure(
            str(exc) if isinstance(exc, StreamFailure) else "流式恢复存储或配置无法安全读取"
        ) from None


def copy_entry(entries, name, target, cancelled=None):
    if cancelled is not None and cancelled.is_set():
        raise StreamFailure("恢复已取消")
    if hasattr(entries, "copy_to"):
        entries.copy_to(name, target, cancelled)
    else:
        backups.write_private(target, entries[name])
        sync_directory(Path(target).parent)


async def restore_media(settings, db, task, entries, recovery):
    def execute(cancel):
        files = backups.private_dir(recovery / "files")
        assets = (
            backups.private_dir(recovery / "assets")
            if any(n.startswith("assets/") for n in entries)
            else None
        )
        roots = {"files": files, "profile-media": None, "resource-media": None, "app-packages": None, "assets": assets}
        for name in entries:
            prefix = name.split("/")[0]
            if prefix not in roots:
                continue
            if roots[prefix] is None:
                roots[prefix] = backups.private_dir(files / prefix)
            copy_entry(entries, name, roots[prefix] / name.split("/")[1], cancel)
        for root in roots.values():
            if root is not None:
                sync_directory(root)
        sync_directory(files)
        sync_directory(recovery)

    try:
        await checked_work(db, task, execute)
    except (StreamFailure, OSError) as exc:
        raise backups.BackupFailure(
            str(exc) if isinstance(exc, StreamFailure) else "恢复原文件写入失败"
        ) from None
