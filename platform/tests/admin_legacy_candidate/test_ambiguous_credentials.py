"""A second credential cannot be hidden behind a valid administrator token."""
from uuid import uuid4

from alcor_api.cli import create_user
from test_account_admin import body_for
from test_adapter import legacy  # noqa: F401


async def test_ambiguous_legacy_admin_token_cannot_read_or_mutate(legacy, client, admin, settings, db):  # noqa: F811
    target = await create_user(settings, 'DuplicateTarget', 'Synthetic9Pass', role='user')
    command = await body_for(client, target, username='RejectedEdit')
    token = legacy.cookies['fire_session']
    headers = [('authorization','Bearer '+token), ('authorization','Bearer '+('0'*64))]
    before = (await client.get('/api/users')).json()
    for method, path, body in [('GET','/api/users',None), ('PUT','/api/users/'+target,command),
                               ('POST','/api/users/'+target+'/reset-password',{**command,'newPassword':'NeverApplied9Pass'})]:
        response = await legacy.request(method,path,headers=headers,**({'json':body} if body else {}))
        assert response.status_code == 403, response.text
        assert response.headers['x-alcor-retire-context'] == 'true'
    assert (await client.get('/api/users')).json() == before
    async with db.connection() as conn:
        assert not await (await conn.execute('SELECT 1 FROM account_actions WHERE owner_id=%s AND request_id=%s',(admin,command['request_id']))).fetchone()
