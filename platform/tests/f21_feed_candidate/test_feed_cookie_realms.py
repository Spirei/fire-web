"""Canonical platform session must not be shadowed by another legacy cookie realm."""
from test_legacy_devices import bearer, grant


async def test_platform_cookie_with_stale_legacy_does_not_downgrade(client, db, admin):
    for name in ('fire_session', 'stocklog_session'):
        client.cookies.set(name, 'invalid-legacy-session')
    for path in ('/api/feed', '/api/feed/groups', '/api/feed/profile', '/api/feed/preferences', '/api/feed/targets', '/api/feed/jobs'):
        response = await client.get(path)
        assert response.status_code == 200, response.text
    # Explicit credentials remain strict; no platform cookie fallback for a bad bearer.
    assert (await client.get('/api/feed', headers={'Authorization': 'Bearer invalid'})).status_code == 401
    assert (await client.get('/api/v1/feed')).status_code == 401
    assert (await client.get('/api/v2/feed')).status_code == 401
    read = await grant(db, admin, 'portfolio.read feed.read')
    assert (await client.get('/api/v2/feed', headers=bearer(read))).status_code == 200
    assert (await client.post('/api/v2/feed/groups', headers=bearer(read), json={'name': 'Denied'})).status_code == 403
    client.cookies.delete('alcor_session')
    assert (await client.get('/api/feed')).status_code == 401
