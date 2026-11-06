"""Read-only release/database compatibility check before replacing a container."""
import hashlib
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from .db import verify_identity


def compare(expected, actual):
    return {"compatible": bool(expected) and expected == actual,
            "missing": sorted(expected.keys() - actual.keys()),
            "changed": sorted(k for k in expected.keys() & actual.keys() if expected[k] != actual[k]),
            "extra": sorted(actual.keys() - expected.keys())}


async def check(settings):
    from .connections import bootstrap_settings

    settings, _ = bootstrap_settings(settings, read_only=True)
    expected = {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                for p in settings.migration_dir.glob("[0-9]*.sql")}
    async with await AsyncConnection.connect(settings.database_url.get_secret_value(),
        row_factory=dict_row, options="-c default_transaction_read_only=on -c search_path=public -c statement_timeout=10000") as conn:
        await verify_identity(conn, settings)
        rows = await (await conn.execute("SELECT name,sha256 FROM schema_migrations")).fetchall()
    return compare(expected, {r["name"]: r["sha256"] for r in rows})
