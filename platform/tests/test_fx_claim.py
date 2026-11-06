"""Provider permission, budget reservation and task claim have one PG commit boundary."""

import asyncio
from uuid import uuid4

import httpx
import pytest
from alcor_api.fx_service import ManagedFx
from psycopg.errors import CheckViolation
from test_fx_reference import RAW


@pytest.mark.asyncio
async def test_disable_committed_while_claim_waits_prevents_call_and_quota(db):
    async with db.connection() as conn:
        await conn.execute("UPDATE fx_config SET enabled=true")
    calls = []

    async def provider(request):
        calls.append(request)
        return httpx.Response(200, content=RAW)

    worker = ManagedFx(db, transport=httpx.MockTransport(provider))
    identifier = uuid4()
    await worker.submit("public:claim-test", identifier)
    async with db.connection() as blocker, blocker.transaction():
        await blocker.execute("SELECT revision FROM fx_config FOR UPDATE")
        running = asyncio.create_task(worker.once())
        async with db.connection() as observer:
            waiting = False
            for _ in range(100):
                waiting = (
                    await (
                        await observer.execute(
                            "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'"
                        )
                    ).fetchone()
                )["n"] > 0
                if waiting:
                    break
                await asyncio.sleep(0.01)
            assert waiting
        await blocker.execute("UPDATE fx_config SET enabled=false,revision=revision+1")
    assert await running == "disabled"
    assert calls == []
    assert (await worker.receipt("public:claim-test", identifier))["state"] == "queued"
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM fx_daily_usage")).fetchone())["n"] == 0


@pytest.mark.asyncio
async def test_claim_failure_rolls_back_reserved_quota_before_any_provider_call(db):
    async with db.connection() as conn:
        await conn.execute("UPDATE fx_config SET enabled=true")
        await conn.execute(
            "CREATE FUNCTION reject_test_fx_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='running' THEN RAISE EXCEPTION 'injected claim failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_test_fx_claim BEFORE UPDATE ON fx_refresh_tasks FOR EACH ROW EXECUTE FUNCTION reject_test_fx_claim()"
        )
    calls = []

    async def provider(request):
        calls.append(request)
        return httpx.Response(200, content=RAW)

    worker = ManagedFx(db, transport=httpx.MockTransport(provider))
    identifier = uuid4()
    await worker.submit("public:claim-test", identifier)
    with pytest.raises(CheckViolation):
        await worker.once()
    assert calls == []
    assert (await worker.receipt("public:claim-test", identifier))["state"] == "queued"
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM fx_daily_usage")).fetchone())["n"] == 0


@pytest.mark.asyncio
async def test_disabling_during_started_call_retains_original_without_new_quote(db):
    async with db.connection() as conn:
        await conn.execute("UPDATE fx_config SET enabled=true")
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []

    async def provider(request):
        calls.append(request)
        entered.set()
        await release.wait()
        return httpx.Response(200, content=RAW)

    worker = ManagedFx(db, transport=httpx.MockTransport(provider))
    identifier = uuid4()
    await worker.submit("public:claim-test", identifier)
    running = asyncio.create_task(worker.once())
    await entered.wait()
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT calls FROM fx_daily_usage")).fetchone())["calls"] == 1
        assert (await worker.receipt("public:claim-test", identifier))["state"] == "running"
        await conn.execute("UPDATE fx_config SET enabled=false,revision=revision+1")
    release.set()
    assert await running == "failed"
    receipt=await worker.receipt("public:claim-test",identifier)
    assert receipt['state']=='failed' and receipt['observation_id'] is None
    assert receipt['responseOriginal']['httpStatus']==200 and receipt['responseOriginal']['complete'] is True
    async with db.connection() as conn:
        page=await(await conn.execute('SELECT raw_bytes FROM fx_response_pages')).fetchone()
        assert bytes(page['raw_bytes'])==RAW
        assert (await(await conn.execute('SELECT count(*) n FROM fx_observations')).fetchone())['n']==0
    assert await worker.once() == "disabled"
    assert len(calls) == 1
