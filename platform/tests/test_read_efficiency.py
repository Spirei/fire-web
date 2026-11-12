"""Bounded PG logging and non-blocking metadata generation preserve read semantics."""
import asyncio

import pytest


async def test_observation_batch_is_pipelined_and_duplicate_retry_preserves_rows(db):
    from contextlib import asynccontextmanager
    from time import perf_counter

    from alcor_api.request_observability import Observations

    commands, batches = [], []

    class Counted:
        def __init__(self, conn):
            self.conn = conn

        def transaction(self):
            return self.conn.transaction()

        async def execute(self, query, params=None):
            commands.append(query)
            return await self.conn.execute(query, params)

        @asynccontextmanager
        async def cursor(self):
            async with self.conn.cursor() as cursor:
                class Cursor:
                    async def executemany(self, query, rows):
                        batches.append(len(rows))
                        return await cursor.executemany(query, rows)
                yield Cursor()

    class CountedDatabase:
        @asynccontextmanager
        async def connection(self):
            async with db.connection() as conn:
                yield Counted(conn)

    observations = Observations(CountedDatabase())
    for number in range(512):
        observations.record('/api/synthetic/{id}', 'GET', 'web', 200, number)
    original = list(observations.queue)
    started = perf_counter()
    await observations.flush()
    elapsed = perf_counter() - started
    assert batches == [512]
    assert not any('INSERT INTO request_observations(' in query for query in commands)
    observations.queue.extend(original)
    await observations.flush()
    assert batches == [512, 512]
    async with db.connection() as conn:
        stored = await (await conn.execute('SELECT count(*) AS count,sum(duration) AS duration FROM request_observations')).fetchone()
    assert stored['count'] == 512 and stored['duration'] == sum(range(512))
    print('ISOLATED_OBSERVATIONS', {'rows': 512, 'batches': 1, 'seconds': round(elapsed, 4)})


async def test_mid_batch_pg_failure_rolls_back_and_retries_the_same_observation_ids(db):
    from alcor_api.request_observability import Observations
    from psycopg.errors import RaiseException

    observations = Observations(db)
    for number in range(512):
        observations.record('/api/synthetic/{id}', 'GET', 'app', 200, number)
    original = list(observations.queue)
    async with db.connection() as conn:
        await conn.execute("""CREATE FUNCTION fail_observation() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.duration=250 THEN RAISE EXCEPTION 'synthetic log failure'; END IF; RETURN NEW; END $$""")
        await conn.execute('CREATE TRIGGER fail_observation BEFORE INSERT ON request_observations FOR EACH ROW EXECUTE FUNCTION fail_observation()')
    with pytest.raises(RaiseException):
        await observations.flush()
    assert list(observations.queue) == original
    assert observations.storage_available is False and observations.inflight == 0
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM request_observations')).fetchone())['n'] == 0
        assert (await (await conn.execute('SELECT revision FROM request_rollup_state')).fetchone())['revision'] == 0
        await conn.execute('DROP TRIGGER fail_observation ON request_observations')
    await observations.flush()
    async with db.connection() as conn:
        ids = await (await conn.execute('SELECT observation_key FROM request_observations ORDER BY id')).fetchall()
    assert [row['observation_key'] for row in ids] == [item[0] for item in original]
    assert not observations.queue and observations.storage_available is True


async def test_catalogue_generation_coalesces_and_does_not_block_or_cancel_other_readers(monkeypatch):
    import threading
    from types import SimpleNamespace

    from alcor_api import fire_api_surface

    entered, release = threading.Event(), threading.Event()
    calls = []

    def build(app):
        calls.append(app)
        entered.set()
        assert release.wait(3)
        return {'etag': 'synthetic'}

    monkeypatch.setattr(fire_api_surface, 'catalogue', build)
    app = SimpleNamespace(state=SimpleNamespace())
    first = asyncio.create_task(fire_api_surface.read_catalogue(app))
    assert await asyncio.to_thread(entered.wait, 2)
    second = asyncio.create_task(fire_api_surface.read_catalogue(app))
    await asyncio.sleep(0)
    first.cancel()
    try:
        await first
    except asyncio.CancelledError:
        pass
    assert len(calls) == 1 and not second.done(), 'the event loop remains responsive while generation is running'
    release.set()
    assert await second == {'etag': 'synthetic'}
    await asyncio.sleep(0)
    assert app.state.fire_api_catalogue_task is None


async def test_failed_catalogue_generation_releases_the_slot_for_explicit_retry(monkeypatch):
    from types import SimpleNamespace

    import pytest
    from alcor_api import fire_api_surface

    def broken(app):
        raise OSError('synthetic failure')

    monkeypatch.setattr(fire_api_surface, 'catalogue', broken)
    app = SimpleNamespace(state=SimpleNamespace())
    with pytest.raises(OSError):
        await fire_api_surface.read_catalogue(app)
    await asyncio.sleep(0)
    assert app.state.fire_api_catalogue_task is None
    monkeypatch.setattr(fire_api_surface, 'catalogue', lambda app: {'etag': 'retry'})
    assert await fire_api_surface.read_catalogue(app) == {'etag': 'retry'}
