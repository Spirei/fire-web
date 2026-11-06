"""F01 profile responses cannot outlive their authenticated actor."""

import pytest
import alcor_api.legacy_identity as module
from test_legacy_devices import grant, register


@pytest.mark.parametrize('version', [None, 1, 2])
async def test_me_rechecks_current_actor_before_private_projection(client, db, monkeypatch, version):
    owner = await register(client, 'ProfileGuardOwner')
    headers = {}
    if version is None:
        path = '/api/auth/me'
        original = module.web_identity

        async def revoke_after_check(*args, **kwargs):
            result = await original(*args, **kwargs)
            async with db.connection() as conn:
                await conn.execute('DELETE FROM sessions WHERE token_hash=%s', (result[0].token_hash,))
            return result

        monkeypatch.setattr(module, 'web_identity', revoke_after_check)
    else:
        pair = await grant(db, owner, 'portfolio.read')
        headers = {'authorization': 'Bearer ' + pair['access_token']}
        path = f'/api/v{version}/auth/me'
        original = module.native_identity

        async def revoke_after_check(*args, **kwargs):
            result = await original(*args, **kwargs)
            async with db.connection() as conn:
                await conn.execute('UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s', (pair['grant_id'],))
            return result

        monkeypatch.setattr(module, 'native_identity', revoke_after_check)
    response = await client.get(path, headers=headers)
    assert response.status_code == 401, response.text
    assert 'ProfileGuardOwner' not in response.text
    assert 'user' not in response.json().get('data', response.json())
    assert 'set-cookie' not in response.headers
