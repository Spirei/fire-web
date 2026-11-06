"""F03 legacy envelopes against isolated PG; never contact an external client."""

import base64
import hashlib
from urllib.parse import parse_qs, urlsplit

import pytest
from alcor_api.native_app_auth import CLIENT, REDIRECT


@pytest.mark.parametrize('version', [1, 2])
async def test_old_versioned_pkce_token_and_revoke_share_one_owned_family(client, admin, version):
    base = f'/api/v{version}/auth'
    config = await client.get(base + '/config')
    assert config.status_code == 200, config.text
    assert config.headers['x-alcor-api-version'] == str(version)
    assert config.json()['data']['token_path'] == base + '/token'
    verifier = 'f' * 43
    command = {
        'client_id': CLIENT, 'redirect_uri': REDIRECT, 'response_type': 'code',
        'scope': 'portfolio.read security.read', 'state': 'c' * 32,
        'code_challenge': base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('='),
        'code_challenge_method': 'S256', 'decision': 'allow', 'device_name': 'F03 isolated device',
    }
    denied = await client.post('/api/v1/auth/authorize', json=command | {'decision': 'deny'})
    assert parse_qs(urlsplit(denied.json()['data']['callback']).query)['error'] == ['access_denied']
    authorized = await client.post('/api/v1/auth/authorize', json=command)
    assert authorized.status_code == 200, authorized.text
    callback = parse_qs(urlsplit(authorized.json()['data']['callback']).query)
    assert callback['state'] == [command['state']]
    payload = {'grant_type': 'authorization_code', 'client_id': CLIENT, 'redirect_uri': REDIRECT,
               'code': callback['code'][0], 'code_verifier': verifier}
    assert (await client.post(base + '/token', json=payload | {'code_verifier': 'z' * 43})).status_code == 401
    issued = await client.post(base + '/token', json=payload)
    assert issued.status_code == 200, issued.text
    assert issued.headers['x-alcor-api-version'] == str(version)
    pair = issued.json()['data']
    assert pair['scope'] == command['scope']
    assert (await client.post(base + '/token', json=payload)).status_code == 401
    headers = {'authorization': 'Bearer ' + pair['access_token']}
    assert (await client.get(base + '/me', headers=headers)).status_code == 200
    assert (await client.post('/api/v1/auth/authorize', headers=headers, json=command)).status_code == 403
    rotated = await client.post(base + '/token', json={
        'grant_type': 'refresh_token', 'client_id': CLIENT, 'refresh_token': pair['refresh_token']})
    assert rotated.status_code == 200, rotated.text
    current = rotated.json()['data']
    result = await client.post(base + '/revoke', json={'client_id': CLIENT, 'token': current['access_token']})
    assert result.status_code == 200 and result.json()['data'] == {'revoked': True}
    assert (await client.get(base + '/me', headers={'authorization': 'Bearer ' + current['access_token']})).status_code == 401
    # Revocation never logs out the independent Web actor that authorized the client.
    assert (await client.get('/api/session')).status_code == 200


async def test_old_v2_consent_cas_permissions_and_cookie_cannot_replace_native_identity(client, admin, db):
    from test_legacy_devices import grant
    pair = await grant(db, admin, 'portfolio.read security.read')
    from alcor_api.native_app_auth import remember_consent
    async with db.connection() as conn:
        user = await (await conn.execute('SELECT * FROM users WHERE id=%s', (admin,))).fetchone()
        await remember_consent(conn, user, pair['scope'])
    headers = {'authorization': 'Bearer ' + pair['access_token']}
    base = '/api/v2/auth'
    assert (await client.get(base + '/consent')).status_code == 401
    descriptor = await client.get(base + '/consent', headers=headers)
    assert descriptor.status_code == 200, descriptor.text
    revision = descriptor.json()['data']['revision']
    stale = await client.post(base + '/consent', headers=headers, json={'client_id': CLIENT, 'revision': 'stale'})
    assert stale.status_code == 409
    accepted = await client.post(base + '/consent', headers=headers, json={'client_id': CLIENT, 'revision': revision})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()['data']['status'] == 'unchanged'
    upgrade = await client.post(base + '/permissions', headers=headers, json={'client_id': CLIENT, 'scope': 'security.write'})
    assert upgrade.status_code == 200, upgrade.text
    assert upgrade.json()['data']['replaces_grant_id'] == pair['grant_id']
    assert 'security.write' in upgrade.json()['data']['scope'].split()
    assert (await client.get(base + '/me', headers=headers)).json()['data']['scope'] == pair['scope']
    bad = await client.post(base + '/permissions', headers=headers, json={'client_id': CLIENT, 'scope': 'admin'})
    assert bad.status_code == 403


async def test_old_device_list_rechecks_revoked_cookie_before_private_projection(client, db, app, monkeypatch):
    from test_legacy_devices import grant, register
    owner = await register(client, 'F03RevokedReader')
    await grant(db, owner)
    service = app.state.identity_devices
    original = service.list

    async def revoke_before_projection(who, *, apps_only=False):
        async with db.connection() as conn:
            await conn.execute('DELETE FROM sessions WHERE token_hash=%s AND user_id=%s', (who.token_hash, owner))
        return await original(who, apps_only=apps_only)

    monkeypatch.setattr(service, 'list', revoke_before_projection)
    response = await client.get('/api/v1/auth/devices')
    assert response.status_code == 401, response.text
    assert 'devices' not in response.json().get('data', {})
    assert 'F03RevokedReader' not in response.text
