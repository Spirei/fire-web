"""Numeric-only per-request timing, streaming semantics and real PG diagnostics."""
import asyncio
import re

import httpx
import pytest
from alcor_api import request_timing
from alcor_api.request_observability import ObserveRequests
from fastapi import FastAPI
from fastapi.responses import StreamingResponse


class Records:
    def __init__(self):
        self.items = []

    def record(self, *args):
        self.items.append(args)


async def test_concurrent_timings_are_local_and_do_not_capture_query_or_identifiers():
    app = FastAPI()
    records = Records()

    @app.get('/api/measure/{count}')
    async def read(count: int):
        for _ in range(count):
            with request_timing.measure('sql_execute', statement=True):
                await asyncio.sleep(0)
        return {'ok': True}

    app.add_middleware(ObserveRequests, observations=records, routes=app.routes)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://testserver') as client:
        first, second = await asyncio.gather(client.get('/api/measure/1?secret=must-not-appear'), client.get('/api/measure/3'))
    assert '1 statements' in first.headers['server-timing']
    assert '3 statements' in second.headers['server-timing']
    assert 'secret' not in first.headers['server-timing']
    assert all(item[0] == '/api/measure/{count}' for item in records.items)
    assert request_timing.start() is None


async def test_stream_headers_only_describe_first_byte_and_cancellation_cleans_context():
    records = Records()
    app = FastAPI()

    @app.get('/api/stream')
    async def stream():
        async def body():
            yield 'first'
            with request_timing.measure('sql_execute', statement=True):
                await asyncio.sleep(0)
            yield 'last'
        return StreamingResponse(body())

    app.add_middleware(ObserveRequests, observations=records, routes=app.routes)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://testserver') as client:
        response = await client.get('/api/stream')
    assert response.text == 'firstlast'
    assert 'backend_ttfb' in response.headers['server-timing']
    assert 'sql_execute' not in response.headers['server-timing'], 'later body work is not mislabeled as time to first byte'
    ready = asyncio.Event()

    async def blocked(scope, receive, send):
        ready.set()
        await asyncio.Event().wait()

    middleware = ObserveRequests(blocked, records, [])
    async def unused(*args):
        pass
    task = asyncio.create_task(middleware({'type': 'http', 'path': '/api/cancelled', 'method': 'GET'}, unused, unused))
    await ready.wait()
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert records.items[-1][3] == 499
    assert request_timing.start() is None


async def test_actual_pg_read_reports_pool_guard_and_sql_without_sensitive_values(client, admin):
    login = await client.post('/api/auth/login', json={'username': 'AdminOne', 'password': 'Synthetic9Pass'})
    assert login.status_code == 200
    client.headers.pop('x-csrf-token', None)
    response = await client.get('/api/fire/system/overview')
    assert response.status_code == 200, response.text
    header = response.headers['server-timing']
    assert all(phase + ';dur=' in header for phase in ('backend_ttfb', 'pool_wait', 'db_guard', 'sql_execute'))
    assert re.search(r'desc="[1-9]\d* statements"', header)
    assert not any(value in header for value in ('AdminOne', admin, 'SELECT', 'password', 'Synthetic9Pass'))
    print('ISOLATED_TIMING', header)


async def test_actual_catalogue_304_keeps_the_same_contract_and_first_byte_timing(client, admin):
    login = await client.post('/api/auth/login', json={'username': 'AdminOne', 'password': 'Synthetic9Pass'})
    assert login.status_code == 200
    client.headers.pop('x-csrf-token', None)
    response = await client.get('/api/fire/system/api-migration')
    assert response.status_code == 200, response.text
    value = response.json()
    assert value['summary']['total'] == len(value['items'])
    header = response.headers['server-timing']
    assert 'catalogue;dur=' in header and 'json_encode;dur=' in header
    cached = await client.get('/api/fire/system/api-migration', headers={'if-none-match': response.headers['etag']})
    assert cached.status_code == 304 and not cached.content
    assert cached.headers['etag'] == response.headers['etag']
    assert 'backend_ttfb;dur=' in cached.headers['server-timing']
    client.cookies.clear()
    assert (await client.get('/api/fire/system/api-migration')).status_code == 401, 'a warm public-contract cache never grants access'


@pytest.mark.parametrize('version', (1, 2))
async def test_native_auth_errors_and_unavailable_pool_keep_original_status_and_timing(client, app, version, monkeypatch):
    from contextlib import asynccontextmanager

    from psycopg_pool import PoolTimeout

    # No Origin is needed by the native connection. Instrumentation is additive.
    client.headers.pop('origin', None)
    discovery = await client.get(f'/api/v{version}/auth/config')
    assert discovery.status_code == 200
    assert 'backend_ttfb;dur=' in discovery.headers['server-timing']
    denied = await client.get(f'/api/v{version}/records')
    assert denied.status_code == 401
    assert denied.json()['code'] in (40101, 40102)
    assert denied.headers['x-alcor-api-version'] == str(version)
    assert 'backend_ttfb;dur=' in denied.headers['server-timing']

    @asynccontextmanager
    async def busy():
        raise PoolTimeout('synthetic busy pool')
        yield

    monkeypatch.setattr(app.state.db.pool, 'connection', busy)
    busy_response = await client.get(f'/api/v{version}/records', headers={'authorization': 'Bearer fat_synthetic'})
    assert busy_response.status_code == 503, busy_response.text
    assert busy_response.json()['code'] == 50001
    assert busy_response.headers['retry-after'] == '3'
    assert busy_response.headers['x-alcor-api-version'] == str(version)
    assert 'backend_ttfb;dur=' in busy_response.headers['server-timing']
    assert 'pool_wait;dur=' in busy_response.headers['server-timing']
    assert 'db_guard;dur=' not in busy_response.headers['server-timing']


def test_first_byte_snapshot_is_immutable_and_late_work_does_not_keep_timing():
    timing, token = request_timing.begin()
    try:
        with request_timing.measure('sql_execute', statement=True):
            pass
        first = timing.header()
        assert not timing.active
        assert b'1 statements' in first
        assert request_timing.start() is None
        with request_timing.measure('sql_execute', statement=True):
            pass
        assert timing.header() is first
        assert timing.statements == 1
    finally:
        request_timing.finish(timing, token)
    assert request_timing.start() is None
