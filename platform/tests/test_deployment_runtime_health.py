"""A matching image is not ready until its own version's Worker is fresh."""

from uuid import uuid4

import pytest
from alcor_api import __version__
from alcor_api import deployment_watchtower as bridge
from test_deployment_requests import P, configure


@pytest.mark.parametrize("worker", ["missing", "old_version", "stale", "ready"])
async def test_status_receipt_and_container_health_share_runtime_readiness(client, admin, app, monkeypatch, worker):
    release, _calls, _headers = configure(app, monkeypatch)
    app.state.settings.source_revision = release.revision
    original = uuid4()
    monkeypatch.setattr(bridge, "notify", lambda *_: pytest.fail("matching image must not be notified again"))
    async with app.state.db.connection() as conn:
        await conn.execute(
            "INSERT INTO deployment_requests(id,owner_id,request_id,image,version,revision,schema_hash,status) "
            "VALUES(%s,%s,%s,%s,%s,%s,%s,'unknown')",
            (uuid4(), admin, original, release.image, release.version, release.revision, release.schema_hash),
        )
        if worker != "missing":
            await conn.execute(
                "INSERT INTO worker_heartbeats(worker_id,version,observed_at) "
                "VALUES(%s,%s,clock_timestamp()-make_interval(secs => %s))",
                (uuid4(), "0.0.0" if worker == "old_version" else __version__, 60 if worker == "stale" else 0),
            )
    ready = worker == "ready"
    state = await client.get(P)
    assert state.status_code == 200, state.text
    assert state.json()["runtime_matches_release"] is True
    assert state.json()["runtime_ready"] is ready
    assert state.json()["matches_release"] is ready
    assert state.json()["can_update"] is False
    health = await client.get("/health/container")
    assert health.status_code == (200 if ready else 503)
    assert health.json()["status"] == ("ready" if ready else "worker_unavailable")
    expected = "succeeded" if ready else "unknown"
    receipt = await client.get(P + "/requests/" + str(original))
    assert receipt.json()["status"] == expected
    assert receipt.json()["request_id"] == str(original)
    replay = await client.post(P + "/requests", json={"request_id": str(original), "release": release.model_dump()})
    assert replay.status_code == 202 and replay.json()["status"] == expected
    assert (await client.post(P + "/requests", json={"request_id": str(uuid4()), "release": release.model_dump()})).status_code == 409
    async with app.state.db.connection() as conn:
        audit = await (await conn.execute(
            "SELECT count(*) AS n FROM audit_events WHERE action='deployment.succeeded' AND request_id=%s", (original,),
        )).fetchone()
    assert audit["n"] == int(ready)
