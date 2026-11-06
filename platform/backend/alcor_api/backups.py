"""Authenticated local backup capsules and empty, server-enrolled isolation restores."""

import asyncio
import hashlib
import io
import json
import os
import re
import shutil
import stat
import tarfile
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated
from uuid import UUID

import psycopg
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from . import __version__
from .client_auth import recent
from .connections import Vault, canonical
from .db import PRODUCT, verify_identity
from .security import Identity, administrator, lock_mutation_identity

router = APIRouter(prefix="/api", tags=["backups"])
Admin = Annotated[Identity, Depends(administrator)]


async def capture_provider_key(snapshot, settings, entries):
    """Capture and validate credentials against exactly the exported dump snapshot."""
    present = await (
        await snapshot.execute("SELECT to_regclass('public.fx_provider_revisions') AS relation")
    ).fetchone()
    if present["relation"] is None:
        return
    rows = await (
        await snapshot.execute(
            "SELECT id,secret_cipher,credential_instance FROM fx_provider_revisions WHERE secret_cipher IS NOT NULL"
        )
    ).fetchall()
    if not rows:
        return
    from .fx_custom import decrypt_existing, existing_key

    try:
        key = existing_key(settings)
        for row in rows:
            decrypt_existing(key, row)
    except HTTPException:
        raise BackupFailure("供应商凭据密钥缺失或不匹配，无法完成可恢复备份") from None
    entries["secrets/fx-providers.key"] = key


class BackupFailure(Exception):
    pass


def private_dir(value):
    if value is None:
        raise BackupFailure("备份存储尚未配置")
    p = Path(value)
    p.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = p.stat()
    if p.is_symlink() or not p.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise BackupFailure("私有目录权限不正确")
    return p


def private_read(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.getuid()
            or info.st_mode & 0o077
            or info.st_size > limit
        ):
            raise BackupFailure("私有文件身份或大小不符")
        raw = file.read(limit + 1)
        after = os.fstat(file.fileno())
        if len(raw) > limit or (info.st_size, info.st_mtime_ns, info.st_ctime_ns) != (
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise BackupFailure("读取期间文件已变化，请重新备份")
        return raw


def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())


def backup_key(settings):
    if settings.backup_secret_dir is None or settings.connection_secret_dir is None:
        raise BackupFailure("备份密钥或连接凭据目录尚未配置")
    if settings.backup_secret_dir.resolve() == settings.connection_secret_dir.resolve():
        raise BackupFailure("备份恢复密钥须独立保存")
    return Vault(private_dir(settings.backup_secret_dir), namespace="backup").key()


def tools(settings, name):
    binary = (
        Path(settings.pg_tools_dir) / name
        if settings.pg_tools_dir
        else Path(shutil.which(name) or "/missing")
    )
    if not binary.is_file():
        raise BackupFailure("PostgreSQL备份工具尚未配置")
    return str(binary)


def source_dsn(db):
    return db.settings.database_url.get_secret_value()


def command_env(dsn, directory):
    info = conninfo_to_dict(dsn)
    if not all(info.get(k) for k in ["host", "user", "dbname"]):
        raise BackupFailure("数据库目标必须显式指定")
    if any(k in info for k in ["service", "passfile"]) or "," in info["host"]:
        raise BackupFailure("不支持隐式或多目标连接")
    password = info.get("password", "")
    if "\n" in password or "\r" in password:
        raise BackupFailure("数据库凭据无法用于备份工具")
    passfile = directory / "pgpass"
    if not passfile.exists():
        write_private(
            passfile, ("*:*:*:*:" + password.replace("\\", "\\\\").replace(":", "\\:") + "\n").encode()
        )
    env = {
        "PATH": os.environ.get("PATH", ""),
        "LANG": "C",
        "PGPASSFILE": str(passfile),
        "PGCONNECT_TIMEOUT": "3",
    }
    for key, envkey in [
        ("host", "PGHOST"),
        ("hostaddr", "PGHOSTADDR"),
        ("port", "PGPORT"),
        ("user", "PGUSER"),
        ("dbname", "PGDATABASE"),
        ("sslmode", "PGSSLMODE"),
    ]:
        if key in info:
            env[envkey] = info[key]
    return env


async def authorized_job(conn,task,settings=None):
    if settings is not None:
        from .backup_schedule import authorize_scheduled_job
        if await authorize_scheduled_job(conn,task,settings):
            return
    row = await (
        await conn.execute(
            """SELECT u.id FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=%s
        AND s.token_hash=%s AND u.active AND u.role='admin' AND s.session_version=u.session_version
        AND s.client_id=%s AND s.expires_at>clock_timestamp()
        AND s.created_at>clock_timestamp()-interval '15 minutes' FOR SHARE OF u,s""",
            (task["owner_id"], task["payload"].get("_session_hash", ""), task["payload"].get("_session_client", "new-web") if task["payload"].get("_session_client", "new-web") in ("new-web", "legacy-web") else "invalid"),
        )
    ).fetchone()
    if not row:
        raise BackupFailure("任务操作授权已失效")


async def guard(db, task):
    from .worker import owned_row

    async with db.connection() as conn, conn.transaction():
        row = await owned_row(conn, task)
        if not row or row["status"] != "running":
            raise BackupFailure("任务已取消或执行权已变化")
        await authorized_job(conn,task,db.settings)
        await conn.execute(
            "UPDATE tasks SET lease_until=clock_timestamp()+make_interval(secs=>%s) WHERE id=%s",
            (db.settings.lease_seconds, task["id"]),
        )


async def command(settings, db, task, name, args, dsn, directory, *, output=None, output_limit=None, seconds=120):
    process = await asyncio.create_subprocess_exec(
        tools(settings, name),
        *args,
        env=command_env(dsn, directory),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    started = time.monotonic()
    waiter = asyncio.create_task(process.wait())
    try:
        while process.returncode is None:
            try:
                await asyncio.wait_for(asyncio.shield(waiter), timeout=0.5)
            except TimeoutError:
                pass
            await guard(db, task)
            if time.monotonic() - started > seconds or (
                output and output.exists() and output.stat().st_size > (settings.backup_max_bytes if output_limit is None else output_limit)
            ):
                raise BackupFailure("备份操作超过执行预算")
        if process.returncode:
            raise BackupFailure("PostgreSQL备份工具执行失败")
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 3)
            except TimeoutError:
                process.kill()
                await process.wait()
        await waiter


async def tables_and_hashes(conn):
    await conn.execute("SET LOCAL TIME ZONE 'UTC'")
    names = [
        r["name"]
        for r in await (
            await conn.execute(
                "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' AND tablename<>'alcor_restore_target' ORDER BY tablename"
            )
        ).fetchall()
    ]
    result = {}
    for name in names:
        count = 0
        h = hashlib.sha256()
        async with conn.cursor(name="backup_" + hashlib.sha256(name.encode()).hexdigest()[:12]) as cursor:
            await cursor.execute(
                sql.SQL(
                    "SELECT row_to_json(t)::text AS value FROM public.{} t ORDER BY row_to_json(t)::text"
                ).format(sql.Identifier(name))
            )
            async for row in cursor:
                raw = row["value"].encode()
                h.update(len(raw).to_bytes(8, "big"))
                h.update(raw)
                count += 1
        result[name] = {"rows": count, "sha256": h.hexdigest()}
    return result


def media_entries(settings):
    from .media_storage import valid_asset_name

    result = {}
    total = 0
    roots = [("files", settings.file_root), ("assets", settings.asset_root)]
    for prefix, directory in roots:
        if directory is None:
            continue
        root = private_dir(directory)
        for path in sorted(root.iterdir()):
            if prefix == "files" and path.name in {"profile-media", "resource-media", "app-packages"}:
                if path.is_symlink() or not path.is_dir():
                    raise BackupFailure("个人资料目录无效")
                # Captured under the database snapshot below, never sweep orphans.
                continue
            if len(result) >= 1000:
                raise BackupFailure("文件与素材数量超过备份预算")
            if (prefix == "files" and not re.fullmatch(r"[0-9a-f]{64}", path.name)) or (
                prefix == "assets" and not valid_asset_name(path.name)
            ):
                raise BackupFailure("文件目录包含未登记的文件")
            raw = private_read(path, settings.backup_max_bytes)
            if prefix == "files" and hashlib.sha256(raw).hexdigest() != path.name:
                raise BackupFailure("不可变文件校验失败")
            total += len(raw)
            if total > settings.backup_max_bytes:
                raise BackupFailure("文件与素材总量超过备份预算")
            result[prefix + "/" + path.name] = raw
    return result


def pack(settings, manifest, entries):
    manifest["files"] = {
        name: {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()} for name, raw in entries.items()
    }
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as tar:
        for name, raw in {"manifest.json": canonical(manifest).encode(), **entries}.items():
            item = tarfile.TarInfo(name)
            item.size = len(raw)
            item.mode = 0o600
            tar.addfile(item, io.BytesIO(raw))
    if (
        len(stream.getvalue()) > settings.backup_max_bytes
        or sum(len(v) for v in entries.values()) > settings.backup_max_bytes
    ):
        raise BackupFailure("备份超过容量预算")
    return Fernet(backup_key(settings)).encrypt(stream.getvalue())


def unpack_legacy(settings, row):
    from .media_storage import valid_asset_name

    root = private_dir(settings.backup_dir)
    encrypted = private_read(root / (str(row["id"]) + ".enc"), settings.backup_max_bytes * 2)
    if hashlib.sha256(encrypted).hexdigest() != row["sha256"]:
        raise BackupFailure("备份文件校验失败")
    try:
        from .backup_stream_storage import existing_key
        try:
            key = existing_key(settings)
        except (OSError, ValueError) as exc:
            raise BackupFailure("备份密钥缺失或无法安全读取") from exc
        plain = Fernet(key).decrypt(encrypted)
    except InvalidToken:
        raise BackupFailure("备份恢复密钥不匹配") from None
    entries = {}
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(plain), mode="r:gz") as tar:
            for item in tar:
                if (
                    not item.isfile()
                    or item.name in entries
                    or item.size < 0
                    or (
                        item.name
                        not in {
                            "manifest.json",
                            "database.dump",
                            "secrets/connections.key",
                            "secrets/bootstrap.enc",
                            "secrets/fx-providers.key",
                        }
                        and not re.fullmatch(r"files/[0-9a-f]{64}", item.name)
                        and not re.fullmatch(r"resource-media/[0-9a-f]{64}", item.name)
                        and not re.fullmatch(r"app-packages/[0-9a-f]{32}", item.name)
                        and not re.fullmatch(r"profile-media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", item.name)
                        and not (item.name.startswith("assets/") and valid_asset_name(item.name[7:]))
                    )
                ):
                    raise BackupFailure("备份文件清单无效")
                total += item.size
                if total > settings.backup_max_bytes or len(entries) > 1004:
                    raise BackupFailure("备份超过容量预算")
                entries[item.name] = tar.extractfile(item).read(item.size + 1)
        manifest = json.loads(entries.pop("manifest.json"))
        if (
            set(manifest["files"]) != set(entries)
            or manifest["instance_id"] != str(row["source_instance"])
            or manifest["backup_id"] != str(row["id"])
        ):
            raise BackupFailure("备份来源不匹配")
        known = {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in settings.migration_dir.glob("[0-9]*.sql")
        }
        archived = manifest["schema"]
        if (
            manifest.get("format") != 1
            or "0006_backups.sql" not in archived
            or sorted(archived) != sorted(known)[: len(archived)]
            or any(known.get(name) != sha for name, sha in archived.items())
        ):
            raise BackupFailure("备份结构与当前版本不兼容")
        for name, raw in entries.items():
            if manifest["files"][name] != {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}:
                raise BackupFailure("备份内部文件校验失败")
        if "database.dump" not in entries or "secrets/connections.key" not in entries:
            raise BackupFailure("备份缺少必要恢复文件")
        return manifest, entries
    except (ValueError, KeyError, TypeError, tarfile.TarError, EOFError):
        raise BackupFailure("备份内容无法验证") from None


async def retention_installed(conn):
    row = await (await conn.execute(
        "SELECT to_regclass('public.backup_retention_results') IS NOT NULL AS present,"
        "EXISTS(SELECT 1 FROM schema_migrations WHERE name='0135_backup_schedule.sql') AS installed"
    )).fetchone()
    if row['present'] != row['installed']:
        raise BackupFailure('备份保留结构不完整，不能确认文件可用')
    return row['installed']


async def row_for(db, backup_id):
    async with db.connection() as conn:
        query = ("SELECT b.*,r.state AS retention_state FROM backups b LEFT JOIN LATERAL (SELECT state FROM backup_retention_results WHERE backup_id=b.id ORDER BY created_at DESC,task_id DESC LIMIT 1) r ON true WHERE b.id=%s"
                 if await retention_installed(conn) else
                 "SELECT b.*,NULL::text AS retention_state FROM backups b WHERE b.id=%s")
        row = await (await conn.execute(query,(backup_id,))).fetchone()
    if not row:
        raise BackupFailure("备份不存在")
    if row['retention_state']=='deleted':
        raise BackupFailure("此备份已由明确保留策略移除，登记历史与回执仍保留")
    if row['retention_state'] in {'admitted','unknown'}:
        raise BackupFailure("此备份保留操作结果未知，请核对原保留任务")
    return row


def target_for(settings, target_id):
    target = next((t for t in settings.restore_targets if t.id == target_id), None)
    if target is None:
        raise BackupFailure("恢复目标尚未登记")
    if target.instance_id == settings.instance_id:
        raise BackupFailure("不能覆盖当前平台")
    from .backup_stream_storage import existing_directory
    from .backup_stream_codec import StreamFailure
    recovery = Path(target.recovery_directory)
    if any(part.is_symlink() for part in (recovery, *recovery.parents)):
        raise BackupFailure("恢复目录路径不能包含符号链接")
    if recovery.exists():
        try:
            existing_directory(recovery)
        except (OSError, ValueError, StreamFailure):
            raise BackupFailure("恢复目录无法安全读取") from None
    for path in [
        settings.backup_dir,
        settings.backup_secret_dir,
        settings.connection_secret_dir,
        settings.file_root,
        settings.asset_root,
    ]:
        if path and (
            recovery.resolve() == path.resolve()
            or recovery.resolve().is_relative_to(path.resolve())
            or path.resolve().is_relative_to(recovery.resolve())
        ):
            raise BackupFailure("恢复目录必须与当前平台隔离")
    return target


async def target_connection(target, *, enroll=False):
    info = conninfo_to_dict(target.database_url.get_secret_value())
    if not all(info.get(k) for k in ["dbname", "host", "user"]) or "," in info["host"]:
        raise BackupFailure("恢复目标必须精确指定")
    conn = await psycopg.AsyncConnection.connect(
        target.database_url.get_secret_value(),
        autocommit=True,
        row_factory=dict_row,
        connect_timeout=3,
        options="-c statement_timeout=5000 -c lock_timeout=2000",
    )
    try:
        directory = (await (await conn.execute("SHOW data_directory")).fetchone())["data_directory"]
        dbname = (await (await conn.execute("SELECT current_database() AS name")).fetchone())["name"]
        if Path(directory).resolve() != target.data_directory.resolve() or dbname != info["dbname"]:
            raise BackupFailure("恢复目标数据目录或库身份不符")
        other = (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()"
                )
            ).fetchone()
        )["n"]
        if other:
            raise BackupFailure("恢复目标正在使用中")
        objects = await (
            await conn.execute(
                "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','v','m','f','S')"
            )
        ).fetchall()
        names = {r["relname"] for r in objects}
        extra = (
            await (
                await conn.execute("""SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%')
            OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema') AS found""")
            ).fetchone()
        )["found"]
        if extra:
            raise BackupFailure("恢复目标包含额外对象，未执行覆盖")
        if enroll:
            if names:
                raise BackupFailure("只能登记全新空库")
            await conn.execute(
                "CREATE TABLE alcor_restore_target(instance_id uuid PRIMARY KEY,environment text NOT NULL CHECK(environment='test'),product text NOT NULL)"
            )
            await conn.execute(
                "INSERT INTO alcor_restore_target VALUES (%s,%s,%s)", (target.instance_id, "test", PRODUCT)
            )
        elif names != {"alcor_restore_target"}:
            raise BackupFailure("恢复目标非空，未执行覆盖")
        marker = await (await conn.execute("SELECT * FROM alcor_restore_target")).fetchall()
        if (
            len(marker) != 1
            or str(marker[0]["instance_id"]) != str(target.instance_id)
            or marker[0]["environment"] != "test"
            or marker[0]["product"] != PRODUCT
        ):
            raise BackupFailure("恢复目标标记不符")
        return conn
    except BaseException:
        await conn.close()
        raise


def target_fingerprint(target):
    values = target.model_dump(mode="json", exclude={"database_url"})
    values["dsn_sha256"] = hashlib.sha256(target.database_url.get_secret_value().encode()).hexdigest()
    return hashlib.sha256(canonical(values).encode()).hexdigest()


def read_backup_key(settings):
    from .backup_stream_storage import existing_key
    from .backup_stream_codec import StreamFailure
    try:
        return existing_key(settings)
    except (OSError, ValueError, StreamFailure):
        raise BackupFailure("备份密钥缺失或无法安全读取") from None


def ticket_data(settings, ticket, owner, backup_id, target):
    try:
        data = json.loads(Fernet(read_backup_key(settings)).decrypt(ticket.encode(), ttl=300))
    except (InvalidToken, ValueError):
        raise BackupFailure("恢复预览已过期，请重新核对") from None
    if (
        data.get("owner") != owner
        or data.get("backup_id") != str(backup_id)
        or data.get("target") != target_fingerprint(target)
    ):
        raise BackupFailure("恢复预览与目标不符")
    return data


async def create_legacy_backup(settings, db, task):
    from .worker import checkpoint, owned_row

    root = private_dir(settings.backup_dir)
    backup_key(settings)
    if not await checkpoint(db, task, "backup_snapshot"):
        raise BackupFailure("任务已取消")
    await guard(db, task)
    async with db.connection() as conn:
        existing = await (await conn.execute("SELECT * FROM backups WHERE id=%s", (task["id"],))).fetchone()
    if existing:
        return {"scope": "backup", "backup_id": str(existing["id"]), "message": "备份已完成"}
    entries = media_entries(settings)
    vault = Vault(private_dir(settings.connection_secret_dir))
    vault.key()
    entries["secrets/connections.key"] = private_read(
        Path(settings.connection_secret_dir) / "connections.key", 128
    )
    with tempfile.TemporaryDirectory(prefix=".creating-", dir=root) as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        dump = directory / "database.dump"
        write_private(dump, b"")
        from .profile_backup import profile_snapshot_media_lock

        async with (
            await psycopg.AsyncConnection.connect(
                source_dsn(db),
                autocommit=True,
                row_factory=dict_row,
                connect_timeout=3,
                options="-c idle_in_transaction_session_timeout=0 -c statement_timeout=5000",
            ) as snapshot,
            profile_snapshot_media_lock(snapshot),
            snapshot.transaction(),
        ):
            await snapshot.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            locked = await (
                await snapshot.execute(
                    "SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) AS ok",
                    ("backup:" + str(settings.instance_id),),
                )
            ).fetchone()
            if not locked["ok"]:
                raise BackupFailure("已有备份正在执行")
            await verify_identity(snapshot, db.settings)
            snap = (await (await snapshot.execute("SELECT pg_export_snapshot() AS id")).fetchone())["id"]
            await capture_provider_key(snapshot, settings, entries)
            from .profile_backup import capture_profile_media
            await capture_profile_media(snapshot, settings, entries)
            from .resource_media import capture_resource_media
            await capture_resource_media(snapshot, settings, entries)
            hashes = await tables_and_hashes(snapshot)
            pg = await (
                await snapshot.execute("SELECT revision FROM connection_settings WHERE kind='postgresql'")
            ).fetchone()
            if pg:
                raw = private_read(vault.bootstrap_path(settings.instance_id), 65536)
                decoded = json.loads(vault.decrypt(raw.decode(), "bootstrap", settings.instance_id))
                if decoded["revision"] != str(pg["revision"]):
                    raise BackupFailure("连接启动快照尚未同步，请稍后备份")
                entries["secrets/bootstrap.enc"] = raw
            await command(
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
                    "--snapshot=" + snap,
                    "--file=" + str(dump),
                ],
                source_dsn(db),
                directory,
                output=dump,
            )
        entries["database.dump"] = private_read(dump, settings.backup_max_bytes)
        manifest = {
            "format": 1,
            "backup_id": str(task["id"]),
            "instance_id": str(settings.instance_id),
            "environment": settings.environment,
            "software_version": __version__,
            "created_at": datetime.now(UTC).isoformat(),
            "schema": db.expected_migrations,
            "tables": hashes,
            "media_contract": "immutable-sha256+profile-uuid+resource-sha-v1" if any(n.startswith("resource-media/") for n in entries) else "immutable-sha256+profile-uuid-v1" if any(n.startswith("profile-media/") for n in entries) else "immutable-sha256-v1",
            "roles": "restore-with-enrolled-target-owner",
        }
        if not await checkpoint(db, task, "backup_encrypt"):
            raise BackupFailure("任务已取消")
        encrypted = pack(settings, manifest, entries)
        sha = hashlib.sha256(encrypted).hexdigest()
        temp = directory / "bundle.enc"
        write_private(temp, encrypted)
        async with db.connection() as conn, conn.transaction():
            owned = await owned_row(conn, task)
            if not owned or owned["status"] != "running":
                raise BackupFailure("执行权已变化")
            await authorized_job(conn,task,settings)
            os.replace(temp, root / (str(task["id"]) + ".enc"))
            unpack(settings, {"id": task["id"], "source_instance": settings.instance_id, "sha256": sha})
            await conn.execute(
                "INSERT INTO backups(id,owner_id,source_instance,software_version,bytes,sha256,verified_at) VALUES (%s,%s,%s,%s,%s,%s,clock_timestamp())",
                (task["id"], task["owner_id"], settings.instance_id, __version__, len(encrypted), sha),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES (%s,'backup.created',%s,%s)",
                (task["owner_id"], str(task["id"]), task["request_id"]),
            )
    return {
        "scope": "backup",
        "backup_id": str(task["id"]),
        "bytes": len(encrypted),
        "sha256": sha,
        "message": "备份已完成",
    }


async def restore_legacy_backup(settings, db, task, row, manifest, entries):
    from .worker import checkpoint

    target = target_for(settings, task["payload"]["target_id"])
    ticket = ticket_data(settings, task["payload"]["restore_ticket"], task["owner_id"], row["id"], target)
    if ticket["sha256"] != row["sha256"]:
        raise BackupFailure("备份已变化")
    await guard(db, task)
    conn = await target_connection(target)
    await conn.close()
    recovery = private_dir(target.recovery_directory)
    if list(recovery.iterdir()):
        raise BackupFailure("恢复目录非空，未执行覆盖")
    if not await checkpoint(db, task, "backup_restore"):
        raise BackupFailure("任务已取消")
    with tempfile.TemporaryDirectory(prefix=".restoring-", dir=private_dir(settings.backup_dir)) as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        dump = directory / "database.dump"
        from .backup_stream_jobs import checked_work, copy_entry

        await checked_work(db, task, lambda cancel: copy_entry(entries, "database.dump", dump, cancel))
        listing = await asyncio.create_subprocess_exec(
            tools(settings, "pg_restore"),
            "--list",
            str(dump),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            toc, _ = await asyncio.wait_for(listing.communicate(), 10)
        finally:
            if listing.returncode is None:
                listing.kill()
                await listing.wait()
        if listing.returncode or len(toc) > 2 * 1024 * 1024:
            raise BackupFailure("备份对象清单无法读取")
        # The enrolled target already owns public and its isolation marker. Never drop that schema.
        lines = [
            line
            for line in toc.decode().splitlines()
            if not re.search(r";\s+\d+\s+\d+\s+(?:SCHEMA - public|COMMENT - SCHEMA public)\s", line)
        ]
        tocfile = directory / "restore.list"
        write_private(tocfile, ("\n".join(lines) + "\n").encode())
        await command(
            settings,
            db,
            task,
            "pg_restore",
            [
                "--single-transaction",
                "--exit-on-error",
                "--no-owner",
                "--no-privileges",
                "--use-list=" + str(tocfile),
                "--dbname=" + conninfo_to_dict(target.database_url.get_secret_value())["dbname"],
                str(dump),
            ],
            target.database_url.get_secret_value(),
            directory,
            seconds=settings.backup_stream_seconds if hasattr(entries, "copy_to") else 120,
        )
    if not await checkpoint(db, task, "backup_verify_restored"):
        raise BackupFailure("恢复结果待核对")
    async with (
        await psycopg.AsyncConnection.connect(
            target.database_url.get_secret_value(), autocommit=True, row_factory=dict_row, connect_timeout=3
        ) as restored,
        restored.transaction(),
    ):
        hashes = await tables_and_hashes(restored)
        if hashes != manifest["tables"]:
            raise BackupFailure("恢复数据逐表校验不符")
        for table in ["connection_settings", "registered_clients", "identity_passkey_config"]:
            if table not in hashes:
                continue
            original = (
                await (
                    await restored.execute(
                        sql.SQL(
                            "SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) AS value FROM {} t"
                        ).format(sql.Identifier(table))
                    )
                ).fetchone()
            )["value"]
            await restored.execute(
                "INSERT INTO restore_quarantine(category,payload) VALUES (%s,%s) ON CONFLICT(category) DO UPDATE SET payload=excluded.payload,quarantined_at=clock_timestamp()",
                (table, Jsonb(original)),
            )
        if "identity_security" in hashes:
            # Keep mandatory factors mandatory. Their envelopes bind the original instance UUID.
            with tempfile.TemporaryDirectory(prefix=".restore-identity-", dir=settings.backup_dir) as work:
                keydir = private_dir(Path(work))
                write_private(keydir / "connections.key", entries["secrets/connections.key"])
                vault = Vault(keydir)
                factors = await (
                    await restored.execute("SELECT * FROM identity_security FOR UPDATE")
                ).fetchall()
                for factor in factors:
                    updates = {}
                    for column, kind in [
                        ("totp_secret_ciphertext", "totp:"),
                        ("backup_key_ciphertext", "backup-key:"),
                    ]:
                        if factor[column]:
                            plain = vault.decrypt(
                                factor[column], kind + factor["user_id"], manifest["instance_id"]
                            )
                            updates[column] = vault.encrypt(
                                plain, kind + factor["user_id"], target.instance_id
                            )
                    if updates:
                        await restored.execute(
                            "UPDATE identity_security SET totp_secret_ciphertext=%s,backup_key_ciphertext=%s WHERE user_id=%s",
                            (
                                updates.get("totp_secret_ciphertext"),
                                updates.get("backup_key_ciphertext"),
                                factor["user_id"],
                            ),
                        )
            await restored.execute("DELETE FROM identity_challenges")
            await restored.execute("UPDATE identity_passkey_config SET enabled=false,revision='' ")
        if "identity_app_grants" in hashes:
            await restored.execute(
                "UPDATE identity_app_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp())"
            )
        if "identity_mail_outbox" in hashes:
            await restored.execute(
                "UPDATE identity_mail_outbox SET status=CASE WHEN status='sending' THEN 'unknown' ELSE 'cancelled' END,error_code='restore_requires_review',ciphertext=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE status IN ('queued','sending')"
            )
        await restored.execute(
            "INSERT INTO restore_quarantine(category,payload) VALUES ('external_delivery_disabled','{\"disabled\":true}'::jsonb) ON CONFLICT(category) DO UPDATE SET payload=excluded.payload,quarantined_at=clock_timestamp()"
        )
        # A restored worker must never resume old provider work. Older capsules
        # legitimately predate these tables; their later migration defaults disabled.
        fx_config = await (
            await restored.execute("SELECT to_regclass('public.fx_config') AS name")
        ).fetchone()
        if fx_config["name"]:
            await restored.execute("UPDATE fx_config SET enabled=false,revision=revision+1")
        fx_tasks = await (
            await restored.execute("SELECT to_regclass('public.fx_refresh_tasks') AS name")
        ).fetchone()
        if fx_tasks["name"]:
            await restored.execute(
                "UPDATE fx_refresh_tasks SET state=CASE WHEN state='running' THEN 'interrupted' ELSE 'failed' END,"
                "error_code='restore_requires_review',completed_at=clock_timestamp() "
                "WHERE state IN ('queued','running')"
            )
        await restored.execute("DELETE FROM sessions")
        await restored.execute("UPDATE client_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp())")
        await restored.execute("UPDATE authorization_codes SET used_at=COALESCE(used_at,clock_timestamp())")
        await restored.execute("UPDATE registered_clients SET active=false")
        await restored.execute("DELETE FROM connection_settings")
        await restored.execute("DELETE FROM connection_applied")
        await restored.execute("DELETE FROM worker_heartbeats")
        marker = await (
            await restored.execute("SELECT to_regclass('public.deployment_configuration') AS name")
        ).fetchone()
        if marker["name"]:
            await restored.execute("DELETE FROM deployment_configuration")
            await restored.execute("DELETE FROM deployment_config_actions")
            await restored.execute("DELETE FROM deployment_oauth_states")
        marker = await (
            await restored.execute("SELECT to_regclass('public.deployment_requests') AS name")
        ).fetchone()
        if marker["name"]:
            await restored.execute(
                "UPDATE deployment_requests SET status='unknown',finished_at=clock_timestamp() WHERE status IN ('queued','running')"
            )
            await restored.execute("DELETE FROM deployment_runner")
        await restored.execute(
            "UPDATE tasks SET status='failed',error_code='restore_requires_review',lease_until=NULL,finished_at=clock_timestamp() WHERE status IN ('queued','running','cancel_requested')"
        )
        await restored.execute(
            "UPDATE alcor_instance SET instance_id=%s,environment=%s", (target.instance_id, "test")
        )
        await restored.execute(
            "INSERT INTO audit_events(action,target_id) VALUES ('backup.restored',%s)", (str(row["id"]),)
        )
    from .migrate import migrate

    recovery_settings = settings.model_copy(
        update={
            "database_url": target.database_url,
            "instance_id": target.instance_id,
            "environment": "test",
            "redis_url": None,
        }
    )
    await migrate(recovery_settings, conninfo_to_dict(target.database_url.get_secret_value())["dbname"])
    secret_dir = recovery / "connection-secrets"
    private_dir(secret_dir)
    write_private(secret_dir / "connections.key", entries["secrets/connections.key"])
    if "secrets/fx-providers.key" in entries:
        provider_secret_dir = private_dir(secret_dir / "fx-providers")
        write_private(provider_secret_dir / "connections.key", entries["secrets/fx-providers.key"])
    from .backup_stream_jobs import restore_media
    await restore_media(settings, db, task, entries, recovery)
    if "secrets/bootstrap.enc" in entries:
        quarantine = private_dir(recovery / "quarantine")
        write_private(quarantine / "source-bootstrap.enc", entries["secrets/bootstrap.enc"])
    await guard(db, task)
    return {
        "scope": "backup",
        "backup_id": str(row["id"]),
        "target_id": target.id,
        "instance_id": str(target.instance_id),
        "tables_verified": len(hashes),
        "files_verified": sum(n.startswith(("files/", "assets/", "profile-media/", "resource-media/", "app-packages/")) for n in entries),
        "sessions_revoked": True,
        "connections_quarantined": True,
        "message": "已恢复到隔离目标并完成校验",
    }


def unpack(settings, row):
    from .backup_stream_codec import MAGIC, StreamFailure
    from .backup_stream_storage import existing_directory, load_archive
    try:
        root = existing_directory(settings.backup_dir)
        fd = os.open(root / (str(row["id"]) + ".enc"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            magic = source.read(len(MAGIC))
        return load_archive(settings, row) if magic == MAGIC else unpack_legacy(settings, row)
    except (StreamFailure, OSError, ValueError) as exc:
        raise BackupFailure(str(exc) if isinstance(exc, StreamFailure) else "备份存储无法安全读取") from None


async def create_backup(settings, db, task):
    from .backup_stream_jobs import create_stream_backup
    return await create_stream_backup(settings, db, task)


async def restore_backup(settings, db, task, row, manifest, entries):
    from .backup_stream_storage import LoadedBackup
    if isinstance(entries, LoadedBackup):
        from .backup_stream_jobs import restore_stream_backup
        return await restore_stream_backup(settings, db, task, row, manifest, entries, restore_legacy_backup)
    return await restore_legacy_backup(settings, db, task, row, manifest, entries)


async def run_job(settings, db, task):
    await guard(db, task)
    if task["kind"] == "backup.create":
        return await create_backup(settings, db, task)
    row = await row_for(db, UUID(task["payload"]["backup_id"]))
    manifest, entries = await asyncio.to_thread(unpack, settings, row)
    if task["kind"] == "backup.restore":
        target = target_for(settings, task["payload"]["target_id"])
        async with await psycopg.AsyncConnection.connect(
            source_dsn(db), autocommit=True, row_factory=dict_row, connect_timeout=3
        ) as lock:
            acquired = await (
                await lock.execute(
                    "SELECT pg_try_advisory_lock(hashtextextended(%s,0)) AS ok", ("restore:" + target.id,)
                )
            ).fetchone()
            if not acquired["ok"]:
                raise BackupFailure("目标已有恢复任务正在执行")
            return await restore_backup(settings, db, task, row, manifest, entries)
    from .worker import owned_row

    async with db.connection() as conn, conn.transaction():
        owned = await owned_row(conn, task)
        if not owned or owned["status"] != "running":
            raise BackupFailure("任务已取消或执行权已变化")
        await authorized_job(conn,task,settings)
        await conn.execute("UPDATE backups SET verified_at=clock_timestamp() WHERE id=%s", (row["id"],))
    return {
        "scope": "backup",
        "backup_id": str(row["id"]),
        "files_verified": len(entries),
        "message": "备份校验通过",
    }


async def validate_input(settings, db, data, who):
    if data.kind == "backup.create":
        private_dir(settings.backup_dir)
        backup_key(settings)
    else:
        from .backup_stream_storage import existing_directory
        from .backup_stream_codec import StreamFailure
        try:
            existing_directory(settings.backup_dir)
        except (OSError, ValueError, StreamFailure):
            raise BackupFailure("备份存储缺失或无法安全读取") from None
        read_backup_key(settings)
    tools(settings, "pg_dump")
    tools(settings, "pg_restore")
    if data.kind == "backup.create":
        return
    row = await row_for(db, data.backup_id)
    if data.kind == "backup.restore":
        target = target_for(settings, data.target_id)
        value = ticket_data(settings, data.restore_ticket, who.id, data.backup_id, target)
        if value["sha256"] != row["sha256"]:
            raise BackupFailure("备份与预览不符")


@router.get("/backups")
async def list_backups(request: Request, who: Admin):
    settings = request.app.state.settings
    async with request.app.state.db.connection() as conn:
        try:
            installed = await retention_installed(conn)
        except BackupFailure as exc:
            raise HTTPException(503, str(exc)) from None
        query = ("SELECT b.*,r.state AS retention_state,COALESCE(r.state NOT IN ('deleted','admitted','unknown'),true) AS download_available FROM backups b LEFT JOIN LATERAL (SELECT state FROM backup_retention_results WHERE backup_id=b.id ORDER BY created_at DESC,task_id DESC LIMIT 1) r ON true ORDER BY b.created_at DESC LIMIT 100"
                 if installed else
                 "SELECT b.*,NULL::text AS retention_state,true AS download_available FROM backups b ORDER BY b.created_at DESC LIMIT 100")
        rows = await (
            await conn.execute(query)
        ).fetchall()
    return {
        "items": rows,
        "configured": bool(
            settings.backup_dir and settings.backup_secret_dir and settings.connection_secret_dir
        ),
        "targets": [
            {"id": t.id, "name": t.name, "instance_id": t.instance_id, "environment": "test"}
            for t in settings.restore_targets
        ],
    }


@router.get("/backups/{backup_id}/restore-preview")
async def preview_restore(backup_id: UUID, target_id: str, request: Request, who: Admin):
    db = request.app.state.db
    settings = request.app.state.settings
    try:
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            await recent(conn, who)
        row = await row_for(db, backup_id)
        manifest, entries = await asyncio.to_thread(unpack, settings, row)
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            await recent(conn, who)
        target = target_for(settings, target_id)
        conn = await target_connection(target)
        await conn.close()
        recovery = Path(target.recovery_directory)
        if recovery.exists() or recovery.is_symlink():
            from .backup_stream_storage import existing_directory
            from .backup_stream_codec import StreamFailure
            try:
                directory = existing_directory(recovery)
            except (OSError, ValueError, StreamFailure):
                raise BackupFailure("恢复目录无法安全读取") from None
            if list(directory.iterdir()):
                raise BackupFailure("恢复目录非空，未执行覆盖")
        data = {
            "owner": who.id,
            "backup_id": str(backup_id),
            "sha256": row["sha256"],
            "target": target_fingerprint(target),
        }
        ticket = Fernet(read_backup_key(settings)).encrypt(canonical(data).encode()).decode()
        return {
            "restore_ticket": ticket,
            "target_id": target.id,
            "target_name": target.name,
            "instance_id": str(target.instance_id),
            "environment": "test",
            "tables": len(manifest["tables"]),
            "files": sum(n.startswith(("files/", "assets/", "profile-media/", "resource-media/", "app-packages/")) for n in entries),
            "bytes": row["bytes"],
        }
    except BackupFailure as exc:
        raise HTTPException(422, str(exc)) from None


@router.get("/backups/{backup_id}/download")
async def download(backup_id: UUID, request: Request, who: Admin):
    db = request.app.state.db
    settings = request.app.state.settings
    async with db.connection() as conn:
        await recent(conn, who)
    try:
        row = await row_for(db, backup_id)
        _manifest, _entries = await asyncio.to_thread(unpack, settings, row)
        async with db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            await recent(conn, who)
        from .backup_stream_storage import LoadedBackup
        if isinstance(_entries, LoadedBackup):
            from .resource_api import PrivateResourceResponse
            original = _entries.open_download()
            def chunks():
                while raw := original.read(1024 * 1024):
                    yield raw
            return PrivateResourceResponse(original, chunks(), media_type="application/octet-stream", headers={
                "Content-Length": str(row["bytes"]), "Content-Disposition": 'attachment; filename="alcor-' + str(backup_id) + '.enc"',
                "Content-Security-Policy": "sandbox; default-src 'none'", "Cache-Control": "no-store, private"})
        return FileResponse(
            Path(settings.backup_dir) / (str(backup_id) + ".enc"),
            filename="alcor-" + str(backup_id) + ".enc",
            media_type="application/octet-stream",
        )
    except BackupFailure as exc:
        raise HTTPException(422, str(exc)) from None
