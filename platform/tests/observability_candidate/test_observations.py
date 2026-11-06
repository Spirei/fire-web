import httpx
import pytest
from alcor_api.request_observability import Observations, rollup
from alcor_api.request_observability_api import snapshot


async def test_real_http_route_template_privacy_pg_restart_and_worker(client, admin, app, db):
    probe = "NEVER_PERSIST_opaque_token_and_filename"
    await client.get(
        "/api/no-such/" + probe + "?password=" + probe,
        headers={"User-Agent": "Mozilla/" + probe, "Authorization": "Bearer " + probe},
    )
    oversized = await client.post("/api/session/login", content=b"x" * 70000)
    assert oversized.status_code == 413
    denied = await client.get("/api/activities", headers={"Origin": "https://unapproved.example.invalid"})
    assert denied.status_code == 403
    observations = app.state.request_observations
    await observations.flush()
    async with db.connection() as conn:
        rows = await (await conn.execute("SELECT * FROM request_observations")).fetchall()
        assert rows
        assert any(
            r["path"] == "/api/[unmatched]" and r["status"] == 404 and r["source"] == "web" for r in rows
        )
        assert any(r["path"] == "/api/session/login" and r["status"] == 413 for r in rows)
        assert any(r["path"] == "/api/activities" and r["status"] == 403 for r in rows)
        assert probe not in str(rows)
        before = await snapshot(conn, {})
        assert before["rollupPending"]
    await rollup(db)
    await rollup(db)
    async with db.connection() as conn:
        result = await snapshot(conn, {})
        assert result["summary"]["total"] == len(rows)
        assert result["summary"]["errors"] >= 1
        assert result["aggregateRevision"] == result["revision"]
        assert result["observedOnly"] and not result["crashLossKnown"]
        assert result["legacyImport"] == {
            "detailRows": 0,
            "dailyCells": 0,
            "hourCells": 0,
            "historicalCoverageKnown": False,
            "hourDurationKnown": False,
        }
        assert result["summary"]["sources"]["web"] >= 1
        assert len(result["chart"]) >= 1
    # Queue/runtime reconstruction does not erase persisted details or aggregate watermark.
    replacement = Observations(db)
    await replacement.flush()
    read = await client.get("/api/request-logs")
    assert read.status_code == 200, read.text
    assert read.json()["data"]["summary"] == result["summary"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as anonymous:
        assert (await anonymous.get("/api/request-logs")).status_code == 401
        assert (await anonymous.get("/api/request-logs/events")).status_code == 401
    assert (
        await client.get("/api/request-logs", headers={"Authorization": "Bearer secret"})
    ).status_code == 403


async def test_retention_preserves_rollups_explicit_anchor_gap_and_filters(client, admin, app, db):
    obs = app.state.request_observations
    await obs.flush()
    async with db.connection() as conn, conn.transaction():
        await conn.execute("TRUNCATE request_observations,request_rollups RESTART IDENTITY")
        await conn.execute("UPDATE request_rollup_state SET revision=0,aggregate_revision=0,detail_floor=0")
    obs.record("/api/records/{record_id}", "GET", "ios", 499, 12)
    obs.record("/api/records/{record_id}", "POST", "app", 503, 24)
    obs.record("/api/account/state", "GET", "web", 200, 6)
    await obs.flush()
    await rollup(db)
    async with db.connection() as conn:
        value = await snapshot(conn, {"rStatus": "cancelled", "rSource": "ios", "rQ": "records"})
        assert value["summary"]["total"] == 1 and value["summary"]["errors"] == 1
        assert value["logs"][0]["status"] == 499
        value = await snapshot(conn, {"rStatus": "4xx"})
        assert value["summary"]["total"] == 0
        value = await snapshot(conn, {"rStatus": "5xx"})
        assert value["summary"]["total"] == 1
        assert value["summary"]["averageMs"] == 24
        old = await snapshot(conn, {"rAnchor": "1"})
        assert len(old["logs"]) == 1 and old["pagination"]["anchor"] == 1
        await conn.execute(
            "UPDATE request_observations SET at=clock_timestamp()-interval '8 days' WHERE id=1"
        )
    await rollup(db)
    async with db.connection() as conn:
        value = await snapshot(conn, {"rAnchor": "1"})
        assert value["detailGap"]
        assert value["summary"]["total"] == 3
        assert len(value["logs"]) == 0
        assert value["heatmap"]


async def test_queue_overflow_and_flush_rollback_no_business_result_changes(app, db, monkeypatch):
    obs = app.state.request_observations
    for i in range(2050):
        obs.record("/api/sample/{id}", "GET", "other", 200, i)
    assert len(obs.queue) == 2048 and obs.lost == 2
    original = obs.db.connection
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def broken():
        obs.record("/api/later/{id}", "GET", "other", 200, 1)
        raise RuntimeError("synthetic storage outage")
        yield

    monkeypatch.setattr(obs.db, "connection", broken)
    with pytest.raises(RuntimeError):
        await obs.flush()
    assert len(obs.queue) == 2048 and obs.lost == 3
    monkeypatch.setattr(obs.db, "connection", original)
    await obs.flush()
    async with db.connection() as conn:
        state = await (await conn.execute("SELECT * FROM request_rollup_state")).fetchone()
        assert state["lost"] == 3 and state["revision"] == 512
    assert len(obs.queue) == 1536 and obs.lost == 3 and obs.flushed_lost == 3


async def test_admin_snapshot_get_does_not_flush_queue_or_rollup_prune_or_write_business(
    client, admin, app, db
):
    from alcor_api.backups import tables_and_hashes

    obs = app.state.request_observations
    await obs.flush()
    obs.record("/api/still-buffered/{id}", "GET", "other", 200, 1)
    pending = len(obs.queue)
    # Hold the collector serialization row so its independent timer cannot make
    # an unrelated operational write during this read-only HTTP proof.
    async with db.connection() as conn, conn.transaction():
        await conn.execute("SELECT singleton FROM request_rollup_state WHERE singleton FOR UPDATE")
        before = await tables_and_hashes(conn)
        result = await client.get("/api/request-logs")
        assert result.status_code == 200, result.text
        assert len(obs.queue) == pending
        assert await tables_and_hashes(conn) == before
        assert result.json()["data"]["localCollector"]["buffered"] == pending
