import hashlib

from psycopg import AsyncConnection
from psycopg.rows import dict_row

from .config import Settings
from .db import PRODUCT, SCHEMA_MIGRATION_LOCK, TargetMismatch, applied_migrations, verify_identity


def pending_migrations(applied, target):
    names = sorted(target)
    if set(names[:len(applied)]) != set(applied) or any(target[name] != digest for name, digest in applied.items()):
        raise TargetMismatch("Database migrations are not a verified prefix of the target image")
    return names[len(applied):]


async def migrate(settings: Settings, database_name: str, initialize_empty: bool = False, *, require_target_schema=False):
    if not settings.database_url or not settings.instance_id:
        raise TargetMismatch("Explicit database and instance identity are required")
    async with await AsyncConnection.connect(
        settings.database_url.get_secret_value(),
        row_factory=dict_row,
        # Index builds on retained market/audit history can exceed the short
        # request budget. Migrations are a maintenance operation and run with
        # the service stopped; the lock timeout still fails fast on live writers.
        options="-c search_path=public -c statement_timeout=900000 -c lock_timeout=5000",
    ) as conn:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(%s)", (SCHEMA_MIGRATION_LOCK,))
            current = await (await conn.execute("SELECT current_database() AS name")).fetchone()
            if current["name"] != database_name:
                raise TargetMismatch("Database name confirmation does not match")
            marker = await (
                await conn.execute("SELECT to_regclass('public.alcor_instance') AS marker")
            ).fetchone()
            if not marker["marker"]:
                objects = await (
                    await conn.execute("""
                    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' LIMIT 1
                """)
                ).fetchone()
                if objects or not initialize_empty:
                    raise TargetMismatch("Refusing an unmarked or nonempty database")
                await conn.execute("""CREATE TABLE alcor_instance (
                    singleton boolean PRIMARY KEY CHECK (singleton = true),
                    instance_id uuid NOT NULL, environment text NOT NULL, product text NOT NULL)
                """)
                await conn.execute(
                    "INSERT INTO alcor_instance VALUES (true,%s,%s,%s)",
                    (settings.instance_id, settings.environment, PRODUCT),
                )
                await conn.execute(
                    "CREATE TABLE schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())"
                )
            await verify_identity(conn, settings)
            files = {file.name: file.read_bytes() for file in sorted(settings.migration_dir.glob("[0-9]*.sql"))}
            if require_target_schema:
                target = {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}
                pending_migrations(await applied_migrations(conn), target)
            for name, content in files.items():
                digest = hashlib.sha256(content).hexdigest()
                old = await (
                    await conn.execute("SELECT sha256 FROM schema_migrations WHERE name=%s", (name,))
                ).fetchone()
                if old:
                    if old["sha256"] != digest:
                        raise TargetMismatch(f"Applied migration checksum changed: {name}")
                    continue
                await conn.execute(content.decode(), prepare=False)
                await conn.execute(
                    "INSERT INTO schema_migrations (name,sha256) VALUES (%s,%s)", (name, digest)
                )
