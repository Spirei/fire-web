"""Versioned infrastructure settings, private credentials and bounded connection checks."""

import asyncio
import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
import socket
import stat
import tempfile
from dataclasses import dataclass, field
from datetime import timedelta
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit
from uuid import UUID, uuid4

import psycopg
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import SecretStr
from redis.asyncio import ConnectionPool, Redis
from redis.asyncio.connection import SSLConnection
from redis.backoff import NoBackoff
from redis.asyncio.retry import Retry

from .connection_models import PostgresConfig, RedisConfig
from .connection_errors import connection_failure_message
from .db import TargetMismatch, verify_identity
from .security import lock_mutation_identity


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


class Vault:
    def __init__(self, directory, namespace="connections", *, read_only=False):
        self.directory = directory
        self.read_only = read_only
        if namespace not in {"connections", "backup"}:
            raise ValueError("Invalid key namespace")
        self.namespace = namespace

    def key(self):
        if self.directory is None:
            raise HTTPException(503, "凭据存储尚未配置")
        directory = Path(self.directory)
        if not self.read_only:
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directory.is_symlink() or directory.stat().st_mode & 0o077:
            raise HTTPException(503, "凭据目录权限不正确")
        if self.read_only:
            return self._read_key(directory / (self.namespace + ".key"))
        flags = os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW
        fd = os.open(directory / (self.namespace + ".lock"), flags, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            path = directory / (self.namespace + ".key")
            if not path.exists():
                keyfd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(keyfd, "wb") as file:
                    file.write(Fernet.generate_key())
                    file.flush()
                    os.fsync(file.fileno())
            return self._read_key(path)
        except (OSError, ValueError):
            raise HTTPException(503, "凭据存储不可用") from None
        finally:
            os.close(fd)

    def _read_key(self, path):
        keyfd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(keyfd, "rb") as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                raise HTTPException(503, "凭据文件权限不正确")
            key = file.read(128)
            Fernet(key)
            return key

    def encrypt(self, value, kind, instance):
        if not value:
            return None
        payload = canonical({"kind": kind, "instance": str(instance), "password": value})
        return Fernet(self.key()).encrypt(payload.encode()).decode()

    def decrypt(self, value, kind, instance):
        if not value:
            return ""
        try:
            payload = json.loads(Fernet(self.key()).decrypt(value.encode()))
            if payload["kind"] != kind or payload["instance"] != str(instance):
                raise ValueError()
            return payload["password"]
        except (InvalidToken, ValueError, KeyError):
            raise HTTPException(503, "已保存凭据无法读取") from None

    def bootstrap_path(self, instance):
        return Path(self.directory) / ("bootstrap-" + str(instance) + ".enc")

    def write_bootstrap(self, config, password, address, revision, instance):
        if self.read_only:
            raise HTTPException(503, "只读检查不能写入启动配置")
        payload = canonical(
            {
                "config": config.model_dump(),
                "password": password,
                "address": address,
                "revision": str(revision),
            }
        )
        value = self.encrypt(payload, "bootstrap", instance)
        path = self.bootstrap_path(instance)
        fd, temporary = tempfile.mkstemp(prefix=".bootstrap-", dir=self.directory)
        try:
            with os.fdopen(fd, "w") as file:
                file.write(value)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)
            directory = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def postgres_settings(base, config, password, address):
    values = dict(
        host=config.host,
        port=config.port,
        dbname=config.database,
        user=config.username,
        password=password,
        sslmode=config.ssl_mode,
    )
    if not config.host.startswith("/"):
        values["hostaddr"] = str(ipaddress.ip_address(address))
    return base.model_copy(
        update={
            "database_url": SecretStr(make_conninfo(**values)),
            "pool_size": config.pool_size,
            "pool_min_size": config.pool_min_size,
            "pool_max_lifetime": config.max_lifetime,
            "pool_max_idle": config.max_idle,
            "connect_timeout": config.connect_timeout,
        }
    )


def bootstrap_settings(base, *, read_only=False):
    if base.connections_from_environment:
        return base, None
    if not base.connection_secret_dir:
        return base, None
    vault = Vault(base.connection_secret_dir, read_only=read_only)
    path = vault.bootstrap_path(base.instance_id)
    if not path.exists():
        return base, None
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "r") as file:
        info = os.fstat(file.fileno())
        if info.st_mode & 0o077 or info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode):
            raise HTTPException(503, "启动配置文件权限不正确")
        value = file.read(65536)
    try:
        payload = json.loads(vault.decrypt(value, "bootstrap", base.instance_id))
        config = PostgresConfig(**payload["config"])
        allowed = list(base.connection_targets)
        original, _ = current_config(base, "postgresql")
        allowed.append(
            {
                "kind": "postgresql",
                "host": original.host,
                "port": original.port,
                "database": original.database,
            }
        )
        if config.host.startswith("/") and not any(
            (r.get("kind"), r.get("host"), r.get("port"), r.get("database")) == endpoint(config)
            for r in allowed
        ):
            raise ValueError("Unconfigured startup socket")
        if not config.host.startswith("/"):
            address = ipaddress.ip_address(payload["address"])
            address = getattr(address, "ipv4_mapped", None) or address
            if address.is_unspecified or address.is_multicast or address.is_link_local:
                raise ValueError("Invalid startup address")
        return postgres_settings(base, config, payload["password"], payload["address"]), UUID(
            payload["revision"]
        )
    except (ValueError, KeyError):
        raise HTTPException(503, "已保存启动配置无法读取") from None


def current_config(settings, kind):
    if kind == "postgresql":
        info = conninfo_to_dict(settings.database_url.get_secret_value()) if settings.database_url else {}
        config = PostgresConfig(
            host=info.get("host") or "127.0.0.1",
            port=int(info.get("port", 5432)),
            username=info.get("user", ""),
            database=info.get("dbname", "alcor_platform"),
            ssl_mode=info.get("sslmode", "disable")
            if info.get("sslmode", "disable") in {"disable", "require", "verify-ca", "verify-full"}
            else "require",
            pool_size=settings.pool_size,
            pool_min_size=settings.pool_min_size,
            max_lifetime=settings.pool_max_lifetime,
            max_idle=settings.pool_max_idle,
            connect_timeout=settings.connect_timeout,
        )
        return config, info.get("password", "")
    info = urlsplit(settings.redis_url.get_secret_value()) if settings.redis_url else None
    unix = info and info.scheme == "unix"
    config = RedisConfig(
        host=unquote(info.path) if unix else (info.hostname if info else None) or "127.0.0.1",
        port=info.port if info and info.port else 6379,
        username=unquote(info.username or "") if info else "",
        database=int(
            (info.query.split("db=")[-1].split("&")[0] if "db=" in info.query else "0")
            if unix
            else (info.path.lstrip("/") or "0")
            if info
            else "0"
        ),
        tls=bool(info and info.scheme == "rediss"),
    )
    return config, unquote(info.password or "") if info else ""


def config_model(value):
    return PostgresConfig(**value) if value["kind"] == "postgresql" else RedisConfig(**value)


def endpoint(config):
    return (config.kind, config.host, config.port, config.database)


class CheckedAddress(str):
    def __new__(cls, value, version):
        instance = super().__new__(cls, value)
        instance.postgres_version = version
        return instance


@dataclass(frozen=True, repr=False)
class ConnectionPreparation:
    service: object
    owner: str
    principal: str
    instance: UUID
    fingerprint: str
    expires_at: datetime
    password: str = field(default="", repr=False)
    address: object = None
    status: str = "unknown"
    message: str = "连接结果未核对"
    existing: dict | None = None
    admission_id: UUID | None = None
    factor_stamp: str | None = None


class PinnedSSLConnection(SSLConnection):
    def __init__(self, *args, server_name=None, **kwargs):
        self.server_name = server_name
        super().__init__(*args, **kwargs)

    def _connection_arguments(self):
        values = dict(super()._connection_arguments())
        values["server_hostname"] = self.server_name
        return values


def redis_client(config, password, address):
    values = dict(
        db=config.database,
        username=config.username or None,
        password=password or None,
        socket_connect_timeout=config.connect_timeout,
        socket_timeout=config.connect_timeout,
        max_connections=config.max_connections,
        retry=Retry(NoBackoff(), 0),
    )
    if config.host.startswith("/"):
        return Redis(unix_socket_path=config.host, **values)
    if config.tls:
        return Redis(
            connection_pool=ConnectionPool(
                connection_class=PinnedSSLConnection,
                host=address,
                port=config.port,
                server_name=config.host,
                ssl_cert_reqs="required",
                ssl_check_hostname=True,
                **values,
            )
        )
    return Redis(host=address, port=config.port, **values)


class CacheHandle:
    def __init__(self, settings):
        self.client = (
            Redis.from_url(settings.redis_url.get_secret_value(), socket_connect_timeout=1, socket_timeout=1)
            if settings.redis_url
            else None
        )

    def __bool__(self):
        return self.client is not None

    async def ping(self):
        if self.client is None:
            raise RuntimeError("Cache is not configured")
        return await self.client.ping()

    async def replace(self, client):
        try:
            await client.ping()
        except BaseException:
            await client.aclose()
            raise
        old, self.client = self.client, client
        if old:
            await old.aclose()

    async def aclose(self):
        if self.client:
            await self.client.aclose()


class Connections:
    def __init__(self, settings, db, cache, role="api"):
        self.base, self.db, self.cache, self.role = settings, db, cache, role
        self.vault = Vault(settings.connection_secret_dir)
        self.process_id = uuid4()
        self.applied = {}
        self.effective = {kind: current_config(settings, kind)[0] for kind in ("postgresql", "redis")}
        self.pins = {}
        self.apply_lock = asyncio.Lock()

    async def verify_bootstrap(self, revision):
        if revision is None:
            return
        async with self.db.connection() as conn:
            row = await self.row(conn, "postgresql")
            if not row or row["revision"] != revision:
                previous = await (
                    await conn.execute(
                        "SELECT EXISTS(SELECT 1 FROM connection_receipts WHERE kind='postgresql' AND operation='save' AND result->>'revision'=%s) AS ok",
                        (str(revision),),
                    )
                ).fetchone()
                if not row or not previous["ok"]:
                    raise HTTPException(503, "启动配置与数据库版本不符")

    async def address(self, config):
        # Access is authorized by operate(): recent administrator session and CSRF.
        # Keep local sockets and server-local destinations limited to operator configuration.
        rules = list(self.base.connection_targets)
        for kind, configured in [("postgresql", self.base.database_url), ("redis", self.base.redis_url)]:
            if configured:
                active, _ = current_config(self.base, kind)
                rules.append(dict(zip(("kind", "host", "port", "database"), endpoint(active))))
        trusted = any(
            (r.get("kind"), r.get("host"), r.get("port"), r.get("database")) == endpoint(config)
            for r in rules
        )
        if config.host.startswith("/"):
            if not trusted:
                raise HTTPException(422, "本地套接字仅允许使用服务端已配置目标，未发起连接")
            return config.host
        try:
            ips = [ipaddress.ip_address(config.host)]
        except ValueError:
            try:
                rows = await asyncio.wait_for(
                    asyncio.get_running_loop().getaddrinfo(config.host, config.port, type=socket.SOCK_STREAM),
                    2,
                )
                ips = [ipaddress.ip_address(row[4][0]) for row in rows]
            except (OSError, TimeoutError):
                raise HTTPException(422, "目标域名解析失败，未发起连接") from None
        for address in ips:
            ip = getattr(address, "ipv4_mapped", None) or address
            if ip.is_unspecified or ip.is_multicast or ip.is_link_local or (ip.is_loopback and not trusted):
                raise HTTPException(422, "此地址不能作为连接目标，未发起连接")
        if not ips:
            raise HTTPException(422, "目标域名没有可用地址，未发起连接")
        # Connect using the validated numeric address to avoid a second DNS resolution.
        return str(ips[0])

    async def row(self, conn, kind):
        if self.base.connections_from_environment:
            return None
        return await (
            await conn.execute("SELECT * FROM connection_settings WHERE kind=%s", (kind,))
        ).fetchone()

    def values(self, row, kind):
        if self.base.connections_from_environment:
            return current_config(self.base, kind)
        if row:
            return config_model(row["config"]), self.vault.decrypt(
                row["password_ciphertext"], kind, self.base.instance_id
            )
        return current_config(self.base, kind)

    def resolved_password(self, data, row):
        if self.base.connections_from_environment:
            return current_config(self.base, data.config.kind)[1]
        old, password = (
            self.values(row, data.config.kind)
            if row or getattr(data, "reuse_current_password", False)
            else (None, "")
        )
        if data.password_mode == "clear":
            return ""
        if data.password_mode == "replace":
            return data.password.get_secret_value()
        if (
            old
            and password
            and (endpoint(old) != endpoint(data.config) or old.username != data.config.username)
        ):
            raise HTTPException(422, "连接目标或账号已变化，请重新输入密码")
        return password

    async def read(self, kind):
        if self.base.connections_from_environment:
            configured = bool(self.base.database_url if kind == "postgresql" else self.base.redis_url)
            config, password = current_config(self.base, kind) if configured else (None, "")
            return {
                "source": "environment",
                "config": None,
                "effective": config,
                "password_set": bool(password),
                "revision": None,
                "saved_at": None,
                "state": "applied" if configured else "unconfigured",
                "worker_applied": False,
            }
        async with self.db.connection() as conn:
            row = await self.row(conn, kind)
            config, password = self.values(row, kind) if row else (None, "")
            worker = False
            if row:
                worker = (
                    await (
                        await conn.execute(
                            "SELECT EXISTS(SELECT 1 FROM connection_applied WHERE kind=%s AND role='worker' AND revision=%s AND observed_at>clock_timestamp()-interval '30 seconds') AS ok",
                            (kind, row["revision"]),
                        )
                    ).fetchone()
                )["ok"]
        return {
            "config": config,
            "effective": self.effective[kind] if row and kind in self.applied else None,
            "password_set": bool(password),
            "revision": row["revision"] if row else None,
            "saved_at": row["updated_at"] if row else None,
            "state": ("applied" if self.applied.get(kind) == row["revision"] else "pending")
            if row
            else "unconfigured",
            "worker_applied": worker,
        }

    async def check(self, config, password, probe, require_current=False):
        address = await self.address(config)
        if config.kind == "redis":
            client = redis_client(config, password, address)
            try:
                await client.ping()
            finally:
                await client.aclose()
            return
        params = dict(
            host=config.host,
            port=config.port,
            dbname=config.database,
            user=config.username,
            password=password,
            sslmode=config.ssl_mode,
            connect_timeout=config.connect_timeout,
        )
        if not config.host.startswith("/"):
            params["hostaddr"] = address
        async with await psycopg.AsyncConnection.connect(
            **params,
            autocommit=True,
            row_factory=dict_row,
            options="-c default_transaction_read_only=on -c statement_timeout=2000 -c lock_timeout=1000",
        ) as conn:
            observed_version = (await (await conn.execute("SELECT version() AS version")).fetchone())[
                "version"
            ]
            if require_current:
                try:
                    await verify_identity(conn, self.base)
                except TargetMismatch:
                    raise HTTPException(422, "目标不是当前平台数据库，未应用设置") from None
                marker = await (
                    await conn.execute(
                        "SELECT EXISTS(SELECT 1 FROM public.connection_probes WHERE id=%s) AS ok", (probe,)
                    )
                ).fetchone()
                if not marker["ok"]:
                    raise HTTPException(422, "目标不是当前平台数据库，未应用设置")
                versions = await (
                    await conn.execute("SELECT name,sha256 FROM public.schema_migrations")
                ).fetchall()
                if {r["name"]: r["sha256"] for r in versions} != self.db.expected_migrations:
                    raise HTTPException(422, "目标数据库结构与当前版本不符，未应用设置")
                perms = await (
                    await conn.execute("""SELECT NOT pg_is_in_recovery() AND bool_and(has_table_privilege('public.' || name, permission))
                    AND has_sequence_privilege(pg_get_serial_sequence('public.audit_events','id'),'USAGE')
                    AND has_sequence_privilege(pg_get_serial_sequence('public.task_events','id'),'USAGE') AS ok
                    FROM (VALUES
                    ('users','SELECT'),('users','INSERT'),('users','UPDATE'),
                    ('account_uid_state','SELECT'),('account_uid_state','UPDATE'),
                    ('account_preferences','SELECT'),('account_preferences','INSERT'),('account_preferences','UPDATE'),('account_preferences','DELETE'),
                    ('sessions','SELECT'),('sessions','INSERT'),('sessions','DELETE'),
                    ('registration_state','SELECT'),('registration_state','UPDATE'),
                    ('auth_rate_limits','SELECT'),('auth_rate_limits','INSERT'),('auth_rate_limits','UPDATE'),
                    ('audit_events','SELECT'),('audit_events','INSERT'),
                    ('tasks','SELECT'),('tasks','INSERT'),('tasks','UPDATE'),
                    ('task_events','SELECT'),('task_events','INSERT'),
                    ('worker_heartbeats','SELECT'),('worker_heartbeats','INSERT'),('worker_heartbeats','UPDATE'),
                    ('user_profiles','SELECT'),('user_profiles','INSERT'),('user_profiles','UPDATE'),('user_profiles','DELETE'),
                    ('resource_cursor_key','SELECT'),
                    ('resource_media_objects','SELECT'),('resource_media_objects','INSERT'),('resource_media_objects','DELETE'),
                    ('resource_folders','SELECT'),('resource_folders','INSERT'),('resource_folders','UPDATE'),('resource_folders','DELETE'),
                    ('resource_files','SELECT'),('resource_files','INSERT'),('resource_files','UPDATE'),('resource_files','DELETE'),
                    ('resource_operation_receipts','SELECT'),('resource_operation_receipts','INSERT'),('resource_operation_receipts','DELETE'),
                    ('profile_media_objects','SELECT'),('profile_media_objects','INSERT'),('profile_media_objects','DELETE'),
                    ('profile_operation_receipts','SELECT'),('profile_operation_receipts','INSERT'),('profile_operation_receipts','DELETE'),
                    ('connection_settings','SELECT'),('connection_settings','INSERT'),('connection_settings','UPDATE'),
                    ('connection_receipts','SELECT'),('connection_receipts','INSERT'),('connection_receipts','UPDATE'),
                    ('connection_probes','SELECT'),('connection_probes','INSERT'),
                    ('connection_applied','SELECT'),('connection_applied','INSERT'),('connection_applied','UPDATE')
                    ,('registered_clients','SELECT'),('registered_clients','INSERT'),('registered_clients','UPDATE')
                    ,('client_grants','SELECT'),('client_grants','INSERT'),('client_grants','UPDATE')
                    ,('authorization_codes','SELECT'),('authorization_codes','INSERT'),('authorization_codes','UPDATE')
                    ,('client_tokens','SELECT'),('client_tokens','INSERT'),('client_tokens','UPDATE')
                    ,('backups','SELECT'),('backups','INSERT'),('backups','UPDATE')
                    ,('restore_quarantine','SELECT'),('restore_quarantine','INSERT'),('restore_quarantine','UPDATE')
                    ,('account_actions','SELECT'),('account_actions','INSERT')
                    ,('identity_security','SELECT'),('identity_security','INSERT'),('identity_security','UPDATE'),('identity_security','DELETE')
                    ,('identity_passkey_config','SELECT'),('identity_passkey_config','UPDATE')
                    ,('identity_passkeys','SELECT'),('identity_passkeys','INSERT'),('identity_passkeys','UPDATE'),('identity_passkeys','DELETE'),('identity_passkeys','DELETE')
                    ,('identity_challenges','SELECT'),('identity_challenges','INSERT'),('identity_challenges','UPDATE'),('identity_challenges','DELETE')
                    ,('identity_source_profiles','SELECT'),('identity_source_profiles','INSERT'),('identity_source_profiles','UPDATE')
                    ,('identity_app_grants','SELECT'),('identity_app_grants','INSERT'),('identity_app_grants','UPDATE'),('identity_app_grants','DELETE')
                    ,('identity_app_access_tokens','SELECT'),('identity_app_access_tokens','INSERT'),('identity_app_access_tokens','DELETE')
                    ,('identity_app_refresh_tokens','SELECT'),('identity_app_refresh_tokens','INSERT'),('identity_app_refresh_tokens','UPDATE'),('identity_app_refresh_tokens','DELETE')
                    ,('identity_app_consents','SELECT'),('identity_app_consents','INSERT'),('identity_app_consents','UPDATE')
                    ,('sessions','UPDATE')
                    ,('identity_security','SELECT'),('identity_security','INSERT'),('identity_security','UPDATE')
                    ,('identity_passkey_config','SELECT'),('identity_passkey_config','UPDATE')
                    ,('identity_passkeys','SELECT'),('identity_passkeys','INSERT'),('identity_passkeys','UPDATE')
                    ,('identity_challenges','SELECT'),('identity_challenges','INSERT'),('identity_challenges','UPDATE'),('identity_challenges','DELETE')
                    ,('identity_migrations','SELECT'),('identity_migrations','INSERT')
                    ) AS needed(name,permission)""")
                ).fetchone()
                if not perms["ok"]:
                    raise HTTPException(422, "目标账号缺少平台写入权限，未应用设置")
        return CheckedAddress(address, observed_version)

    def environment_operation(self, data, operation):
        if not self.base.connections_from_environment:
            return
        if operation != "test":
            raise HTTPException(409, "连接由服务器环境配置管理，请修改配置并重启生效")
        configured = self.base.database_url if data.config.kind == "postgresql" else self.base.redis_url
        if not configured:
            raise HTTPException(422, "服务器尚未配置此连接")
        current, _ = current_config(self.base, data.config.kind)
        if (
            data.config != current
            or data.password_mode != "keep"
            or data.password is not None
            or data.revision is not None
        ):
            raise HTTPException(409, "仅可测试服务器当前配置的连接")

    async def persist_operation(
        self,
        conn,
        who,
        data,
        operation,
        fingerprint,
        password,
        status,
        message,
        checked_address,
        admission_id=None,
    ):
        self.environment_operation(data, operation)
        kind = data.config.kind
        revision = None
        if operation == "save" and status == "passed":
            revision = uuid4()
            cipher = self.vault.encrypt(password, kind, self.base.instance_id)
            await conn.execute(
                """INSERT INTO connection_settings (kind,revision,config,password_ciphertext,updated_by)
                VALUES (%s,%s,%s,%s,%s) ON CONFLICT (kind) DO UPDATE SET revision=excluded.revision,
                config=excluded.config,password_ciphertext=excluded.password_ciphertext,updated_by=excluded.updated_by,
                updated_at=clock_timestamp()""",
                (kind, revision, Jsonb(data.config.model_dump()), cipher, who.id),
            )
            status, message = "pending", "已保存，正在应用"
        result = {
            "request_id": str(data.request_id),
            "kind": kind,
            "operation": operation,
            "status": status,
            "message": message,
            "revision": str(revision) if revision else None,
            "observed_at": datetime.now(timezone.utc).isoformat(),
        }
        if kind == "postgresql" and status in {"passed", "pending"}:
            result["postgres_version"] = getattr(checked_address, "postgres_version", None)
        if admission_id is not None:
            admitted = await (
                await conn.execute(
                    "SELECT result FROM connection_receipts WHERE owner_id=%s AND request_id=%s AND result->>'admissionId'=%s",
                    (who.id, data.request_id, str(admission_id)),
                )
            ).fetchone()
            if not admitted:
                raise HTTPException(409, "原连接入场证明不存在")
            for field_name in ("admissionId", "originInstance", "preflightObserved"):
                if field_name in admitted["result"]:
                    result[field_name] = admitted["result"][field_name]
        if admission_id is None:
            await conn.execute(
                "INSERT INTO connection_receipts(owner_id,request_id,kind,operation,fingerprint,result)VALUES(%s,%s,%s,%s,%s,%s)",
                (who.id, data.request_id, kind, operation, fingerprint, Jsonb(result)),
            )
        else:
            updated = await (
                await conn.execute(
                    "UPDATE connection_receipts SET result=%s WHERE owner_id=%s AND request_id=%s AND fingerprint=%s AND result->>'admissionId'=%s AND result->>'status'='unknown' RETURNING request_id",
                    (Jsonb(result), who.id, data.request_id, fingerprint, str(admission_id)),
                )
            ).fetchone()
            if not updated:
                raise HTTPException(409, "原连接预核对回执已变化")
        await conn.execute(
            "INSERT INTO audit_events (actor_id,action,target_id,request_id) VALUES (%s,%s,%s,%s)",
            (who.id, "connection." + operation + "." + status, kind, data.request_id),
        )
        return result, revision

    def request_fingerprint(self, data, operation):
        payload = data.model_dump(mode="json", exclude={"password"})
        payload["password"] = data.password.get_secret_value() if data.password else None
        return hmac.new(
            self.vault.key(), canonical(payload | {"operation": operation}).encode(), hashlib.sha256
        ).hexdigest()

    async def preflight(self, who, data, operation="save"):
        """Commit only a bounded probe nonce; configuration waits for finalize.

        This is an internal object, never a client-controlled approval ticket.
        """
        self.environment_operation(data, operation)
        if operation not in ("save", "test"):
            raise HTTPException(400, "连接操作无效")
        probe = uuid4()
        admission_id = uuid4()
        fingerprint = self.request_fingerprint(data, operation)
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("connection:" + data.config.kind,)
            )
            if operation == "save":
                from .connection_access import require_connection_verification

                await require_connection_verification(conn, who)
            previous = await (
                await conn.execute(
                    "SELECT * FROM connection_receipts WHERE owner_id=%s AND request_id=%s",
                    (who.id, data.request_id),
                )
            ).fetchone()
            if previous:
                if previous["fingerprint"] != fingerprint or previous["kind"] != data.config.kind:
                    raise HTTPException(409, "请求编号已用于其他配置")
                return ConnectionPreparation(
                    self,
                    who.id,
                    who.token_hash,
                    self.base.instance_id,
                    fingerprint,
                    datetime.now(timezone.utc) + timedelta(seconds=30),
                    existing=previous["result"],
                )
            row = await self.row(conn, data.config.kind)
            if (row["revision"] if row else None) != data.revision:
                raise HTTPException(409, "连接设置已更新，请重新读取")
            count = await (
                await conn.execute(
                    "SELECT count(*)n FROM connection_receipts WHERE owner_id=%s AND kind=%s AND created_at>clock_timestamp()-interval '15 minutes'",
                    (who.id, data.config.kind),
                )
            ).fetchone()
            if count["n"] >= 20:
                raise HTTPException(429, "连接操作过于频繁，请稍后再试")
            password = self.resolved_password(data, row)
            from .notification_security import NotificationSecurity

            factor_stamp = await NotificationSecurity(self.db).identity_stamp(conn, who)
            await conn.execute("INSERT INTO connection_probes(id)VALUES(%s)", (probe,))
            admitted = {
                "request_id": str(data.request_id),
                "kind": data.config.kind,
                "operation": operation,
                "status": "unknown",
                "message": "连接预核对已入场，结果尚未确认",
                "revision": None,
                "observed_at": datetime.now(timezone.utc).isoformat(),
                "admissionId": str(admission_id),
                "originInstance": str(self.base.instance_id),
                "willRetryAutomatically": False,
            }
            await conn.execute(
                "INSERT INTO connection_receipts(owner_id,request_id,kind,operation,fingerprint,result)VALUES(%s,%s,%s,%s,%s,%s)",
                (who.id, data.request_id, data.config.kind, operation, fingerprint, Jsonb(admitted)),
            )
        address = None
        status, message = "passed", "连接成功"
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            if not hmac.compare_digest(
                factor_stamp, await NotificationSecurity(self.db).identity_stamp(conn, who)
            ):
                raise HTTPException(403, "连接安全因子已变化")
            current = await self.row(conn, data.config.kind)
            current_instance = await (
                await conn.execute("SELECT instance_id FROM alcor_instance WHERE singleton")
            ).fetchone()
            if (
                not current_instance
                or current_instance["instance_id"] != self.base.instance_id
                or (current["revision"] if current else None) != data.revision
            ):
                raise HTTPException(409, "连接入场后版本或实例已变化")
        try:
            address = await asyncio.wait_for(self.check(data.config, password, probe, operation == "save"), 6)
        except HTTPException as exc:
            status, message = "failed", str(exc.detail)
        except Exception as exc:
            status, message = "unknown", connection_failure_message(data.config.kind, exc)
        async with self.db.connection() as observed, observed.transaction():
            await observed.execute(
                "UPDATE connection_receipts SET result=result||%s WHERE owner_id=%s AND request_id=%s AND result->>'admissionId'=%s AND EXISTS(SELECT 1 FROM alcor_instance WHERE singleton AND instance_id=%s)",
                (
                    Jsonb(
                        {
                            "preflightObserved": {
                                "status": status,
                                "postgres_version": getattr(address, "postgres_version", None),
                                "observed_at": datetime.now(timezone.utc).isoformat(),
                            }
                        }
                    ),
                    who.id,
                    data.request_id,
                    str(admission_id),
                    self.base.instance_id,
                ),
            )
        return ConnectionPreparation(
            self,
            who.id,
            who.token_hash,
            self.base.instance_id,
            fingerprint,
            datetime.now(timezone.utc) + timedelta(seconds=30),
            password=password,
            address=address,
            status=status,
            message=message,
            admission_id=admission_id,
            factor_stamp=factor_stamp,
        )

    async def finalize_on_connection(self, conn, who, data, prepared, operation="save"):
        self.environment_operation(data, operation)
        if (
            not isinstance(prepared, ConnectionPreparation)
            or prepared.service is not self
            or prepared.owner != who.id
            or prepared.principal != who.token_hash
            or prepared.instance != self.base.instance_id
            or prepared.expires_at <= datetime.now(timezone.utc)
            or not hmac.compare_digest(prepared.fingerprint, self.request_fingerprint(data, operation))
        ):
            raise HTTPException(409, "连接预核对已变化或过期")
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("connection:" + data.config.kind,)
        )
        await lock_mutation_identity(conn, who)
        if operation == "save":
            from .connection_access import require_connection_verification

            await require_connection_verification(conn, who)
        instance = await (
            await conn.execute("SELECT instance_id FROM alcor_instance WHERE singleton")
        ).fetchone()
        if not instance or instance["instance_id"] != prepared.instance:
            raise HTTPException(409, "连接实例已换代")
        previous = await (
            await conn.execute(
                "SELECT * FROM connection_receipts WHERE owner_id=%s AND request_id=%s",
                (who.id, data.request_id),
            )
        ).fetchone()
        if previous:
            if previous["fingerprint"] != prepared.fingerprint:
                raise HTTPException(409, "请求编号已用于其他配置")
            if prepared.admission_id is None or previous["result"].get("admissionId") != str(
                prepared.admission_id
            ):
                return previous["result"]
        from .notification_security import NotificationSecurity

        if not prepared.factor_stamp or not hmac.compare_digest(
            prepared.factor_stamp, await NotificationSecurity(self.db).identity_stamp(conn, who)
        ):
            raise HTTPException(403, "连接安全因子已变化，请重新核对")
        row = await self.row(conn, data.config.kind)
        if (row["revision"] if row else None) != data.revision:
            raise HTTPException(409, "连接设置已更新，请重新读取")
        if prepared.existing is not None:
            raise HTTPException(409, "原连接回执已变化")
        result, _ = await self.persist_operation(
            conn,
            who,
            data,
            operation,
            prepared.fingerprint,
            prepared.password,
            prepared.status,
            prepared.message,
            prepared.address,
            prepared.admission_id,
        )
        return result  # the existing process watcher applies only after outer commit

    async def operate(self, who, data, operation):
        self.environment_operation(data, operation)
        kind = data.config.kind
        probe = uuid4()
        # A committed nonce lets the candidate prove it is the same authoritative database.
        async with self.db.connection() as conn, conn.transaction():
            await lock_mutation_identity(conn, who)
            if operation == "save":
                from .connection_access import require_connection_verification

                await require_connection_verification(conn, who)
            await conn.execute("INSERT INTO connection_probes (id) VALUES (%s)", (probe,))
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("connection:" + kind,)
            )
            await lock_mutation_identity(conn, who)
            previous = await (
                await conn.execute(
                    "SELECT * FROM connection_receipts WHERE owner_id=%s AND request_id=%s",
                    (who.id, data.request_id),
                )
            ).fetchone()
            row = await self.row(conn, kind)
            # Replays bind the original input, including keep/clear mode, without depending on a later revision.
            request_payload = data.model_dump(mode="json", exclude={"password"})
            request_payload["password"] = data.password.get_secret_value() if data.password else None
            fingerprint = hmac.new(
                self.vault.key(),
                canonical(request_payload | {"operation": operation}).encode(),
                hashlib.sha256,
            ).hexdigest()
            if previous:
                if previous["fingerprint"] != fingerprint or previous["kind"] != kind:
                    raise HTTPException(409, "请求编号已用于其他配置")
                return previous["result"]
            if (row["revision"] if row else None) != data.revision:
                raise HTTPException(409, "连接设置已更新，请重新读取")
            recent_count = await (
                await conn.execute(
                    "SELECT count(*) AS n FROM connection_receipts WHERE owner_id=%s AND kind=%s AND created_at>clock_timestamp()-interval '15 minutes'",
                    (who.id, kind),
                )
            ).fetchone()
            if recent_count["n"] >= 20:
                raise HTTPException(429, "连接操作过于频繁，请稍后再试")
            password = self.resolved_password(data, row)
            status, message = "passed", "连接成功"
            checked_address = None
            try:
                checked_address = await asyncio.wait_for(
                    self.check(data.config, password, probe, operation == "save"), 6
                )
            except HTTPException as exc:
                status, message = "failed", str(exc.detail)
            except Exception as exc:
                status, message = "failed", connection_failure_message(kind, exc)
            result, revision = await self.persist_operation(
                conn, who, data, operation, fingerprint, password, status, message, checked_address
            )
        if revision:
            await self.refresh()
            if self.applied.get(kind) == revision:
                result |= {"status": "saved", "message": "已保存并应用"}
                async with self.db.connection() as conn:
                    await conn.execute(
                        "UPDATE connection_receipts SET result=%s WHERE owner_id=%s AND request_id=%s",
                        (Jsonb(result), who.id, data.request_id),
                    )
        return result

    async def refresh(self):
        if self.base.connections_from_environment:
            return
        async with self.apply_lock:
            async with self.db.connection() as conn:
                rows = await (
                    await conn.execute("SELECT * FROM connection_settings ORDER BY kind")
                ).fetchall()
            for row in rows:
                kind, revision = row["kind"], row["revision"]
                if self.applied.get(kind) != revision:
                    config, password = self.values(row, kind)
                    try:
                        address = await self.address(config)
                        if kind == "postgresql":
                            probe = uuid4()
                            async with self.db.connection() as conn:
                                await conn.execute("INSERT INTO connection_probes (id) VALUES (%s)", (probe,))
                            await asyncio.wait_for(self.check(config, password, probe, True), 6)
                            settings = postgres_settings(self.base, config, password, address)
                            await self.db.replace(settings)
                            self.effective[kind] = config
                            if self.role == "api":
                                self.vault.write_bootstrap(
                                    config, password, address, revision, self.base.instance_id
                                )
                        else:
                            await self.cache.replace(redis_client(config, password, address))
                        self.applied[kind] = revision
                        self.effective[kind] = config
                    except Exception:
                        continue  # Keep the last working pool; expose pending until a verified replacement exists.
                async with self.db.connection() as conn:
                    await conn.execute(
                        """INSERT INTO connection_applied (process_id,role,kind,revision) VALUES (%s,%s,%s,%s)
                        ON CONFLICT (process_id,kind) DO UPDATE SET revision=excluded.revision,observed_at=clock_timestamp()""",
                        (self.process_id, self.role, kind, revision),
                    )

    async def watch(self):
        while True:
            try:
                await self.refresh()
            except Exception:
                pass
            await asyncio.sleep(2)
