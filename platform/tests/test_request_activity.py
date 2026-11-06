from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, timedelta

import httpx
import pytest
from alcor_api.request_activity import RequestActivity, calendar_window, snapshot


@pytest.mark.parametrize(
    ("end", "start"),
    [
        (date(2026, 11, 2), date(2025, 12, 1)),
        (date(2026, 12, 1), date(2026, 1, 1)),
        (date(2026, 1, 31), date(2025, 2, 1)),
        (date(2024, 2, 29), date(2023, 3, 1)),
    ],
)
def test_twelve_calendar_months_have_no_repeated_month(end, start):
    assert calendar_window(end) == start
    assert (end.year - start.year) * 12 + end.month - start.month == 11


async def test_owned_http_counts_no_anonymous_or_assets_and_survive_restart(client, admin, app, db):
    collector = app.state.request_activity
    await collector.flush()
    before = sum(day["requests"] for day in (await snapshot(db, admin))["days"])
    for _ in range(3):
        assert (await client.get("/api/profile")).status_code == 200
    await client.get("/health/live")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as anonymous:
        assert (await anonymous.get("/api/profile/requests?user_id=" + admin)).status_code == 401
    await collector.flush()
    saved = await snapshot(db, admin)
    assert sum(day["requests"] for day in saved["days"]) == before + 3
    assert saved["observed_only"] and not saved["incomplete"]
    replacement = RequestActivity(db)
    await replacement.flush()
    assert (await snapshot(db, admin))["days"] == saved["days"]
    own = await client.get("/api/profile/requests?user_id=some-other-user")
    assert own.status_code == 200
    assert own.json()["days"][-1]["requests"] == saved["days"][-1]["requests"]
    full = await client.get("/api/system/migration")
    summary = await client.get("/api/system/migration?summary=1")
    assert full.status_code == summary.status_code == 200
    assert summary.json() == {
        "summary": full.json()["summary"],
        "capability_plan": {"summary": full.json()["capability_plan"]["summary"]},
    }
    assert len(summary.content) < len(full.content) / 100


async def test_batch_commit_retry_is_idempotent_and_keeps_new_requests(db, admin, app, monkeypatch):
    await app.state.request_activity.flush()
    collector = RequestActivity(db)
    before = sum(day["requests"] for day in (await snapshot(db, admin))["days"])
    collector.record(admin)
    original = db.connection

    @asynccontextmanager
    async def lost_acknowledgement():
        async with original() as conn:
            yield conn
        raise OSError("synthetic acknowledgement lost after commit")

    monkeypatch.setattr(db, "connection", lost_acknowledgement)
    with pytest.raises(OSError):
        await collector.flush()
    collector.record(admin)
    monkeypatch.setattr(db, "connection", original)
    await collector.flush()  # Replay committed batch without incrementing twice.
    await collector.flush()  # New request remains queued separately.
    assert sum(day["requests"] for day in (await snapshot(db, admin))["days"]) == before + 2
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS count FROM account_request_activity_batches WHERE id=%s",
                    (collector.producer,),
                )
            ).fetchone()
        )["count"] == 1


async def test_shanghai_dates_collection_floor_account_isolation_and_overflow(db, admin, app):
    await app.state.request_activity.flush()
    now = datetime.now(UTC)
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE account_request_activity_state SET observed_since=%s", (now - timedelta(days=2),)
        )
        await conn.execute("UPDATE users SET created_at=%s WHERE id=%s", (now - timedelta(days=10), admin))
    collector = RequestActivity(db)
    at = datetime(2026, 1, 1, 16, 1, tzinfo=UTC)
    collector.record(admin, at)
    collector.record("deleted-account", at)
    await collector.flush()
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT requests FROM account_request_activity WHERE user_id=%s AND day='2026-01-02'",
                (admin,),
            )
        ).fetchone()
        assert row["requests"] == 1
        assert not await (
            await conn.execute("SELECT 1 FROM account_request_activity WHERE user_id='deleted-account'")
        ).fetchone()
    value = await snapshot(db, admin, now)
    assert value["days"][0]["date"] == value["observed_since"]
    assert len(value["days"]) <= 3
    for index in range(4097):
        collector.record("missing-" + str(index))
    assert len(collector.pending) == 4096 and collector.dropped == 1
    await collector.flush()
    assert (await snapshot(db, admin))["incomplete"]
