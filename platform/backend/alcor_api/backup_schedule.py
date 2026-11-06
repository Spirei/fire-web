"""Explicit administrator backup delegation over the existing encrypted capsule queue."""

import asyncio
import hashlib
import json
import os
import stat
from datetime import timedelta
from uuid import UUID, uuid4, uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .backup_stream_codec import StreamFailure
from .backup_stream_storage import existing_directory, existing_key
from .backup_stream_storage import fingerprint as file_fingerprint
from .security import lock_mutation_identity


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, default=str, separators=(",", ":")).encode()
    ).hexdigest()


def manual_result(rid, task):
    return {"requestId": str(rid), "state": task["status"], "taskId": str(task["id"]),
            "ok": task["status"] == "succeeded",
            "pending": task["status"] in {"queued", "running", "cancel_requested"},
            "result": task["result"]}


def storage(settings):
    from .backups import BackupFailure, tools

    try:
        tools(settings, "pg_dump")
        tools(settings, "pg_restore")
    except BackupFailure as exc:
        raise ValueError("backup_tools_unavailable") from exc
    root = existing_directory(settings.backup_dir)
    info = root.stat()
    key = existing_key(settings)
    return {
        "pathDigest": hashlib.sha256(str(root.absolute()).encode()).hexdigest(),
        "device": info.st_dev,
        "inode": info.st_ino,
        "owner": info.st_uid,
        "mode": stat.S_IMODE(info.st_mode),
    }, hashlib.sha256(key).hexdigest()


async def current(conn):
    return await (
        await conn.execute("SELECT * FROM backup_schedule_versions ORDER BY revision DESC LIMIT 1")
    ).fetchone()


async def authorization(conn, admission, settings, *, manual=False):
    try:
        if str(admission["origin_instance"]) != str(settings.instance_id):
            return False
        instance = await (
            await conn.execute("SELECT instance_id FROM alcor_instance WHERE singleton")
        ).fetchone()
        if not instance or str(instance["instance_id"]) != str(settings.instance_id):
            return False
        if await (await conn.execute("SELECT 1 FROM restore_quarantine LIMIT 1")).fetchone():
            return False
        user = await (
            await conn.execute(
                "SELECT 1 FROM users WHERE id=%s AND active AND deleted_at IS NULL AND role='admin' AND session_version=%s FOR SHARE",
                (admission["actor_id"], admission["session_version"]),
            )
        ).fetchone()
        if not user:
            return False
        if manual:
            valid = await (
                await conn.execute(
                    "SELECT 1 FROM sessions WHERE user_id=%s AND token_hash=%s AND session_version=%s AND expires_at>clock_timestamp() AND %s>clock_timestamp()-interval '15 minutes'",
                    (
                        admission["actor_id"],
                        admission["session_hash"],
                        admission["session_version"],
                        admission["created_at"],
                    ),
                )
            ).fetchone()
            if not valid:
                return False
        else:
            config = await current(conn)
            if (
                not config
                or not config["enabled"]
                or config["revision"] != admission["config_revision"]
                or config["actor_id"] != admission["actor_id"]
            ):
                return False
        identity, key = await asyncio.to_thread(storage, settings)
        return identity == admission["storage_identity"] and key == admission["key_fingerprint"]
    except (OSError, ValueError, TypeError, StreamFailure):
        return False


async def authorize_scheduled_job(conn,task,settings):
    if task.get("kind")!="backup.create" or "_backup_schedule_revision" not in task.get("payload",{}):
        return False
    row = await (
        await conn.execute(
            "SELECT * FROM backup_schedule_admissions WHERE task_id=%s AND actor_id=%s",
            (task["id"], task["owner_id"]),
        )
    ).fetchone()
    if (
        not row
        or str(row["request_id"]) != str(task["request_id"])
        or row["kind"] == "retention"
        or task["kind"] != "backup.create"
    ):
        return False
    return await authorization(conn, row, settings, manual=row["kind"] == "manual")


class BackupSchedule:
    def __init__(self, db):
        self.db = db

    async def lock(self, conn, who):
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await lock_mutation_identity(conn,who,require_admin=True)
        web=await(await conn.execute("SELECT 1 FROM sessions WHERE user_id=%s AND token_hash=%s AND client_id=ANY(%s) AND expires_at>clock_timestamp()",(who.id,who.token_hash,['new-web','legacy-web']))).fetchone()
        if not web:raise HTTPException(403,"备份管理须当前管理员Web会话")
        await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('backup-schedule',0))")

    async def prerequisites(self, conn, config):
        result = {
            "storageReady": False,
            "keyReady": False,
            "toolsReady": False,
            "authorizationValid": False,
            "instanceMatches": True,
            "restoreQuarantined": False,
        }
        try:
            await asyncio.to_thread(existing_directory, self.db.settings.backup_dir)
            result["storageReady"] = True
            await asyncio.to_thread(existing_key, self.db.settings)
            result["keyReady"] = True
        except (OSError, ValueError, TypeError, StreamFailure):
            pass
        try:
            from .backups import BackupFailure, tools

            tools(self.db.settings, "pg_dump")
            tools(self.db.settings, "pg_restore")
            result["toolsReady"] = True
        except BackupFailure:
            result["toolsReady"] = False
        result["restoreQuarantined"] = bool(
            await (await conn.execute("SELECT 1 FROM restore_quarantine LIMIT 1")).fetchone()
        )
        if config:
            result["instanceMatches"] = str(config["origin_instance"]) == str(self.db.settings.instance_id)
            subject = {**config, "config_revision": config["revision"]}
            result["authorizationValid"] = await authorization(conn, subject, self.db.settings)
        return result

    async def read_on_connection(self, conn):
        config = await current(conn)
        revision = (
            await (
                await conn.execute("SELECT revision FROM backup_schedule_scope WHERE singleton")
            ).fetchone()
        )["revision"]
        requirements = await self.prerequisites(conn, config)
        latest = await (
            await conn.execute(
                "SELECT t.id,t.status,t.error_code,t.created_at,t.finished_at,a.kind FROM backup_schedule_admissions a JOIN tasks t ON t.id=a.task_id ORDER BY a.created_at DESC LIMIT 1"
            )
        ).fetchone()
        next_at = None
        if config and config["enabled"]:
            last = await (
                await conn.execute(
                    "SELECT t.finished_at FROM backup_schedule_admissions a JOIN tasks t ON t.id=a.task_id WHERE a.config_revision=%s AND a.kind='scheduled' AND t.status='succeeded' ORDER BY a.created_at DESC LIMIT 1",
                    (config["revision"],),
                )
            ).fetchone()
            next_at = (
                (last["finished_at"] if last and last["finished_at"] else config["created_at"])
                + timedelta(hours=config["interval_hours"])
            ).isoformat()
        return {
            "revision": revision,
            "config": {
                "enabled": config["enabled"] if config else False,
                "intervalHours": config["interval_hours"] if config else 24,
                "keep": config["keep"] if config else 10,
            },
            "state": "disabled"
            if not config or not config["enabled"]
            else "enabled"
            if requirements["authorizationValid"]
            else "blocked",
            "prerequisites": requirements,
            "nextRunAt": next_at,
            "lastTask": {
                **latest,
                "id": str(latest["id"]),
                "created_at": latest["created_at"].isoformat(),
                "finished_at": latest["finished_at"].isoformat() if latest["finished_at"] else None,
            }
            if latest
            else None,
            "retention": {
                "state": "registered_verified_capsules_only",
                "scope": "same_admin_and_source_instance",
                "unknownFilesScanned": False,
                "historyAndReceiptsRetained": True,
            },
        }

    async def read(self, who):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            return await self.read_on_connection(conn)

    async def save(self, who, raw, *, legacy=False):
        try:
            rid = UUID(str(raw["requestId"]))
            enabled = raw["enabled"]
            interval = raw["intervalHours"]
            keep = raw["keep"]
            if (
                type(enabled) is not bool
                or type(interval) not in (int, float)
                or type(keep) not in (int, float)
                or not 1 <= interval <= 8760
                or not 1 <= keep <= 90
            ):
                raise ValueError()
            interval = int(interval + 0.5)
            keep = int(keep + 0.5)
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(400, "备份配置无效") from exc
        command = {k: v for k, v in raw.items() if k not in {"password", "code"}}
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            prior = await (
                await conn.execute(
                    "SELECT * FROM backup_schedule_operations WHERE actor_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone()
            if prior:
                if prior["request_hash"] != digest(command):
                    raise HTTPException(409, "原UUID用于不同计划操作")
                return prior["result"]
            revision = (
                await (
                    await conn.execute(
                        "SELECT revision FROM backup_schedule_scope WHERE singleton FOR UPDATE"
                    )
                ).fetchone()
            )["revision"]
            if await (
                await conn.execute(
                    "SELECT 1 FROM backup_schedule_admissions WHERE actor_id=%s AND request_id=%s",
                    (who.id, rid),
                )
            ).fetchone():
                raise HTTPException(409, "原UUID已用于备份任务")
            if raw.get("expectedRevision", revision if legacy else None) != revision:
                raise HTTPException(409, "备份计划已变化，请重新读取")
            if enabled and not raw.get("password"):
                raise HTTPException(428, "启用或修改自动备份请核对当前管理员密码与安全因子")
            if raw.get("password"):
                from .notification_security import NotificationSecurity

                try:
                    await NotificationSecurity(self.db).passkeys.step_up(
                        conn, who, raw["password"], raw.get("code") or ""
                    )
                except HTTPException as exc:
                    if exc.status_code == 403 and exc.detail in {
                        "当前密码不正确",
                        "二次验证码或备用码不正确",
                    }:
                        raise HTTPException(
                            403, exc.detail, headers={"X-Alcor-Proof-Rejected": "true"}
                        ) from exc
                    raise
            identity, key = {}, ""
            if enabled:
                if await (await conn.execute("SELECT 1 FROM restore_quarantine LIMIT 1")).fetchone():
                    raise HTTPException(409, "恢复实例的备份委托尚未重新授权")
                try:
                    identity, key = await asyncio.to_thread(storage, self.db.settings)
                except (OSError, ValueError, TypeError, StreamFailure) as exc:
                    raise HTTPException(409, "请先核对现有私有备份存储与密钥") from exc
            user = await (
                await conn.execute("SELECT session_version FROM users WHERE id=%s", (who.id,))
            ).fetchone()
            await conn.execute(
                "INSERT INTO backup_schedule_versions(revision,actor_id,request_id,enabled,interval_hours,keep,origin_instance,session_version,storage_identity,key_fingerprint) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    revision + 1,
                    who.id,
                    rid,
                    enabled,
                    interval,
                    keep,
                    self.db.settings.instance_id,
                    user["session_version"],
                    Jsonb(identity),
                    key,
                ),
            )
            await conn.execute("UPDATE backup_schedule_scope SET revision=revision+1 WHERE singleton")
            snapshot = await self.read_on_connection(conn)
            result = {
                **snapshot,
                "requestId": str(rid),
                "state": "completed",
                "scheduleState": snapshot["state"],
                "delegation": "explicit_admin_until_disabled_role_password_or_instance_change",
                "automaticBackupCreated": False,
            }
            await conn.execute(
                "INSERT INTO backup_schedule_operations(actor_id,request_id,request_hash,result) VALUES(%s,%s,%s,%s)",
                (who.id, rid, digest(command), Jsonb(result)),
            )
            return result

    async def enqueue(self, conn, who, rid, config, kind, *, backup_id=None):
        identity, key = await asyncio.to_thread(storage, self.db.settings)
        task_id = uuid4()
        task_kind = "backup.retention" if kind == "retention" else "backup.create"
        payload = {
            "_session_hash": getattr(who, "token_hash", ""),
            "_backup_schedule_revision": config["revision"],
            "backup_id": str(backup_id) if backup_id else None,
        }
        fp = digest(
            {
                "kind": kind,
                "configRevision": config["revision"],
                "backupId": str(backup_id) if backup_id else None,
            }
        )
        prior = await (
            await conn.execute("SELECT * FROM tasks WHERE owner_id=%s AND request_id=%s", (who.id, rid))
        ).fetchone()
        if prior:
            if prior["fingerprint"] != fp:
                raise HTTPException(409, "原UUID用于不同备份任务")
            return prior
        count = await (
            await conn.execute(
                "SELECT count(*) AS n FROM tasks WHERE owner_id=%s AND status IN ('queued','running','cancel_requested')",
                (who.id,),
            )
        ).fetchone()
        if count["n"] >= 100:
            raise HTTPException(429, "待执行任务过多")
        row = await (
            await conn.execute(
                "INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,%s,%s,'queued',%s) RETURNING *",
                (task_id, who.id, rid, fp, task_kind, Jsonb(payload)),
            )
        ).fetchone()
        await conn.execute(
            "INSERT INTO backup_schedule_admissions(task_id,request_id,actor_id,config_revision,kind,origin_instance,session_version,session_hash,storage_identity,key_fingerprint,backup_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                task_id,
                rid,
                who.id,
                config["revision"],
                kind,
                self.db.settings.instance_id,
                config["session_version"],
                getattr(who, "token_hash", None),
                Jsonb(identity),
                key,
                backup_id,
            ),
        )
        await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'queued')", (task_id,))
        return row

    async def create(self, who, rid):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            if await (await conn.execute("SELECT 1 FROM restore_quarantine LIMIT 1")).fetchone():
                raise HTTPException(409, "恢复实例备份尚未重新授权")
            # The original request is bound to its admitted policy/storage,
            # never to a later schedule revision or currently mounted directory.
            prior = await (await conn.execute(
                "SELECT t.*,a.kind AS admission_kind FROM backup_schedule_admissions a JOIN tasks t ON t.id=a.task_id "
                "WHERE a.actor_id=%s AND a.request_id=%s AND t.owner_id=a.actor_id AND t.request_id=a.request_id",
                (who.id, UUID(str(rid))),
            )).fetchone()
            if prior:
                if prior["admission_kind"] != "manual" or prior["kind"] != "backup.create":
                    raise HTTPException(409, "原UUID用于不同备份任务")
                return manual_result(rid, prior)
            user = await (
                await conn.execute("SELECT session_version FROM users WHERE id=%s", (who.id,))
            ).fetchone()
            revision = (
                await (
                    await conn.execute("SELECT revision FROM backup_schedule_scope WHERE singleton")
                ).fetchone()
            )["revision"]
            if await (
                await conn.execute(
                    "SELECT 1 FROM backup_schedule_operations WHERE actor_id=%s AND request_id=%s",
                    (who.id, UUID(str(rid))),
                )
            ).fetchone():
                raise HTTPException(409, "原UUID已用于备份设置")
            try:
                task = await self.enqueue(
                    conn, who, UUID(str(rid)),
                    {"revision": revision, "session_version": user["session_version"]}, "manual",
                )
            except (OSError, ValueError, TypeError, StreamFailure) as exc:
                raise HTTPException(409, "请先核对现有私有备份存储与密钥") from exc
            return manual_result(rid, task)

    async def receipt(self, who, rid):
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn, who)
            result = await (
                await conn.execute(
                    "SELECT result FROM backup_schedule_operations WHERE actor_id=%s AND request_id=%s",
                    (who.id, UUID(str(rid))),
                )
            ).fetchone()
            if result:
                return result["result"]
            task = await (
                await conn.execute(
                    "SELECT t.* FROM tasks t JOIN backup_schedule_admissions a ON a.task_id=t.id WHERE a.actor_id=%s AND a.request_id=%s",
                    (who.id, UUID(str(rid))),
                )
            ).fetchone()
            if not task:
                raise HTTPException(404, "备份原请求不存在")
            return {
                "requestId": str(rid),
                "taskId": str(task["id"]),
                "state": task["status"],
                "result": task["result"],
                "errorCode": task["error_code"],
                "willRetryAutomatically": False,
            }

    async def schedule_tick(self):
        from types import SimpleNamespace

        async with self.db.connection() as conn, conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('backup-schedule',0))")
            config = await current(conn)
            if not config or not config["enabled"]:
                return 0
            if not await authorization(
                conn, {**config, "config_revision": config["revision"]}, self.db.settings
            ):
                return 0
            latest = await (
                await conn.execute(
                    "SELECT t.*,a.created_at AS admitted_at FROM backup_schedule_admissions a JOIN tasks t ON t.id=a.task_id WHERE a.config_revision=%s AND a.kind='scheduled' ORDER BY a.created_at DESC LIMIT 1",
                    (config["revision"],),
                )
            ).fetchone()
            if latest and latest["status"] != "succeeded":
                return 0
            now = (await (await conn.execute("SELECT clock_timestamp() AS at")).fetchone())["at"]
            anchor = latest["finished_at"] if latest else config["created_at"]
            if now < anchor + timedelta(hours=config["interval_hours"]):
                return await self.enqueue_retention(conn, config)
            rid = uuid5(config["request_id"], "backup-after:" + str(latest["id"] if latest else "enabled"))
            await self.enqueue(
                conn, SimpleNamespace(id=config["actor_id"], token_hash=None), rid, config, "scheduled"
            )
            return 1

    async def enqueue_retention(self, conn, config):
        from types import SimpleNamespace

        candidates = await (
            await conn.execute(
                "SELECT b.* FROM backups b JOIN tasks t ON t.id=b.id WHERE b.source_instance=%s AND b.owner_id=%s AND b.verified_at IS NOT NULL AND t.status='succeeded' AND NOT EXISTS(SELECT 1 FROM tasks active WHERE active.kind IN ('backup.verify','backup.restore') AND active.status IN ('queued','running','cancel_requested') AND active.payload->>'backup_id'=b.id::text) AND NOT EXISTS(SELECT 1 FROM backup_retention_results r WHERE r.backup_id=b.id) ORDER BY b.created_at DESC,b.id DESC OFFSET %s LIMIT 1",
                (self.db.settings.instance_id, config["actor_id"], config["keep"]),
            )
        ).fetchone()
        if not candidates:
            return 0
        rid = uuid5(config["request_id"], "retention:" + str(candidates["id"]))
        await self.enqueue(
            conn,
            SimpleNamespace(id=config["actor_id"], token_hash=None),
            rid,
            config,
            "retention",
            backup_id=candidates["id"],
        )
        return 1

    async def retention_start(self, task):
        from .worker import owned_row

        async with self.db.connection() as conn, conn.transaction():
            owned = await owned_row(conn, task)
            admission = await (
                await conn.execute(
                    "SELECT * FROM backup_schedule_admissions WHERE task_id=%s AND kind='retention'",
                    (task["id"],),
                )
            ).fetchone()
            if (
                not owned
                or owned["status"] != "running"
                or not admission
                or not await authorization(conn, admission, self.db.settings)
            ):
                return None, None, {"state": "unavailable", "reason": "retention_authorization_changed"}
            prior = await (
                await conn.execute("SELECT * FROM backup_retention_results WHERE task_id=%s", (task["id"],))
            ).fetchone()
            if prior:
                return (
                    None,
                    None,
                    prior["result"]
                    or {
                        "state": "unknown",
                        "reason": "retention_admission_outcome_unconfirmed",
                        "willRetryAutomatically": False,
                    },
                )
            row = await (
                await conn.execute(
                    "SELECT * FROM backups WHERE id=%s AND owner_id=%s AND source_instance=%s AND verified_at IS NOT NULL",
                    (admission["backup_id"], admission["actor_id"], self.db.settings.instance_id),
                )
            ).fetchone()
            if not row:
                return None, None, {"state": "unavailable", "reason": "registered_verified_backup_missing"}
            await conn.execute(
                "INSERT INTO backup_retention_results(task_id,backup_id,state) VALUES(%s,%s,'admitted')",
                (task["id"], row["id"]),
            )
            return admission, row, None

    async def execute_retention(self, task):
        from .backups import BackupFailure, unpack
        from .feed_worker import FeedWorker
        from .worker import finish, owned_row

        admission, row, early = await self.retention_start(task)
        if early:
            return await finish(
                self.db,
                task,
                early,
                error_code=None if early["state"] == "deleted" else "backup_retention_" + early["state"],
            )
        result = {
            "state": "unknown",
            "backupId": str(row["id"]),
            "willRetryAutomatically": False,
            "metadataAndReceiptsRetained": True,
        }

        def verify():
            root = existing_directory(self.db.settings.backup_dir)
            path = root / (str(row["id"]) + ".enc")
            before = path.lstat()
            if (
                not stat.S_ISREG(before.st_mode)
                or before.st_nlink != 1
                or before.st_uid != os.getuid()
                or before.st_mode & 0o077
                or before.st_size != row["bytes"]
            ):
                raise ValueError("backup_identity_changed")
            manifest, _entries = unpack(self.db.settings, row)
            if file_fingerprint(before) != file_fingerprint(path.lstat()):
                raise ValueError("backup_identity_changed")
            return file_fingerprint(before), digest(manifest)

        try:
            expected, manifest_sha = await FeedWorker(self.db).pulse(task, lambda: asyncio.to_thread(verify))
            async with self.db.connection() as conn, conn.transaction():
                await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('backup-schedule',0))")
                owned = await owned_row(conn, task)
                if (
                    not owned
                    or owned["status"] != "running"
                    or not await authorization(conn, admission, self.db.settings)
                ):
                    raise ValueError("retention_authorization_changed")
                config = await current(conn)
                expired = await (
                    await conn.execute(
                        "SELECT b.id FROM backups b JOIN tasks t ON t.id=b.id WHERE b.source_instance=%s AND b.owner_id=%s AND b.verified_at IS NOT NULL AND t.status='succeeded' AND NOT EXISTS(SELECT 1 FROM tasks active WHERE active.kind IN ('backup.verify','backup.restore') AND active.status IN ('queued','running','cancel_requested') AND active.payload->>'backup_id'=b.id::text) AND NOT EXISTS(SELECT 1 FROM backup_retention_results r WHERE r.backup_id=b.id AND r.state='deleted') ORDER BY b.created_at DESC,b.id DESC OFFSET %s",
                        (self.db.settings.instance_id, admission["actor_id"], config["keep"]),
                    )
                ).fetchall()
                if row["id"] not in {v["id"] for v in expired}:
                    raise ValueError("retention_keep_scope_changed")
                await conn.execute(
                    "UPDATE backup_retention_results SET file_identity=%s WHERE task_id=%s",
                    (Jsonb(list(expected)), task["id"]),
                )

                def remove():
                    identity, key = storage(self.db.settings)
                    if identity != admission["storage_identity"] or key != admission["key_fingerprint"]:
                        raise ValueError("retention_storage_changed")
                    root = existing_directory(self.db.settings.backup_dir)
                    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    try:
                        info = os.fstat(descriptor)
                        if (info.st_dev, info.st_ino) != (identity["device"], identity["inode"]):
                            raise ValueError("retention_directory_changed")
                        name = str(row["id"]) + ".enc"
                        handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
                        try:
                            opened = os.fstat(handle)
                            linked = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                            if (
                                file_fingerprint(opened) != tuple(expected)
                                or file_fingerprint(linked) != tuple(expected)
                                or not stat.S_ISREG(opened.st_mode)
                                or opened.st_nlink != 1
                                or opened.st_uid != os.getuid()
                                or opened.st_mode & 0o077
                            ):
                                raise ValueError("retention_file_changed")
                            os.unlink(name, dir_fd=descriptor)
                            os.fsync(descriptor)
                        finally:
                            os.close(handle)
                    finally:
                        os.close(descriptor)

                await asyncio.to_thread(remove)
                result.update(state="deleted", verifiedManifestSha256=manifest_sha, deletedBytes=row["bytes"])
                await conn.execute(
                    "UPDATE backup_retention_results SET state='deleted',result=%s,finished_at=clock_timestamp() WHERE task_id=%s",
                    (Jsonb(result), task["id"]),
                )
        except (BackupFailure, OSError, ValueError, TypeError, RuntimeError):
            result["reason"] = "retention_identity_verification_or_outcome_unconfirmed"
            async with self.db.connection() as conn, conn.transaction():
                await conn.execute(
                    "UPDATE backup_retention_results SET state='unknown',result=%s,finished_at=clock_timestamp() WHERE task_id=%s AND state='admitted'",
                    (Jsonb(result), task["id"]),
                )
        return await finish(
            self.db,
            task,
            result,
            error_code=None if result["state"] == "deleted" else "backup_retention_unknown",
        )
