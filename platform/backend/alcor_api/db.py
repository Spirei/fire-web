import hashlib
from contextlib import asynccontextmanager
from contextvars import ContextVar

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .config import Settings
from .request_timing import TimedConnection, elapsed, measure, start

PRODUCT = "alcor-platform"
SCHEMA_MIGRATION_LOCK = 67132001
_deployment_schema = ContextVar("allowed_deployment_schema", default=False)


async def deployment_schema_scope():
    """Let explicitly scoped deployment routes read an already-migrated database."""
    token = _deployment_schema.set(True)
    try:
        yield
    finally:
        _deployment_schema.reset(token)


async def applied_migrations(conn):
    rows = await (await conn.execute("SELECT name,sha256 FROM public.schema_migrations")).fetchall()
    return {row["name"]: row["sha256"] for row in rows}


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
                # A page loads many icons at once; let a short burst queue
                # instead of returning TooManyRequests immediately. The
                # per-checkout timeout still bounds the wait.
                max_waiting=100,
                max_lifetime=settings.pool_max_lifetime,
                max_idle=settings.pool_max_idle,
                kwargs={
                    "autocommit": True,
                    "row_factory": dict_row,
                    "connect_timeout": settings.connect_timeout,
                    # Quote and asset reads reuse the same statements on every
                    # poll. Prepare them after the second use so a weak NAS CPU
                    # does not re-plan them on each pooled request.
                    "prepare_threshold": 2,
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
                    # A pooled connection never changes its database target; the
                    # identity and applied-schema checks run once per physical
                    # connection instead of on every checkout. A new connection
                    # (including one created after a pool replacement) re-verifies.
                    deployment = _deployment_schema.get()
                    names = None if deployment else getattr(conn, "_alcor_schema_names", None)
                    if names is None:
                        await verify_identity(conn, self.settings)
                        installed = await applied_migrations(conn)
                        exact = installed == self.expected_migrations
                        if not self.expected_migrations or not (
                            exact or deployment and self.expected_migrations.items() <= installed.items()
                        ):
                            raise TargetMismatch("Database schema does not match this application release")
                        names = frozenset(installed)
                        if exact:
                            setattr(conn, "_alcor_schema_names", names)
                    if "0131_private_runtime_settings.sql" in names:
                        from .private_runtime_settings import load_runtime_on_connection

                        await load_runtime_on_connection(conn, self.settings, installed=True)
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
