import asyncio
from datetime import UTC, datetime
from uuid import uuid4

import pytest


@pytest.mark.usefixtures("fx_target_policy")
@pytest.mark.asyncio
async def test_real_main_custom_configuration_refresh_receipt(client, admin, app, db, monkeypatch):
    # Existing main calls candidate mount_rates through its actual import.
    verified = await client.post(
        "/api/reference/rates/provider/reauthenticate", json={"password": "Synthetic9Pass"}
    )
    assert verified.status_code == 204, verified.text
    custom = {
        "url": "http://provider.example/rates?token=synthetic-only",
        "approval": {
            "target": ["http", "provider.example", 80, "/rates"],
            "addresses": ["192.0.2.20"],
            "allow_plaintext": True,
        },
        "declared_base": "EUR",
        "time_field": "data.timestamp",
        "time_precision": "epoch_seconds",
        "schedule": {"pattern": "09:00|23:00", "timezone": "Asia/Shanghai"},
    }
    result = await client.put(
        "/api/reference/rates/provider",
        json={"enabled": True, "dailyBudget": 5, "revision": 1, "custom": custom},
    )
    assert result.status_code == 200, result.text
    config = await client.get("/api/reference/rates/provider")
    assert "synthetic-only" not in config.text
    empty = (await client.get("/api/reference/rates")).json()
    assert empty["quoted"] == [] and empty["source"] == "custom"
    assert empty["observationDate"] is None and empty["updatedAt"] is None
    service = app.state.reference_rates
    calls = []

    async def requester(url, approval, headers):
        calls.append(url)
        return b'{"data":{"base":"EUR","rates":{"USD":1.2,"JPY":180},"timestamp":"1700000000"}}'

    service.custom_requester = requester
    rid = str(uuid4())
    result = await client.post("/api/reference/rates/refresh", json={"requestId": rid})
    assert result.status_code == 202, result.text
    assert await service.once() == "completed"
    receipt = (await client.get("/api/reference/rates/operations/" + rid)).json()
    assert receipt["state"] == "completed"
    value = (await client.get("/api/reference/rates?observationId=" + receipt["observation_id"])).json()
    assert value["exactRatios"]["EUR"] == {"numerator": "5", "denominator": "6"}
    assert value["sourcePrecision"] == "instant" and value["observationDate"] is None
    assert value["rates"]["JPY"] == "150"
    assert len(calls) == 1 and "synthetic-only" in calls[0]
    async with db.connection() as conn:
        source = await (
            await conn.execute(
                "SELECT source_uri FROM fx_observations WHERE id=%s", (receipt["observation_id"],)
            )
        ).fetchone()
        assert source["source_uri"] == "http://provider.example/[redacted]"
        audits = await (await conn.execute("SELECT target_id FROM audit_events")).fetchall()
        assert "synthetic-only" not in str(audits)

    assert (
        await client.post(
            "/api/auth/register", json={"username": "LegacyCustomReader", "password": "SyntheticReaderPass9"}
        )
    ).status_code == 201
    for path in ("/api/rates", "/api/v1/rates", "/api/v2/rates"):
        response = await client.get(path)
        assert response.status_code == 200, response.text
        legacy = response.json() if path == "/api/rates" else response.json()["data"]
        assert legacy["rates"]["EUR"] == pytest.approx(5 / 6)
        assert legacy["rates"]["JPY"] == 150 and "MOP" not in legacy["quoted"]

    import alcor_api.fx_schedule as schedule_module

    async def forbidden_compile(*args):
        raise AssertionError("Worker must not compile regex")

    monkeypatch.setattr(schedule_module, "compile_schedule", forbidden_compile)
    outcomes = await asyncio.gather(
        service.schedule_tick(datetime(2026, 1, 1, 1, 0, tzinfo=UTC)),
        service.schedule_tick(datetime(2026, 1, 1, 1, 0, tzinfo=UTC)),
    )
    assert sorted(outcomes) == ["queued", "recorded"]
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM fx_schedule_firings")).fetchone())[
            "n"
        ] == 1


@pytest.mark.asyncio
async def test_legacy_regex_slots():
    from alcor_api.fx_schedule import compile_schedule, current_slot

    schedule = await compile_schedule("/^([01]\\d|2[0-3]):00$/g", "UTC")
    assert len(schedule["slots"]) == 24
    assert len((await compile_schedule(".*", "UTC"))["slots"]) == 96
    assert (await compile_schedule("[", "UTC"))["slots"] == ["09:00", "23:00"]
    assert current_slot(schedule, datetime(2026, 1, 1, 1, 0, tzinfo=UTC))[1] == "01:00"


@pytest.mark.usefixtures("fx_target_policy")
@pytest.mark.asyncio
async def test_expensive_pattern_timeout_does_not_save(client, admin, db):
    import time

    assert (
        await client.post("/api/reference/rates/provider/reauthenticate", json={"password": "Synthetic9Pass"})
    ).status_code == 204
    custom = {
        "url": "https://provider.example/rates",
        "approval": {"target": ["https", "provider.example", 443, "/rates"], "addresses": ["192.0.2.20"]},
        "declared_base": "USD",
        "schedule": {"pattern": "(?:.{0,5}){1000000000}Z", "timezone": "UTC"},
    }
    started = time.monotonic()
    result = await client.put(
        "/api/reference/rates/provider",
        json={"enabled": True, "dailyBudget": 5, "revision": 1, "custom": custom},
    )
    assert result.status_code == 400, result.text
    assert time.monotonic() - started < 4
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT revision,enabled FROM fx_config")).fetchone()) == {
            "revision": 1,
            "enabled": False,
        }
        assert (await (await conn.execute("SELECT count(*) AS n FROM fx_provider_revisions")).fetchone())[
            "n"
        ] == 0


@pytest.mark.usefixtures("fx_target_policy")
@pytest.mark.asyncio
async def test_old_receipt_after_provider_switch_and_quarantine(client, admin, app, db):
    assert (
        await client.post("/api/reference/rates/provider/reauthenticate", json={"password": "Synthetic9Pass"})
    ).status_code == 204
    custom = {
        "url": "https://provider.example/rates",
        "approval": {"target": ["https", "provider.example", 443, "/rates"], "addresses": ["192.0.2.20"]},
        "declared_base": "USD",
    }
    assert (
        await client.put(
            "/api/reference/rates/provider",
            json={"enabled": True, "dailyBudget": 5, "revision": 1, "custom": custom},
        )
    ).status_code == 200
    service = app.state.reference_rates

    async def request(*args):
        return b'{"rates":{"HKD":"7.8"}}'

    service.custom_requester = request
    rid = str(uuid4())
    assert (await client.post("/api/reference/rates/refresh", json={"requestId": rid})).status_code == 202
    assert await service.once() == "completed"
    receipt = (await client.get("/api/reference/rates/operations/" + rid)).json()
    old = (await client.get("/api/reference/rates?observationId=" + receipt["observation_id"])).json()
    assert old["sourcePrecision"] == "unknown" and old["observationDate"] is None
    assert (
        await client.put(
            "/api/reference/rates/provider",
            json={"enabled": False, "dailyBudget": 5, "revision": 2, "custom": {"type": "builtin"}},
        )
    ).status_code == 200
    assert (await client.get("/api/reference/rates")).json()["quoted"] == []
    recovered = (await client.get("/api/reference/rates?observationId=" + receipt["observation_id"])).json()
    assert recovered["rates"] == old["rates"] and recovered["updatedAt"] == old["updatedAt"]
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO restore_quarantine(category,payload) VALUES('external_delivery_disabled','{\"disabled\":true}')"
        )
        await conn.execute("UPDATE fx_config SET enabled=true")
    assert await service.once() == "quarantined"
    assert (
        await client.post("/api/reference/rates/refresh", json={"requestId": str(uuid4())})
    ).status_code == 503


@pytest.mark.usefixtures("fx_target_policy")
@pytest.mark.asyncio
async def test_client_cannot_self_approve_target(client, admin, app):
    assert (
        await client.post("/api/reference/rates/provider/reauthenticate", json={"password": "Synthetic9Pass"})
    ).status_code == 204
    custom = {
        "url": "http://unapproved.example/rates",
        "approval": {
            "target": ["http", "unapproved.example", 80, "/rates"],
            "addresses": ["127.0.0.1"],
            "allow_plaintext": True,
        },
        "declared_base": "USD",
    }
    denied = await client.put(
        "/api/reference/rates/provider",
        json={"enabled": True, "dailyBudget": 5, "revision": 1, "custom": custom},
    )
    assert denied.status_code == 403
    assert (
        await client.post("/api/reference/rates/refresh", json={"requestId": str(uuid4()), "custom": custom})
    ).status_code == 400


@pytest.mark.usefixtures("fx_target_policy")
@pytest.mark.asyncio
async def test_provider_switch_cancels_queued_retains_response_without_new_quote(client, admin, app, db):
    assert (
        await client.post("/api/reference/rates/provider/reauthenticate", json={"password": "Synthetic9Pass"})
    ).status_code == 204
    custom = {
        "url": "https://provider.example/rates",
        "approval": {"target": ["https", "provider.example", 443, "/rates"], "addresses": ["192.0.2.20"]},
        "declared_base": "USD",
    }
    assert (
        await client.put(
            "/api/reference/rates/provider",
            json={"enabled": True, "dailyBudget": 5, "revision": 1, "custom": custom},
        )
    ).status_code == 200
    queued = str(uuid4())
    await client.post("/api/reference/rates/refresh", json={"requestId": queued})
    assert (
        await client.put(
            "/api/reference/rates/provider",
            json={"enabled": True, "dailyBudget": 5, "revision": 2, "custom": custom},
        )
    ).status_code == 200
    receipt = (await client.get("/api/reference/rates/operations/" + queued)).json()
    assert receipt["state"] == "failed" and receipt["error_code"] == "provider_changed"
    started = asyncio.Event()
    release = asyncio.Event()

    async def requester(*args):
        started.set()
        await release.wait()
        return b'{"rates":{"HKD":7.8}}'

    service = app.state.reference_rates
    service.custom_requester = requester
    running = str(uuid4())
    await client.post("/api/reference/rates/refresh", json={"requestId": running})
    work = asyncio.create_task(service.once())
    await asyncio.wait_for(started.wait(), 2)
    assert (
        await client.put(
            "/api/reference/rates/provider",
            json={"enabled": True, "dailyBudget": 5, "revision": 3, "custom": {"type": "builtin"}},
        )
    ).status_code == 200
    release.set()
    assert await work == "failed"
    receipt = (await client.get("/api/reference/rates/operations/" + running)).json()
    assert receipt['state']=='failed' and receipt['observation_id'] is None
    assert receipt['responseOriginal']['complete'] is True
    assert (await client.get('/api/reference/rates')).json()['quoted']==[]
    kept=await client.post(receipt['responseOriginal']['downloadPath'],json={'password':'Synthetic9Pass'})
    assert kept.status_code==200 and kept.content==b'{"rates":{"HKD":7.8}}'
    assert (await client.post('/api/reference/rates/refresh',json={'requestId':running})).status_code==202
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM fx_observations')).fetchone())['n']==0
        page=await(await conn.execute('SELECT provider_revision FROM fx_response_pages')).fetchone()
        assert page['provider_revision'] is not None


async def test_malformed_reference_write_body_is_rejected_without_mutation(client, admin, db):
    for method, path in (("PUT", "/api/reference/rates/provider"), ("POST", "/api/reference/rates/refresh")):
        response = await client.request(
            method, path, content=b'{"broken":', headers={"Content-Type": "application/json"}
        )
        assert response.status_code == 400
    async with db.connection() as conn:
        assert await (await conn.execute("SELECT 1 FROM fx_provider_revisions")).fetchone() is None
        assert await (await conn.execute("SELECT 1 FROM fx_requests")).fetchone() is None
        assert await (await conn.execute("SELECT enabled,revision FROM fx_config")).fetchone() == {
            "enabled": False,
            "revision": 1,
        }
