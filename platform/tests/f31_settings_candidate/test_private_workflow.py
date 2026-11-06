"""Real encrypted configuration/legacy bridges, with no supplier IO."""
import json
from datetime import UTC,datetime,timedelta
from uuid import uuid4

import pytest
from alcor_api.connections import Vault
from alcor_api.provider_setting_operations import ProviderSettingOperations

PASSWORD='Synthetic9Pass'


def policy(db,owner,host='example.com',path='/chat/completions',purpose='provider.model.test'):
    return dict(host=host,port=443,path=path,addresses=['93.184.216.34'],ownerId=owner,instanceId=str(db.settings.instance_id),approvedAccess=True,licenseRevision='controlled-license',expiresAt=(datetime.now(UTC)+timedelta(days=1)).isoformat(),purpose=purpose)


async def test_legacy_smtp_string_port_masked_keep_and_cas_atomicity(client,db,admin):
    command={'requestId':str(uuid4()),'privateRevision':0,'smtpHost':'smtp.example.invalid','smtpPort':'465','smtpSecure':True,'smtpEnabled':False,'smtpUser':'synthetic','smtpPassword':'explicit-synthetic-secret','currentPassword':PASSWORD}
    saved=await client.put('/api/settings',json=command)
    assert saved.status_code==200,saved.text
    assert 'explicit-synthetic-secret'not in saved.text
    replay=await client.put('/api/settings',json=command)
    assert replay.json()==saved.json()
    keep={**command,'requestId':str(uuid4()),'privateRevision':1,'smtpPassword':'********','smtpUser':'********'}
    kept=await client.put('/api/settings',json=keep)
    assert kept.status_code==200,kept.text
    async with db.connection()as conn:
        from alcor_api.private_runtime_settings import PrivateRuntimeSettings
        revision,raw=await PrivateRuntimeSettings(db).private_on_connection(conn)
        assert revision==2 and raw['smtpPassword']=='explicit-synthetic-secret'and raw['smtpUser']=='synthetic'
        row=await(await conn.execute('SELECT payload_ciphertext FROM private_runtime_versions ORDER BY revision DESC LIMIT 1')).fetchone()
        assert 'explicit-synthetic-secret'not in row['payload_ciphertext']
    bad=await client.put('/api/settings',json={**keep,'requestId':str(uuid4()),'smtpHost':'should-not-write'})
    assert bad.status_code==409,bad.text
    assert (await client.get('/api/admin/private-runtime-settings')).json()['revision']==2


async def test_gateway_model_probe_original_and_unknown_replay(client,db,admin,monkeypatch):
    installed={'id':'gateway','name':'Explicit gateway','provider':'openai','apiUrl':'https://example.com/chat/completions','models':['explicit-model'],'selectedModel':'explicit-model','approval':policy(db,admin)}
    raw={'requestId':str(uuid4()),'expectedRevision':0,'group':'models','patch':{'modelServices':[installed]},'secretActions':{'modelServices.gateway.apiKey':{'action':'set','value':'synthetic-key'}},'password':PASSWORD}
    saved=await client.post('/api/admin/private-runtime-settings',json=raw)
    assert saved.status_code==200,saved.text
    calls=[]
    async def read(target):
        calls.append(target)
        return {'raw':b'actual partial provider reply','status':200,'complete':False,'latencyMs':1}
    monkeypatch.setattr('alcor_api.provider_setting_operations.model_read',read)
    command={'requestId':str(uuid4()),'expectedRevision':1,'serviceId':'gateway','model':'explicit-model'}
    result=await client.post('/api/admin/provider-operations/model-test',json=command)
    assert result.status_code==202,result.text
    assert result.json()['state']=='unknown'
    assert calls[0]['url']==installed['apiUrl']and calls[0]['apiKey']=='synthetic-key'
    assert (await client.post('/api/admin/provider-operations/model-test',json=command)).json()==result.json()
    assert len(calls)==1
    async with db.connection()as conn:
        row=await(await conn.execute('SELECT o.origin_instance,p.* FROM provider_setting_operations o JOIN provider_setting_pages p USING(owner_id,request_id) WHERE o.owner_id=%s',(admin,))).fetchone()
        assert row['origin_instance']==db.settings.instance_id
        assert bytes(row['raw'])==b'actual partial provider reply'and row['complete']is False
    assert (await client.post('/api/auth/login',json={'username':'AdminOne','password':PASSWORD})).status_code==200
    assert (await client.get('/api/settings/model-test')).status_code==200


async def test_old_social_configuration_is_actual_owner_provider_not_binding(client,db,admin):
    installed=[{'id':'installed-qq','channel':'qq','origins':{},'fixture':True,'approved_access':True}]
    installation=await client.post('/api/admin/private-runtime-settings',json={'requestId':str(uuid4()),'expectedRevision':0,'group':'notifications','patch':{'business_notification_targets':installed},'password':PASSWORD})
    assert installation.status_code==200,installation.text
    command={'requestId':str(uuid4()),'privateRevision':1,'qqEnabled':True,'qqName':'Declared QQ','qqAppId':'12345678','qqAppSecret':'synthetic-qq-secret','qqUserOpenId':'a'*20,'currentPassword':PASSWORD}
    saved=await client.put('/api/settings',json=command)
    assert saved.status_code==200,saved.text
    assert 'synthetic-qq-secret'not in saved.text
    async with db.connection()as conn:
        provider=await(await conn.execute('SELECT * FROM business_notification_provider_revisions WHERE owner_id=%s',(admin,))).fetchone()
        assert provider and provider['channel']=='qq'
        assert 'synthetic-qq-secret'not in provider['ciphertext']
        assert not await(await conn.execute('SELECT 1 FROM business_notification_bindings WHERE owner_id=%s',(admin,))).fetchone()
        assert not await(await conn.execute('SELECT 1 FROM business_notification_deliveries WHERE owner_id=%s',(admin,))).fetchone()
    assert (await client.put('/api/settings',json=command)).json()==saved.json()
    disabled=await client.put('/api/settings',json={'requestId':str(uuid4()),'privateRevision':2,'qqEnabled':False,'currentPassword':PASSWORD})
    assert disabled.status_code==200,disabled.text
    async with db.connection()as conn:assert await(await conn.execute('SELECT 1 FROM business_notification_provider_revocations WHERE owner_id=%s',(admin,))).fetchone()


async def test_old_provider_management_rejects_explicit_bad_duplicate_and_native_identity(client,db,admin):
    from alcor_api.security import digest
    token='d'*64
    async with db.connection()as conn:
        user=await(await conn.execute('SELECT session_version FROM users WHERE id=%s',(admin,))).fetchone()
        await conn.execute("INSERT INTO sessions(token_hash,user_id,client_id,session_version,expires_at) VALUES(%s,%s,'legacy-v1',%s,clock_timestamp()+interval '1 hour')",(digest(token),admin,user['session_version']))
    for path,method in [('/api/settings/model-test','GET'),('/api/settings/model-test','POST'),('/api/settings/mail-test','POST'),('/api/settings/model-icon','POST'),('/api/settings/xueqiu-cookie','POST')]:
        for headers in [{'authorization':''},{'authorization':'garbage'},[('authorization','Bearer '+token),('authorization','Bearer '+token)],{'authorization':'Bearer '+token}]:
            result=await client.request(method,path,headers=headers)
            assert result.status_code in (401,403),result.text
    async with db.connection()as conn:
        assert not await(await conn.execute('SELECT 1 FROM provider_setting_operations WHERE owner_id=%s',(admin,))).fetchone()


async def test_old_person_interval_save_enrolls_existing_enabled_group_without_io(client,db,admin):
    from alcor_api.private_runtime_settings import PrivateRuntimeSettings
    target={'id':'trump','ownerId':admin,'instanceId':str(db.settings.instance_id),'provider':'person-original-json','purpose':'feed.person.read','personId':'trump','url':'https://example.com/trump','approvedAccess':True,'addresses':['93.184.216.34'],'licenseRevision':'synthetic-people','expiresAt':'2099-01-01T00:00:00+00:00','refreshMinutes':10}
    installed=await client.post('/api/admin/private-runtime-settings',json={'requestId':str(uuid4()),'expectedRevision':0,'group':'sources','patch':{'feed_targets':[target]},'password':PASSWORD})
    assert installed.status_code==200,installed.text
    created=await client.post('/api/feed/groups',json={'requestId':str(uuid4()),'name':'Synthetic saved intervals','mode':'people','people':['trump']})
    assert created.status_code==200,created.text
    group=created.json()['result']['id']
    command={'requestId':str(uuid4()),'privateRevision':1,'tradingSquareTrumpRefreshMinutes':2,'currentPassword':PASSWORD}
    saved=await client.put('/api/settings',json=command)
    assert saved.status_code==200,saved.text
    async with db.connection()as conn:
        _,raw=await PrivateRuntimeSettings(db).private_on_connection(conn)
        assert raw['peopleRefreshIntervals']['trump']==2
        assert next(t for t in raw['feed_targets']if t['id']=='trump')['refreshMinutes']==2
        jobs=await(await conn.execute('SELECT * FROM feed_source_jobs WHERE owner_id=%s AND group_id=%s',(admin,group))).fetchall()
        assert len(jobs)==2
        assert any(j['inputs'].get('scheduled')is True for j in jobs)
        assert not await(await conn.execute('SELECT 1 FROM feed_source_admissions WHERE owner_id=%s',(admin,))).fetchone()
    assert (await client.put('/api/settings',json=command)).json()==saved.json()


async def test_notification_encrypt_key_uses_explicit_secret_actions_and_never_readback(client, db, admin):
    from alcor_api.private_runtime_settings import PrivateRuntimeSettings

    path = '/api/admin/private-runtime-settings'
    secret = 'synthetic-event-encryption-key'
    command = {'requestId': str(uuid4()), 'expectedRevision': 0, 'group': 'notifications',
               'patch': {'legacyChannelSettings': {'feishuEnabled': False, 'feishuName': '合成飞书'}},
               'secretActions': {'legacyChannelSettings.feishuEncryptKey': {'action': 'set', 'value': secret}}}
    saved = await client.post(path, json=command)
    assert saved.status_code == 200, saved.text
    head = (await client.get(path)).json()
    assert secret not in json.dumps(head)
    assert 'feishuEncryptKey' not in head['groups']['notifications']['values']['legacyChannelSettings']
    assert head['groups']['notifications']['secretState']['legacyChannelSettings.feishuEncryptKey'] == 'configured'
    denied = await client.post(path, json={**command, 'requestId': str(uuid4()), 'expectedRevision': 1,
        'patch': {'legacyChannelSettings': {'feishuEncryptKey': 'must-not-write'}}, 'secretActions': {}})
    assert denied.status_code == 422, denied.text
    async with db.connection() as conn:
        revision, raw = await PrivateRuntimeSettings(db).private_on_connection(conn)
        assert revision == 1 and raw['legacyChannelSettings']['feishuEncryptKey'] == secret
        assert not await (await conn.execute('SELECT 1 FROM business_notification_provider_revisions')).fetchone()
        assert not await (await conn.execute('SELECT 1 FROM business_notification_bindings')).fetchone()
        assert not await (await conn.execute('SELECT 1 FROM business_notification_deliveries')).fetchone()
    cleared = await client.post(path, json={**command, 'requestId': str(uuid4()), 'expectedRevision': 1,
        'patch': head['groups']['notifications']['values'],
        'secretActions': {'legacyChannelSettings.feishuEncryptKey': {'action': 'clear'}}})
    assert cleared.status_code == 200, cleared.text
    assert (await client.get(path)).json()['groups']['notifications']['secretState']['legacyChannelSettings.feishuEncryptKey'] == 'unset'
