"""An unused old cookie cannot expire the explicitly selected current Web session."""
from alcor_api.security import COOKIE

PATHS = (
    '/api/account/changes', '/api/account/device-state',
    '/api/account/state?namespace=watch', '/api/account/state?namespace=fees',
    '/api/backups/schedule', '/api/notifications/provider-targets',
    '/api/notifications/providers', '/api/price-alerts', '/api/clipboard/capabilities',
)


async def test_web_read_realms_ignore_empty_and_expired_unused_old_cookies(client, admin):
    for name in ('fire_session', 'stocklog_session'):
        for value in ('', 'stale-session'):
            client.cookies.set(name, value)
            for path in PATHS:
                response = await client.get(path)
                assert response.status_code == 200, (path, response.text)
        client.cookies.delete(name)
    assert (await client.get('/api/session')).json()['user']['id'] == admin


async def test_selected_cookie_and_binding_remain_required(client, admin):
    client.cookies.set('fire_session', 'unselected-stale')
    for path in PATHS:
        response = await client.get(path, headers={'x-csrf-token':'invalid'})
        assert response.status_code == 403, (path,response.text)
    client.cookies.delete(COOKIE)
    for path in PATHS:
        response = await client.get(path)
        assert response.status_code == 401, (path,response.text)
    for value in ('', 'expired-platform-session'):
        client.cookies.set(COOKIE, value)
        for path in PATHS:
            response = await client.get(path)
            assert response.status_code == 401, (path, response.text)


async def test_explicit_native_credentials_never_fall_back_to_web_cookie(client, admin):
    for path in PATHS:
        response = await client.get(path, headers={'authorization':'Bearer invalid'})
        assert response.status_code in (401,403), (path,response.text)
