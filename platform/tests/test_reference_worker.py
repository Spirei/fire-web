import asyncio

import pytest
from alcor_api.fx_service import ReferenceReadiness, run_reference_worker
from alcor_api.market_calendar import Calendars


@pytest.mark.asyncio
async def test_invalid_builtin_never_renews_worker_heartbeat(settings, monkeypatch):
    from alcor_api import worker

    beats = []

    async def invalid(self):
        raise ValueError("synthetic invalid release")

    async def heartbeat(*args):
        beats.append(args)

    monkeypatch.setattr(Calendars, "ensure_builtin", invalid)
    monkeypatch.setattr(worker, "heartbeat", heartbeat)
    monkeypatch.setattr(asyncio.get_running_loop(), "add_signal_handler", lambda *args: None)
    with pytest.raises(ValueError, match="synthetic invalid release"):
        await asyncio.wait_for(worker.run(settings, asyncio.Event()), 3)
    assert beats == []


@pytest.mark.asyncio
async def test_reference_readiness_follows_verified_database_pool_generation(db, settings, monkeypatch):
    calls = []
    original = Calendars.ensure_builtin

    async def observe(self):
        calls.append(self.db.pool)
        return await original(self)

    monkeypatch.setattr(Calendars, "ensure_builtin", observe)
    stop = asyncio.Event()
    state = ReferenceReadiness()
    task = asyncio.create_task(run_reference_worker(db, stop, readiness=state))
    try:
        await asyncio.wait_for(state.ready.wait(), 2)
        assert state.current(db)
        previous = db.pool
        await db.replace(settings)
        assert db.pool is not previous and not state.current(db)
        for _ in range(150):
            if state.current(db):
                break
            await asyncio.sleep(0.01)
        assert state.current(db) and len(calls) >= 2 and calls[-1] is db.pool
    finally:
        stop.set()
        await task


async def test_main_and_readiness_share_heartbeat_and_resume_after_pool_change(db, settings, monkeypatch):
    from alcor_api import worker
    from uuid import uuid4
    now = [100.0]
    monkeypatch.setattr(worker, 'monotonic', lambda: now[0])
    identifier = uuid4()
    async def observed():
        async with db.connection() as conn:
            return (await (await conn.execute('SELECT observed_at FROM worker_heartbeats WHERE worker_id=%s', (identifier,))).fetchone())['observed_at']
    await asyncio.gather(*(worker.heartbeat(db, identifier) for _ in range(8)))
    first = await observed()
    await worker.heartbeat(db, identifier)
    assert await observed() == first
    now[0] += 5
    await worker.heartbeat(db, identifier)
    second = await observed()
    assert second > first
    await db.replace(settings)
    await worker.heartbeat(db, identifier)
    assert await observed() > second
