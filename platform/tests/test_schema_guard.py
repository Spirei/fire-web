import psycopg
import pytest

from alcor_api.db import TargetMismatch


async def test_mismatched_schema_cannot_authorize_a_write(settings, db):
    with psycopg.connect(settings.database_url.get_secret_value()) as conn:
        conn.execute("UPDATE schema_migrations SET sha256='unknown-release'")
    with pytest.raises(TargetMismatch):
        async with db.connection():
            pytest.fail("an incompatible schema reached the business operation")
