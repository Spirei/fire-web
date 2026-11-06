import time
import copy
import hashlib
from datetime import datetime, timedelta, timezone
import httpx
import pytest
from psycopg.conninfo import conninfo_to_dict
from alcor_api.identity_import import import_trial_snapshot
from alcor_api.native_identity import totp_code
from test_identity_import import snapshot

async def test_trial_copy_preserves_existing_web_session_without_mutating_source(db,settings,client):
    data,_=snapshot()
    raw_session='a'*64
    now=datetime.now(timezone.utc)
    data['sessions']=[{'token_hash':hashlib.sha256(raw_session.encode()).hexdigest(),
        'user_id':'source-user-001','created_at':now.isoformat(),
        'expires_at':(now+timedelta(days=6)).isoformat(),'auth_method':'totp'}]
    original=copy.deepcopy(data)
    await import_trial_snapshot(db,data,source_key=b'SyntheticIdentityKey9',expected_database=conninfo_to_dict(settings.database_url.get_secret_value())['dbname'])
    client.cookies.set('fire_session',raw_session)
    response=await client.get('/api/auth/me')
    assert response.status_code==200,response.text
    assert response.json()['user']['id']=='source-user-001'
    assert (await client.get('/api/session')).status_code==401
    await client.post('/api/auth/logout')
    assert (await client.get('/api/auth/me')).status_code==401
    assert data==original
    # Logout revoked only the trial database row; source snapshot stays intact.
    assert data['sessions'][0]['token_hash']==hashlib.sha256(raw_session.encode()).hexdigest()

async def prepare(db,settings):
    data,_=snapshot()
    await import_trial_snapshot(db,data,source_key=b'SyntheticIdentityKey9',expected_database=conninfo_to_dict(settings.database_url.get_secret_value())['dbname'])
    return data

async def test_legacy_web_login_remains_native_and_uses_original_cookie_protocol(db,settings,client):
    await prepare(db,settings)
    response=await client.post('/api/auth/login',json={'username':'sourceadmin','password':'SyntheticSource9'})
    assert response.status_code==200,response.text
    assert response.json()['requires2fa'] and len(response.json()['ticket'])==48
    assert 'fire_session' not in client.cookies
    result=await client.post('/api/auth/login/totp',json={'ticket':response.json()['ticket'],'code':'ABCD-1234-5678-90EF'})
    assert result.status_code==200,result.text
    assert result.json()['user']['id']=='source-user-001'
    assert 'fire_session' in client.cookies and 'alcor_session' not in client.cookies
    me=await client.get('/api/auth/me');assert me.json()['user']['id']=='source-user-001'
    assert (await client.get('/api/session')).status_code==401
    assert (await client.get('/api/v2/auth/me')).status_code==401
    await client.post('/api/auth/logout')
    assert (await client.get('/api/auth/me')).status_code==401

async def test_native_v2_login_has_no_cookie_coupling_and_tokens_rotate_without_replay(db,settings,client,app):
    await prepare(db,settings)
    discovered=await client.get('/api/v2/auth/config')
    assert discovered.status_code==200 and discovered.json()['data']['native_login']['login_path']=='/api/v2/auth/login'
    assert discovered.headers['x-alcor-api-version']=='2'
    response=await client.post('/api/v2/auth/login',json={'client_id':'fire-ios','username':'SourceAdmin','password':'SyntheticSource9','device_name':'QA iOS'})
    assert response.status_code==200,response.text
    challenge=response.json()['data'];assert challenge['status']=='requires_2fa' and challenge['purpose']=='login'
    assert not client.cookies
    result=await client.post('/api/v2/auth/login/totp',json={'client_id':'fire-ios','challenge_token':challenge['challenge_token'],'code':'ABCD-1234-5678-90EF'})
    assert result.status_code==200,result.text
    pair=result.json()['data'];assert pair['status']=='authenticated' and pair['apiVersion']==2 and pair['user']['id']=='source-user-001'
    assert pair['user']['role']=='user' and pair['scope']=='portfolio.read portfolio.write'
    assert not client.cookies
    headers={'authorization':'Bearer '+pair['access_token']}
    assert (await client.get('/api/v2/auth/me',headers=headers)).json()['data']['id']=='source-user-001'
    assert (await client.get('/api/meta',headers=headers)).status_code==200
    assert (await client.get('/api/users',headers=headers)).status_code==401
    rotated=await client.post('/api/v2/auth/token',data={'grant_type':'refresh_token','client_id':'fire-ios','refresh_token':pair['refresh_token']})
    assert rotated.status_code==200,rotated.text
    next_pair=rotated.json()['data']
    assert next_pair['grant_id']==pair['grant_id'] and next_pair['access_token']!=pair['access_token']
    replay=await client.post('/api/v2/auth/token',data={'grant_type':'refresh_token','client_id':'fire-ios','refresh_token':pair['refresh_token']})
    assert replay.status_code==401
    assert (await client.get('/api/v2/auth/me',headers={'authorization':'Bearer '+next_pair['access_token']})).status_code==401

async def test_legacy_v1_ticket_and_bearer_shape_do_not_become_v2_cookie_fallback(db,settings,client):
    await prepare(db,settings)
    first=await client.post('/api/v1/auth/login',json={'username':'SourceAdmin','password':'SyntheticSource9'})
    assert first.status_code==200,first.text
    ticket=first.json()['data']['ticket'];assert len(ticket)==48
    result=await client.post('/api/v1/auth/login/totp',json={'ticket':ticket,'code':'ABCD-1234-5678-90EF'})
    assert result.status_code==200,result.text
    token=result.json()['data']['token'];assert len(token)==64
    assert (await client.get('/api/v1/auth/me',headers={'authorization':'Bearer '+token})).status_code==200
    assert (await client.get('/api/v2/auth/me',headers={'authorization':'Bearer '+token})).status_code==401
    assert (await client.post('/api/v2/auth/login',json={'client_id':'wrong-client','username':'SourceAdmin','password':'SyntheticSource9'})).status_code==400
