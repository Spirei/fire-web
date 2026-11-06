import asyncio
from uuid import uuid4

import httpx
import pytest
from alcor_api.fx_service import ManagedFx
from alcor_api.market_calendar import BUILTIN_PATH
from fastapi import HTTPException
from test_fx_reference import RAW


@pytest.mark.asyncio
async def test_refresh_http_independent_worker_quota_and_receipt(client, db, settings, admin):
    async with db.connection() as conn:
        await conn.execute("UPDATE fx_config SET enabled=true,daily_budget=1")
    calls=[]
    async def provider(request):
        calls.append(request)
        return httpx.Response(200,content=RAW)
    worker=client._transport.app.state.reference_rates
    worker.transport=httpx.MockTransport(provider)
    identifier=str(uuid4())
    async with db.connection() as conn:
        before=await (await conn.execute("SELECT (SELECT count(*) FROM fx_requests) requests,(SELECT count(*) FROM fx_refresh_tasks) tasks,(SELECT coalesce(sum(calls),0) FROM fx_daily_usage) used")).fetchone()
    read=await client.get("/api/v2/rates?refresh=1",headers={"x-request-id":identifier})
    assert read.status_code==200 and read.json()['data']['updatedAt'] is None
    assert read.headers['x-alcor-rates-refresh-state']=='explicit_post_required'
    async with db.connection() as conn:
        assert await (await conn.execute("SELECT (SELECT count(*) FROM fx_requests) requests,(SELECT count(*) FROM fx_refresh_tasks) tasks,(SELECT coalesce(sum(calls),0) FROM fx_daily_usage) used")).fetchone()==before
    queued=await client.post("/api/reference/rates/refresh",json={"requestId":identifier})
    assert queued.status_code==202,queued.text
    assert await worker.once()=="completed"
    response=await client.get("/api/v2/rates")
    assert response.status_code==200 and response.json()['data']['rates']['JPY']>150
    assert (await client.post("/api/reference/rates/refresh",json={"requestId":identifier})).status_code==202
    assert len(calls)==1
    receipt=await client.get("/api/reference/rates/operations/"+identifier)
    assert receipt.json()['state']=='completed'
    assert (await client.get("/api/v2/rates",headers={"authorization":"Bearer bad"})).status_code==401
    assert (await client.get("/api/rates")).status_code==401
    second=str(uuid4())
    await worker.submit("public:127.0.0.1",second)
    assert await worker.once()=="budget_exhausted"
    assert (await worker.receipt("public:127.0.0.1",second))['error_code']=='daily_budget'
    assert len(calls)==1
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM audit_events WHERE action LIKE 'reference.fx.%'")).fetchone())['n']>=3


@pytest.mark.asyncio
async def test_coalesced_requests_rate_limit_and_cross_principal(db):
    async with db.connection() as conn:
        await conn.execute("SELECT 1")
        await conn.execute("UPDATE fx_config SET enabled=true")
    worker = ManagedFx(db)
    ids = [uuid4() for _ in range(10)]
    tasks = [await worker.submit("actor", i) for i in ids]
    assert len(set(tasks)) == 1
    with pytest.raises(HTTPException) as limited:
        await worker.submit("actor", uuid4())
    assert limited.value.status_code == 429
    with pytest.raises(HTTPException):
        await worker.receipt("foreign", ids[0])
    assert await worker.submit("actor", ids[0]) == tasks[0]


@pytest.mark.asyncio
async def test_real_platform_configuration_auth_csrf_and_calendar(client, db, settings):
    async with db.connection() as conn:
        await conn.execute("SELECT 1")
    import hashlib

    from alcor_api.market_calendar import Calendars

    raw = BUILTIN_PATH.read_bytes()
    await Calendars(db).import_release(raw, hashlib.sha256(raw).hexdigest())
    full = await client.get("/api/v2/market-calendar/batch?year=2026")
    assert full.status_code == 200
    assert (await client.get("/api/reference/calendar/discovery")).json()["schema_version"] == 1
    endpoint = "/api/reference/rates/provider"
    assert (await client.get(endpoint)).status_code == 401
    signup = await client.post(
        "/api/session/register",
        json={"username": "ReferenceAdmin", "password": "SyntheticReferencePassword9"},
    )
    assert signup.status_code == 201
    from alcor_api.security import COOKIE, csrf_token

    csrf = csrf_token(client.cookies.get(COOKIE))
    body = {"enabled": True, "dailyBudget": 3, "revision": 1}
    assert (await client.put(endpoint, json=body)).status_code == 403
    saved = await client.put(
        endpoint, json=body, headers={"x-csrf-token": csrf, "origin": settings.public_origin}
    )
    assert saved.status_code == 200, saved.text
    assert (
        await client.put(
            endpoint, json=body, headers={"x-csrf-token": csrf, "origin": settings.public_origin}
        )
    ).status_code == 409
    assert (
        await client.get(
            "/api/v2/market-calendar?market=US&year=2026", headers={"authorization": "Bearer invalid"}
        )
    ).status_code == 401
    assert (
        await client.get(
            "/api/v2/market-calendar?market=US&year=2026", headers={"origin": "https://foreign.invalid"}
        )
    ).status_code == 403
    client.cookies.clear()
    await client.post(
        "/api/session/register", json={"username": "ReferenceUser", "password": "SyntheticReferencePassword9"}
    )
    assert (await client.get(endpoint)).status_code == 403


@pytest.mark.asyncio
async def test_multiworker_singleflight_and_failed_atomic_commit(db):
    from psycopg.errors import RaiseException

    async with db.connection() as conn:
        await conn.execute("SELECT 1")
        await conn.execute("UPDATE fx_config SET enabled=true")
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = []

    async def provider(request):
        calls.append(request)
        entered.set()
        await release.wait()
        return httpx.Response(200, content=RAW)

    first = ManagedFx(db, transport=httpx.MockTransport(provider))
    second = ManagedFx(db, transport=httpx.MockTransport(provider))
    identifier = uuid4()
    await first.submit("actor", identifier)
    pending = asyncio.create_task(first.once())
    await entered.wait()
    assert await second.once() == "busy"
    release.set()
    assert await pending == "completed"
    assert len(calls) == 1
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT sum(calls) AS n FROM fx_daily_usage")).fetchone())["n"] == 1
        await conn.execute(
            "CREATE FUNCTION reject_fx_value() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic write failure'; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_fx_value BEFORE INSERT ON fx_values FOR EACH ROW EXECUTE FUNCTION reject_fx_value()"
        )
    changed = RAW.replace(b"150.12345678901234", b"151.12345678901234")
    broken = ManagedFx(
        db, transport=httpx.MockTransport(lambda request: httpx.Response(200, content=changed))
    )
    broken_id = uuid4()
    await broken.submit("actor", broken_id)
    with pytest.raises(RaiseException):
        await broken.once()
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM fx_observations")).fetchone())["n"] == 1
        await conn.execute(
            "UPDATE fx_refresh_tasks SET started_at=clock_timestamp()-interval '3 minutes' WHERE state='running'"
        )
    await broken.recover_interrupted()
    assert (await broken.receipt("actor", broken_id))["state"] == "interrupted"
    assert await broken.once() == "idle"


@pytest.mark.asyncio
async def test_slow_provider_total_deadline_keeps_original_failed_receipt(db):
    async with db.connection() as conn:
        await conn.execute("SELECT 1")
        await conn.execute("UPDATE fx_config SET enabled=true")

    async def slow(request):
        await asyncio.sleep(1)
        return httpx.Response(200, content=RAW)

    worker = ManagedFx(db, transport=httpx.MockTransport(slow), request_timeout=0.01)
    identifier = uuid4()
    await worker.submit("actor", identifier)
    assert await worker.once() == "failed"
    assert (await worker.receipt("actor", identifier))["state"] == "failed"
    assert await worker.submit("actor", identifier)
    assert await worker.once() == "idle"


@pytest.mark.asyncio
async def test_new_web_canonical_reference_refresh_disabled_receipt(client, db, settings):
    async with db.connection() as conn:
        await conn.execute("SELECT 1")
    assert (await client.get("/api/reference/rates")).status_code == 401
    await client.post(
        "/api/session/register",
        json={"username": "ReferenceViewer", "password": "SyntheticReferencePassword9"},
    )
    from alcor_api.security import COOKIE, csrf_token

    headers = {"origin": settings.public_origin, "x-csrf-token": csrf_token(client.cookies.get(COOKIE))}
    read = await client.get("/api/reference/rates")
    assert read.json()["rates"] == {"USD": "1"} and read.json()["refreshEnabled"] is False
    identifier = str(uuid4())
    denied = await client.post("/api/reference/rates/refresh", json={"requestId": identifier})
    assert denied.status_code == 403
    submitted = await client.post(
        "/api/reference/rates/refresh", json={"requestId": identifier}, headers=headers
    )
    assert submitted.status_code == 202 and submitted.json()["state"] == "failed"
    receipt = await client.get("/api/reference/rates/operations/" + identifier)
    assert receipt.status_code == 200 and receipt.json()["error_code"] == "provider_disabled"
    assert (
        await client.post("/api/reference/rates/refresh", json={"requestId": identifier}, headers=headers)
    ).json() == submitted.json()


@pytest.mark.asyncio
@pytest.mark.parametrize("version", [None, 1, 2])
async def test_legacy_rates_refresh_flag_reads_without_task_or_budget(client, db, settings, version):
    from datetime import UTC, datetime

    from alcor_api.fx_reference import persist
    if version is None:
        result=await client.post("/api/auth/register",json={"username":"LegacyFxReader","password":"SyntheticReferencePassword9"})
        assert result.status_code==201
    async with db.connection() as conn:
        await conn.execute("UPDATE fx_config SET enabled=true")
        await persist(conn,RAW,datetime(2026,1,3,tzinfo=UTC),uuid4())
        before=await (await conn.execute("SELECT (SELECT count(*) FROM fx_requests) requests,(SELECT count(*) FROM fx_refresh_tasks) tasks,(SELECT coalesce(sum(calls),0) FROM fx_daily_usage) used")).fetchone()
    path="/api/rates" if version is None else f"/api/v{version}/rates"
    response=await client.get(path+"?refresh=1",headers={"x-request-id":str(uuid4())})
    assert response.status_code==200,response.text
    assert response.headers['x-alcor-rates-refresh-method']=='POST'
    assert response.headers['x-alcor-rates-refresh-state']=='explicit_post_required'
    value=response.json() if version is None else response.json()['data']
    assert value['base']=='USD' and value['quoted']==['USD','HKD','JPY']
    assert value['updatedAt']>0 and 'CNY' not in value['rates']
    async with db.connection() as conn:
        assert await (await conn.execute("SELECT (SELECT count(*) FROM fx_requests) requests,(SELECT count(*) FROM fx_refresh_tasks) tasks,(SELECT coalesce(sum(calls),0) FROM fx_daily_usage) used")).fetchone()==before
    assert (await client.get(path)).status_code==200


@pytest.mark.asyncio
async def test_worker_uses_one_verified_connection_and_seeds_without_fetch(db, settings):
    from alcor_api.db import Database
    from alcor_api.fx_service import run_reference_worker
    from alcor_api.market_calendar import Calendars

    calls = []

    async def provider(request):
        calls.append(request)
        return httpx.Response(200, content=RAW)

    stop = asyncio.Event()
    task = asyncio.create_task(run_reference_worker(db, stop, transport=httpx.MockTransport(provider)))
    for _ in range(100):
        if await Calendars(db).discovery():
            break
        await asyncio.sleep(0.01)
    stop.set()
    await task
    assert await Calendars(db).discovery()
    assert calls == []
    single = Database(settings.model_copy(update={"pool_size": 1, "pool_min_size": 1}))
    await single.open()
    try:
        async with db.connection() as conn:
            await conn.execute("UPDATE fx_config SET enabled=true")
        worker = ManagedFx(single, transport=httpx.MockTransport(provider))
        await worker.submit("synthetic", uuid4())
        assert await worker.once() == "completed"
    finally:
        await single.close()


@pytest.mark.asyncio
async def test_submit_rechecks_session_after_waiting_for_global_lock(client, admin, db):
    from alcor_api.security import COOKIE, Identity, digest

    token_hash = digest(client.cookies.get(COOKIE))
    async with db.connection() as conn:
        row = await (
            await conn.execute(
                "SELECT u.id,u.username,u.role,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=%s",
                (token_hash,),
            )
        ).fetchone()
        await conn.execute("UPDATE fx_config SET enabled=true")
    who = Identity(**row, token_hash=token_hash, csrf="")
    service = ManagedFx(db)
    async with db.connection() as blocker, blocker.transaction():
        await blocker.execute("SELECT pg_advisory_xact_lock(hashtextextended('fx-requests',0))")
        pending = asyncio.create_task(service.submit("user:" + admin, uuid4(), admin, authorization=who))
        await asyncio.sleep(0.03)
        assert not pending.done()
        async with db.connection() as revoke:
            await revoke.execute("DELETE FROM sessions WHERE token_hash=%s", (token_hash,))
    with pytest.raises(HTTPException) as denied:
        await pending
    assert denied.value.status_code == 401
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM fx_refresh_tasks")).fetchone())["n"] == 0


@pytest.mark.asyncio
async def test_restore_quarantine_blocks_submit_and_all_worker_paths(db):
    from alcor_api.fx_reference import FxWorker

    calls = []

    async def provider(request):
        calls.append(request)
        return httpx.Response(200, content=RAW)

    service = ManagedFx(db, transport=httpx.MockTransport(provider))
    async with db.connection() as conn:
        await conn.execute("UPDATE fx_config SET enabled=true")
    identifier = uuid4()
    await service.submit("public:synthetic", identifier)
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO restore_quarantine(category,payload) VALUES('external_delivery_disabled','{\"disabled\":true}'::jsonb)"
        )
    with pytest.raises(HTTPException) as blocked:
        await service.submit("public:synthetic", uuid4())
    assert blocked.value.status_code == 503
    assert await service.once() == "quarantined"
    assert await FxWorker(db, enabled=True, transport=httpx.MockTransport(provider)).once() == "quarantined"
    assert calls == []
    assert (await service.receipt("public:synthetic", identifier))["state"] == "queued"
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM fx_daily_usage")).fetchone())["n"] == 0


@pytest.mark.asyncio
async def test_invalid_receipt_uuid_is_client_error(client, admin, db, settings):
    assert (await client.get("/api/reference/rates/operations/not-a-uuid")).status_code == 400


@pytest.mark.asyncio
async def test_submit_rechecks_revoked_native_grant_after_lock_wait(client, admin, db):
    from alcor_api.native_app_auth import authenticate, identity_from_grant, issue_grant

    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (admin,))).fetchone()
        pair = await issue_grant(conn, user, "portfolio.read", "Synthetic reference reader")
        grant = await authenticate(conn, pair["access_token"])
        await conn.execute("UPDATE fx_config SET enabled=true")
    who = identity_from_grant(grant, pair["access_token"])
    service = ManagedFx(db)
    async with db.connection() as blocker, blocker.transaction():
        await blocker.execute("SELECT pg_advisory_xact_lock(hashtextextended('fx-requests',0))")
        pending = asyncio.create_task(service.submit("user:" + admin, uuid4(), admin, authorization=who))
        await asyncio.sleep(0.03)
        assert not pending.done()
        async with db.connection() as conn:
            await conn.execute(
                "UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s", (who.grant_id,)
            )
    with pytest.raises(HTTPException) as denied:
        await pending
    assert denied.value.status_code == 401
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM fx_requests")).fetchone())["n"] == 0


@pytest.mark.asyncio
async def test_original_receipt_observation_survives_newer_global_quote(client, admin, db):
    from datetime import timedelta

    from alcor_api.fx_reference import persist

    async with db.connection() as conn:
        await conn.execute("UPDATE fx_config SET enabled=true")
    service = client._transport.app.state.reference_rates
    service.transport = httpx.MockTransport(lambda request: httpx.Response(200, content=RAW))
    request_id = str(uuid4())
    submitted = await client.post("/api/reference/rates/refresh", json={"requestId": request_id})
    assert submitted.status_code == 202, submitted.text
    assert await service.once() == "completed"
    receipt = (await client.get("/api/reference/rates/operations/" + request_id)).json()
    first_id = receipt["observation_id"]
    second_id = uuid4()
    async with db.connection() as conn, conn.transaction():
        received = (
            await (
                await conn.execute("SELECT received_at FROM fx_observations WHERE id=%s", (first_id,))
            ).fetchone()
        )["received_at"]
        await persist(
            conn,
            RAW.replace(b"150.12345678901234", b"160.12345678901234"),
            received + timedelta(hours=1),
            second_id,
        )
    assert (await client.get("/api/reference/rates/operations/" + request_id)).json() == receipt
    original = await client.get("/api/reference/rates", params={"observationId": str(first_id)})
    latest = await client.get("/api/reference/rates")
    assert original.status_code == 200 and latest.status_code == 200
    assert original.json()["rates"]["JPY"] == "150.12345678901234"
    assert latest.json()["rates"]["JPY"] == "160.12345678901234"
    assert original.json()["updatedAt"] == int(received.timestamp() * 1000)
    assert (
        await client.get("/api/reference/rates", params={"observationId": str(uuid4())})
    ).status_code == 404
    assert (await client.get("/api/reference/rates", params={"observationId": "invalid"})).status_code == 422


@pytest.mark.asyncio
async def test_v1_rates_accepts_legacy_session_bearer_without_cookie(client, db):
    from alcor_api.legacy_identity import WEB_COOKIE

    await client.post(
        "/api/auth/register",
        json={"username": "LegacyBearerRates", "password": "SyntheticReferencePassword9"},
    )
    token = client.cookies.get(WEB_COOKIE)
    assert token
    client.cookies.clear()
    async with db.connection() as conn:
        await conn.execute("UPDATE fx_config SET enabled=true")
    service = client._transport.app.state.reference_rates
    service.transport = httpx.MockTransport(lambda request: httpx.Response(200, content=RAW))
    request_id = str(uuid4())
    from datetime import UTC, datetime

    from alcor_api.fx_reference import persist
    async with db.connection() as conn:
        await persist(conn,RAW,datetime(2026,1,3,tzinfo=UTC),uuid4())
        before=await (await conn.execute("SELECT count(*) AS n FROM fx_refresh_tasks")).fetchone()
    response=await client.get("/api/v1/rates?refresh=1",headers={"authorization":"Bearer "+token,"x-request-id":request_id})
    assert response.headers['x-alcor-rates-refresh-state']=='explicit_post_required'
    async with db.connection() as conn:
        assert await (await conn.execute("SELECT count(*) AS n FROM fx_refresh_tasks")).fetchone()==before
    assert response.status_code == 200, response.text
    assert response.json()["data"]["quoted"] == ["USD", "HKD", "JPY"]
    assert (
        await client.get("/api/v2/rates", headers={"authorization": "Bearer " + token})
    ).status_code == 401
    # Old v1's public snapshot GET does not inspect Authorization; explicit
    # refresh flags also remain a pure public read; only explicit POST queues work.
    assert (await client.get("/api/v1/rates", headers={"authorization": "Bearer "})).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,raw,headers",
    [(302, b"", {"location": "http://localhost/private"}), (200, b"x" * 131073, {}), (200, b"{}", {})],
)
async def test_provider_failure_is_terminal_without_partial_quote_or_auto_retry(db, status, raw, headers):
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(status, content=raw, headers=headers)

    async with db.connection() as conn:
        await conn.execute("UPDATE fx_config SET enabled=true")
    worker = ManagedFx(db, transport=httpx.MockTransport(respond))
    identifier = uuid4()
    await worker.submit("public:synthetic", identifier)
    assert await worker.once() == "failed"
    assert (await worker.receipt("public:synthetic", identifier))["state"] == "failed"
    await worker.submit("public:synthetic", identifier)
    assert await worker.once() == "idle" and len(calls) == 1
    assert (await worker.snapshot())["quoted"] == []
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT sum(calls) AS n FROM fx_daily_usage")).fetchone())["n"] == 1
        assert (await (await conn.execute("SELECT count(*) AS n FROM fx_observations")).fetchone())["n"] == 0
