import asyncio
from uuid import uuid4

import pytest
from alcor_api.request_observability import rollup
from fastapi import HTTPException
from psycopg.errors import RaiseException
from starlette.requests import Request


def request_for(app, client, path="/api/request-logs/events"):
    cookie = "; ".join(f"{key}={value}" for key, value in client.cookies.items())
    return Request(
        {
            "type": "http",
            "method": "GET",
            "scheme": "http",
            "path": path,
            "query_string": b"",
            "headers": [
                (b"host", b"testserver"),
                (b"cookie", cookie.encode()),
                (b"origin", b"http://testserver"),
            ],
            "server": ("testserver", 80),
            "app": app,
        }
    )


async def test_cross_instance_pg_cap_release_and_current_session_revocation(
    client, admin, app, db, monkeypatch
):
    import alcor_api.request_observability_api as module

    monkeypatch.setattr(module, "STREAM_POLL_SECONDS", 0.001)
    endpoint = next(r.endpoint for r in app.routes if getattr(r, "path", "") == "/api/request-logs/events")
    request = request_for(app, client)
    # Existing leases from another process count against this process' same global cap.
    async with db.connection() as conn:
        for _ in range(19):
            await conn.execute(
                "INSERT INTO request_stream_leases VALUES(%s,clock_timestamp()+interval '30 seconds')",
                (uuid4(),),
            )
    response = await endpoint(request)
    with pytest.raises(HTTPException) as denied:
        await endpoint(request)
    assert denied.value.status_code == 429
    iterator = response.body_iterator
    assert (await anext(iterator)).startswith("event: change\ndata: ")
    assert await anext(iterator) == ": heartbeat\n\n"
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET session_version=session_version+1 WHERE id=%s", (admin,))
    with pytest.raises(StopAsyncIteration):
        await anext(iterator)
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM request_stream_leases")).fetchone())[
            "n"
        ] == 19


async def test_cancel_stream_releases_lease_and_worker_reaps_crashed_process(client, admin, app, db):
    endpoint = next(r.endpoint for r in app.routes if getattr(r, "path", "") == "/api/request-logs/events")
    response = await endpoint(request_for(app, client))
    iterator = response.body_iterator
    await anext(iterator)
    await iterator.aclose()
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM request_stream_leases")).fetchone())[
            "n"
        ] == 0
        await conn.execute(
            "INSERT INTO request_stream_leases VALUES(%s,clock_timestamp()-interval '1 second')", (uuid4(),)
        )
    await rollup(db)
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM request_stream_leases")).fetchone())[
            "n"
        ] == 0


async def test_rollup_failure_rolls_back_all_units_and_watermark(app, db):
    obs = app.state.request_observations
    obs.record("/api/receipts/{rid}", "GET", "other", 200, 5)
    await obs.flush()
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION fail_daily_rollup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.unit='day' THEN RAISE EXCEPTION 'synthetic rollup outage'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER fail_daily_rollup BEFORE INSERT ON request_rollups FOR EACH ROW EXECUTE FUNCTION fail_daily_rollup()"
        )
    with pytest.raises(RaiseException):
        await rollup(db)
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM request_rollups")).fetchone())["n"] == 0
        assert (await (await conn.execute("SELECT aggregate_revision FROM request_rollup_state")).fetchone())[
            "aggregate_revision"
        ] == 0
        await conn.execute("DROP TRIGGER fail_daily_rollup ON request_rollups")
    await asyncio.gather(rollup(db), rollup(db))
    async with db.connection() as conn:
        values = await (
            await conn.execute("SELECT unit,sum(count) AS n FROM request_rollups GROUP BY unit")
        ).fetchall()
        assert {r["unit"]: r["n"] for r in values} == {"day": 1, "hour": 1}
        assert (await (await conn.execute("SELECT aggregate_revision FROM request_rollup_state")).fetchone())[
            "aggregate_revision"
        ] == 1


async def test_committed_flush_response_loss_same_observation_and_loss_count_once(app, db, monkeypatch):
    from contextlib import asynccontextmanager

    obs = app.state.request_observations
    for _ in range(2050):
        obs.record("/api/unknown-result/{rid}", "POST", "other", 503, 10)
    original = obs.db.connection

    @asynccontextmanager
    async def commit_then_disconnect():
        async with original() as conn:
            yield conn
        raise ConnectionError("synthetic post-commit connection loss")

    monkeypatch.setattr(obs.db, "connection", commit_then_disconnect)
    with pytest.raises(ConnectionError):
        await obs.flush()
    monkeypatch.setattr(obs.db, "connection", original)
    await obs.flush()
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM request_observations")).fetchone())[
            "n"
        ] == 512
        state = await (await conn.execute("SELECT * FROM request_rollup_state")).fetchone()
        assert state["lost"] == 2
    await obs.flush()
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM request_observations")).fetchone())[
            "n"
        ] == 1024
        assert (await (await conn.execute("SELECT lost FROM request_rollup_state")).fetchone())["lost"] == 2


async def test_detail_capacity_uses_actual_rows_despite_retried_identity_sequence_gaps(app, db):
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO request_observations(path,method,source,status,duration) SELECT '/api/capacity/{id}','GET','other',200,1 FROM generate_series(1,100001)"
        )
        await conn.execute("UPDATE request_rollup_state SET revision=100001,aggregate_revision=100001")
        key = (
            await (await conn.execute("SELECT observation_key FROM request_observations LIMIT 1")).fetchone()
        )["observation_key"]
        for _ in range(4):
            await conn.execute(
                "INSERT INTO request_observations(observation_key,path,method,source,status,duration) VALUES(%s,'/api/capacity/{id}','GET','other',200,1) ON CONFLICT(observation_key) DO NOTHING",
                (key,),
            )
    await rollup(db)
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM request_observations")).fetchone())[
            "n"
        ] == 100000
