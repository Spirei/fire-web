"""Automatic chart observation must not block independent account reads."""
import asyncio
from uuid import uuid4

import pytest
from redis.asyncio import Redis

from source_pure_read_candidate.test_reads import snapshot
from test_connections import PASSWORD, private_redis  # noqa: F401 -- owned fixture
from test_legacy_devices import bearer, grant


@pytest.mark.parametrize('version', [1, 2])
async def test_chart_observation_shares_asset_identity_but_explicit_prepare_keeps_write_lock(client, db, admin, app, private_redis, version):
    pair = await grant(db, admin, 'portfolio.read portfolio.write cash.read')
    headers = bearer(pair)
    cache = Redis(unix_socket_path=str(private_redis), password=PASSWORD)
    app.state.cache.client = cache
    before = await snapshot(db)
    try:
        async with db.connection() as conn, conn.transaction():
            await conn.execute('SELECT id FROM users WHERE id=%s FOR SHARE', (admin,))
            await conn.execute('SELECT id FROM identity_app_grants WHERE id=%s FOR SHARE', (pair['grant_id'],))
            response = await asyncio.wait_for(client.post(f'/api/v{version}/charts', headers=headers,
                json={'items': [{'id': 'synthetic-row', 'market': 'US', 'code': 'AAPL'}]}), 1)
            assert response.status_code == 200 and response.json()['data']['charts'] == {}, response.text
            identifier = str(uuid4())
            pending = asyncio.create_task(client.post(f'/api/v{version}/kline/prepare', headers=headers,
                json={'requestId': identifier, 'items': [{'market': 'US', 'code': 'AAPL'}], 'days': 5, 'minute': True}))
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(asyncio.shield(pending), .1)
        saved = await asyncio.wait_for(pending, 3)
        assert saved.status_code == 200 and saved.json()['data']['requestId'] == identifier, saved.text
        after = await snapshot(db)
        assert {name for name in before if before[name] != after[name]} == {'market_data_operations'}
        async with db.connection() as conn:
            await conn.execute('UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s', (pair['grant_id'],))
        revoked = await client.post(f'/api/v{version}/charts', headers=headers,
            json={'items': [{'id': 'synthetic-row', 'market': 'US', 'code': 'AAPL'}]})
        assert revoked.status_code == 401 and revoked.headers['x-alcor-retire-context'] == 'true'
    finally:
        app.state.cache.client = None
        await cache.aclose()
