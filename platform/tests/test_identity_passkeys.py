import base64
import hashlib
import json
import struct
from urllib.parse import urlsplit
import httpx
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from psycopg.conninfo import conninfo_to_dict
from alcor_api.identity_import import import_trial_snapshot
from alcor_api.identity_passkeys import b64
from test_identity_import import snapshot

P='/api/account/passkeys'
LOGIN='/api/session/passkeys'
ORIGIN='https://legacy.example.test'

async def prepared(db,settings,app):
    data,private=snapshot()
    await import_trial_snapshot(db,data,source_key=b'SyntheticIdentityKey9',expected_database=conninfo_to_dict(settings.database_url.get_secret_value())['dbname'])
    settings.public_origin=ORIGIN
    client=httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url=ORIGIN,headers={'origin':ORIGIN})
    return data,private,client


def assertion(options,private,*,counter=8,origin=ORIGIN,rp='legacy.example.test',uv=True,handle='c291cmNlLWhhbmRsZQ'):
    data=json.dumps({'type':'webauthn.get','challenge':options['challenge'],'origin':origin,'crossOrigin':False},separators=(',',':')).encode()
    auth=hashlib.sha256(rp.encode()).digest()+bytes([5 if uv else 1])+struct.pack('>I',counter)
    signature=private.sign(auth+hashlib.sha256(data).digest(),ec.ECDSA(hashes.SHA256()))
    return {'id':'c291cmNlLWNyZWRlbnRpYWw','rawId':'c291cmNlLWNyZWRlbnRpYWw','type':'public-key','clientExtensionResults':{},'response':{'authenticatorData':b64(auth),'clientDataJSON':b64(data),'signature':b64(signature),'userHandle':handle}}

async def test_migrated_passkey_logs_in_natively_and_counter_replay_fails(db,settings,app):
    data,private,client=await prepared(db,settings,app)
    async with client:
        options=(await client.post(LOGIN,json={'action':'login-options'})).json()
        credential=assertion(options['options'],private)
        body={'action':'login-verify','requestId':options['requestId'],'response':credential}
        response=await client.post(LOGIN,json=body)
        assert response.status_code==200,response.text
        assert response.json()['user']['id']=='source-user-001'
        assert (await client.post(LOGIN,json=body)).status_code==403
        options=(await client.post(LOGIN,json={'action':'login-options'})).json()
        response=await client.post(LOGIN,json={'action':'login-verify','requestId':options['requestId'],'response':assertion(options['options'],private,counter=8)})
        assert response.status_code==403
    async with db.connection() as conn:
        key=await (await conn.execute('SELECT counter FROM identity_passkeys')).fetchone()
        assert key['counter']==8

@pytest.mark.parametrize('change',[{'origin':'https://evil.example.test'},{'rp':'evil.example.test'},{'uv':False},{'handle':'b3RoZXItdXNlcg'}])
async def test_passkey_rejects_wrong_origin_rp_uv_or_user_and_consumes_challenge(db,settings,app,change):
    data,private,client=await prepared(db,settings,app)
    async with client:
        options=(await client.post(LOGIN,json={'action':'login-options'})).json()
        body={'action':'login-verify','requestId':options['requestId'],'response':assertion(options['options'],private,**change)}
        assert (await client.post(LOGIN,json=body)).status_code==403
        body['response']=assertion(options['options'],private)
        assert (await client.post(LOGIN,json=body)).status_code==403
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT counter FROM identity_passkeys')).fetchone())['counter']==7

async def test_register_rename_and_remove_credential_preserve_legacy_user_handle(db,settings,app):
    import cbor2
    from alcor_api.native_identity import totp_code
    import time
    data,private,client=await prepared(db,settings,app)
    async with client:
        options=(await client.post(LOGIN,json={'action':'login-options'})).json()
        login=await client.post(LOGIN,json={'action':'login-verify','requestId':options['requestId'],'response':assertion(options['options'],private)})
        assert login.status_code==200,login.text
        client.headers['x-csrf-token']=login.json()['csrf']
        register=await client.post(P,json={'action':'register-options','password':'SyntheticSource9','code':totp_code('JBSWY3DPEHPK3PXP',int(time.time()))})
        assert register.status_code==200,register.text
        issued=register.json()
        assert issued['options']['user']['id']=='c291cmNlLWhhbmRsZQ'
        new_private=ec.generate_private_key(ec.SECP256R1());point=new_private.public_key().public_numbers()
        public=cbor2.dumps({1:2,3:-7,-1:1,-2:point.x.to_bytes(32,'big'),-3:point.y.to_bytes(32,'big')})
        credential_id=b'new-native-credential'
        auth=hashlib.sha256(b'legacy.example.test').digest()+bytes([0x45])+struct.pack('>I',0)+bytes(16)+struct.pack('>H',len(credential_id))+credential_id+public
        client_data=json.dumps({'type':'webauthn.create','challenge':issued['options']['challenge'],'origin':ORIGIN,'crossOrigin':False},separators=(',',':')).encode()
        registration={'id':b64(credential_id),'rawId':b64(credential_id),'type':'public-key','clientExtensionResults':{'credProps':{'rk':True}},'response':{'attestationObject':b64(cbor2.dumps({'fmt':'none','attStmt':{},'authData':auth})),'clientDataJSON':b64(client_data),'transports':['internal']}}
        confirmed=await client.post(P,json={'action':'register-verify','requestId':issued['requestId'],'response':registration,'name':'Native key'})
        assert confirmed.status_code==200,confirmed.text
        keys=(await client.get(P)).json()['keys'];assert len(keys)==2
        renamed=await client.patch(P,json={'id':b64(credential_id),'name':'Renamed key'})
        assert renamed.status_code==200,renamed.text
        removed=await client.request('DELETE',P,json={'id':'c291cmNlLWNyZWRlbnRpYWw','password':'SyntheticSource9','code':'ABCD-1234-5678-90EF'})
        assert removed.status_code==200 and removed.json()['signedOut']
        assert (await client.get('/api/session')).status_code==401
    async with db.connection() as conn:
        remaining=await (await conn.execute('SELECT id,name,user_handle FROM identity_passkeys')).fetchall()
        assert remaining==[{'id':b64(credential_id),'name':'Renamed key','user_handle':'c291cmNlLWhhbmRsZQ'}]
