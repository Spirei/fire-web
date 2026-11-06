from datetime import date, datetime
from uuid import uuid4

import psycopg
import pytest


@pytest.mark.asyncio
async def test_pg_precision_constraints_and_timezone(db):
    async with db.connection() as conn:
        revision = uuid4()
        await conn.execute(
            "INSERT INTO fx_provider_revisions(id,config,credential_instance) VALUES(%s,'{}',%s)",
            (revision, uuid4()),
        )

        async def insert(precision, day, instant):
            identifier = uuid4()
            await conn.execute(
                "INSERT INTO fx_observations(id,provider,source_uri,base_currency,observation_date,received_at,original_bytes,raw_sha256,normalized_sha256,provider_revision,source_precision,source_instant) VALUES(%s,%s,%s,%s,%s,clock_timestamp(),%s,%s,%s,%s,%s,%s)",
                (
                    identifier,
                    "custom",
                    "https://provider.example/[redacted]",
                    "USD",
                    day,
                    b"{}",
                    "0" * 64,
                    "0" * 64,
                    revision,
                    precision,
                    instant,
                ),
            )
            return identifier

        for precision, day, instant in [
            ("unknown", date(2026, 1, 1), None),
            ("unknown", None, datetime.fromisoformat("2026-01-01T00:00:00Z")),
            ("date", None, None),
            ("instant", None, None),
            ("instant", date(2026, 1, 1), datetime.fromisoformat("2026-01-01T00:00:00Z")),
        ]:
            with pytest.raises(psycopg.errors.CheckViolation):
                async with conn.transaction():
                    await insert(precision, day, instant)
        stamp = datetime.fromisoformat("2026-01-01T00:00:00.123456+08:00")
        identifier = await insert("instant", None, stamp)
        for zone in ("UTC", "Asia/Shanghai", "America/New_York"):
            await conn.execute("SELECT set_config('TimeZone',%s,true)", (zone,))
            row = await (
                await conn.execute(
                    "SELECT source_instant,observation_date FROM fx_observations WHERE id=%s", (identifier,)
                )
            ).fetchone()
            assert row["source_instant"] == stamp and row["source_instant"].microsecond == 123456
            assert row["observation_date"] is None
        await insert("unknown", None, None)
        await insert("date", date(2026, 1, 1), None)
