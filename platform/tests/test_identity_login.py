import httpx
import pytest
from psycopg.conninfo import conninfo_to_dict
from alcor_api.identity_import import import_trial_snapshot
from alcor_api.native_identity import totp_code
from alcor_api.security import COOKIE
from test_identity_import import snapshot
import time

P='/api'

async def imported(db,settings):
    data,_=snapshot()
    await import_trial_snapshot(db,data,source_key=b'SyntheticIdentityKey9',expected_database=conninfo_to_dict(settings.database_url.get_secret_value())['dbname'])
    return data

async def begin(client):
    response=await client.post(P+'/session/login',json={'login':'sourceadmin','password':'SyntheticSource9'})
    assert response.status_code==200,response.text
    assert response.json()['status']=='requires_2fa'
    assert COOKIE not in client.cookies
    assert (await client.get(P+'/session')).status_code==401
    return response.json()['challenge_token']

async def test_migrated_password_cannot_bypass_factor_and_code_replay_is_rejected(db,settings,client):
    await imported(db,settings)
    challenge=await begin(client)
    code=totp_code('JBSWY3DPEHPK3PXP',int(time.time()))
    response=await client.post(P+'/session/login/totp',json={'challenge_token':challenge,'code':code})
    assert response.status_code==200,response.text
    assert response.json()['user']['id']=='source-user-001'
    assert (await client.get(P+'/session')).status_code==200
    assert (await client.post(P+'/session/login/totp',json={'challenge_token':challenge,'code':code})).status_code==403
    await client.post(P+'/session/logout',headers={'x-csrf-token':response.json()['csrf']})
    challenge=await begin(client)
    assert (await client.post(P+'/session/login/totp',json={'challenge_token':challenge,'code':code})).status_code==403
    backup=await client.post(P+'/session/login/totp',json={'challenge_token':challenge,'code':'ABCD-1234-5678-90EF'})
    assert backup.status_code==200,backup.text
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT backup_codes FROM identity_security')).fetchone())['backup_codes']==[]

async def test_factor_attempts_commit_and_changed_identity_invalidates_challenge(db,settings,client):
    await imported(db,settings)
    challenge=await begin(client)
    for _ in range(8):
        assert (await client.post(P+'/session/login/totp',json={'challenge_token':challenge,'code':'invalid-code'})).status_code==403
    assert (await client.post(P+'/session/login/totp',json={'challenge_token':challenge,'code':totp_code('JBSWY3DPEHPK3PXP',int(time.time()))})).status_code==403
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT attempts FROM identity_challenges')).fetchone())['attempts']==8
    challenge=await begin(client)
    async with db.connection() as conn:
        await conn.execute('UPDATE users SET session_version=session_version+1')
    assert (await client.post(P+'/session/login/totp',json={'challenge_token':challenge,'code':'ABCD-1234-5678-90EF'})).status_code==403

async def test_factor_challenge_is_bound_to_its_browser(db,settings,client,app):
    await imported(db,settings)
    challenge=await begin(client)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as other:
        assert (await other.post(P+'/session/login/totp',json={'challenge_token':challenge,'code':'ABCD-1234-5678-90EF'})).status_code==403
    assert (await client.post(P+'/session/login/totp',json={'challenge_token':challenge,'code':'ABCD-1234-5678-90EF'})).status_code==200
