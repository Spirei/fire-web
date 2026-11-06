"""Canonical market pages keep the explicitly bound platform account, not old cookies."""
import httpx
from alcor_api.cli import create_user
from alcor_api.security import COOKIE


async def test_platform_market_reads_ignore_unselected_old_cookies(client, admin):
    for old in ('fire_session', 'stocklog_session'):
        for value in ('stale-session', ''):
            client.cookies.set(old, value)
            for path in ('/api/market/discovery?kind=top&market=US', '/api/market/sources', '/api/market/demands'):
                response = await client.get(path)
                assert response.status_code == 200, (old, value, path, response.text)
            assert (await client.get('/api/session')).status_code == 200
        client.cookies.delete(old)


async def test_explicit_bad_market_binding_does_not_fall_back(client, admin):
    client.cookies.set('fire_session', 'unselected-old')
    response = await client.get('/api/market/discovery?kind=top&market=US', headers={'x-csrf-token': 'invalid'})
    assert response.status_code == 403, response.text
    for value, status in (('', 401), ('Bearer invalid', 403)):
        response = await client.get('/api/market/discovery?kind=top&market=US', headers={'authorization': value})
        assert response.status_code == status, response.text
    client.cookies.delete(COOKIE)
    response = await client.get('/api/market/discovery?kind=top&market=US')
    assert response.status_code == 401, response.text


async def test_canonical_market_binding_does_not_select_other_legacy_account(client, admin, app, settings):
    await create_user(settings, 'OtherMarketOwner', 'Synthetic9Pass', role='user')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver', headers={'origin':'http://testserver'}) as old:
        response = await old.post('/api/auth/login', json={'username':'OtherMarketOwner','password':'Synthetic9Pass'})
        assert response.status_code == 200, response.text
        client.cookies.set('fire_session', old.cookies['fire_session'])
        result = await client.get('/api/market/discovery?kind=top&market=US')
        assert result.status_code == 200, result.text
        # The displayed platform identity remains the current account.
        assert (await client.get('/api/session')).json()['user']['id'] == admin
        # Legacy routes keep the old account rather than borrowing the platform header.
        legacy = await client.get('/api/auth/me')
        assert legacy.status_code == 200, legacy.text
        assert legacy.json()['user']['username'] == 'OtherMarketOwner'
