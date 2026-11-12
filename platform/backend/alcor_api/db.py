import hashlib
from contextlib import asynccontextmanager

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .config import Settings
from .request_timing import TimedConnection, elapsed, measure, start

PRODUCT = "alcor-platform"


class TargetMismatch(RuntimeError):
    pass


async def verify_identity(conn, settings: Settings):
    row = await (
        await conn.execute(
            "SELECT instance_id, environment, product FROM public.alcor_instance WHERE singleton = true"
        )
    ).fetchone()
    if (
        not row
        or str(row["instance_id"]) != str(settings.instance_id)
        or row["environment"] != settings.environment
        or row["product"] != PRODUCT
    ):
        raise TargetMismatch("Database identity does not match the configured platform instance")


class Database:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.expected_migrations = {
            p.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in settings.migration_dir.glob("[0-9]*.sql")
        }
        self.pool = (
            AsyncConnectionPool(
                settings.database_url.get_secret_value(),
                connection_class=TimedConnection,
                open=False,
                min_size=settings.pool_min_size,
                max_size=settings.pool_size,
                timeout=3,
                max_waiting=20,
                max_lifetime=settings.pool_max_lifetime,
                max_idle=settings.pool_max_idle,
                kwargs={
                    "autocommit": True,
                    "row_factory": dict_row,
                    "connect_timeout": settings.connect_timeout,
                    "options": "-c search_path=public -c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=10000",
                },
            )
            if settings.database_url
            else None
        )

    async def open(self):
        if self.pool:
            await self.pool.open()

    async def close(self):
        if self.pool:
            await self.pool.close()

    @asynccontextmanager
    async def connection(self):
        if not self.pool:
            raise TargetMismatch("Database is not configured")
        started, acquired = start(), False
        try:
            async with self.pool.connection() as conn:
                elapsed('pool_wait', started)
                acquired = True
                with measure('db_guard'):
                    await verify_identity(conn, self.settings)
                    versions = await (await conn.execute("SELECT name,sha256 FROM schema_migrations")).fetchall()
                    if (
                        not self.expected_migrations
                        or {r["name"]: r["sha256"] for r in versions} != self.expected_migrations
                    ):
                        raise TargetMismatch("Database schema does not match this application release")
                    if "0131_private_runtime_settings.sql" in self.expected_migrations:
                        from .private_runtime_settings import load_runtime_on_connection

                        await load_runtime_on_connection(conn, self.settings)
                yield conn
        finally:
            if not acquired:
                elapsed('pool_wait', started)

    async def replace(self, settings):
        candidate = Database(settings)
        await candidate.open()
        try:
            async with candidate.connection() as conn:
                await conn.execute("SELECT 1")
        except BaseException:
            await candidate.close()
            raise
        old = self.pool
        self.pool, self.settings = candidate.pool, settings
        if old:
            await old.close()
