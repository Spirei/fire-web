"""Batched read budgets share one pooled connection and keep independent counters."""

from contextlib import asynccontextmanager

import pytest

from alcor_api.main import rate_limits


async def test_batched_limits_use_one_checkout_and_independent_budgets(db, monkeypatch):
    pool = db.pool
    original = pool.connection
    checkouts = 0

    @asynccontextmanager
    async def counted():
        nonlocal checkouts
        checkouts += 1
        async with original() as conn:
            yield conn

    monkeypatch.setattr(pool, "connection", counted)
    checks = (("synthetic-limit-owner", 2), ("synthetic-limit-global", 3))
    assert await rate_limits(db, checks) is True
    assert checkouts == 1
    assert await rate_limits(db, checks) is True
    assert checkouts == 2
    # The per-owner budget is exceeded while the global budget still has room.
    assert await rate_limits(db, checks) is False
    assert checkouts == 3
    async with db.connection() as conn:
        rows = await (
            await conn.execute(
                "SELECT bucket,attempts FROM auth_rate_limits WHERE bucket=ANY(%s) ORDER BY bucket",
                (["synthetic-limit-owner", "synthetic-limit-global"],),
            )
        ).fetchall()
    assert [(row["bucket"], row["attempts"]) for row in rows] == [
        ("synthetic-limit-global", 3),
        ("synthetic-limit-owner", 3),
    ]


async def test_batched_limits_reject_invalid_budgets(db):
    with pytest.raises(ValueError):
        await rate_limits(db, (("synthetic-invalid", 0),))
    with pytest.raises(ValueError):
        await rate_limits(db, (("synthetic-invalid", 1),), window_seconds=0)
