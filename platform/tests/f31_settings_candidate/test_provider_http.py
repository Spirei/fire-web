"""Actual legacy provider transports and durable results; all outbound IO is controlled."""
import io
import json
from uuid import uuid4

from PIL import Image

PASSWORD='Synthetic9Pass'

async def test_old_mail_test_once_current_verified_owner_and_durable_receipt(client,db,admin,monkeypatch):
    from test_private_workflow import policy
    approval=policy(db,admin,host='smtp.example.invalid',path='/',purpose='smtp.send');approval['port']=465
    saved=await client.post('/api/admin/private-runtime-settings',json={'requestId':str(uuid4()),'expectedRevision':0,'group':'smtp','patch':{'smtpHost':'smtp.example.invalid','smtpPort':465,'smtpSecure':True,'smtpEnabled':True,'smtpFromEmail':'sender@example.invalid','smtpApproval':approval},'password':PASSWORD})
    assert saved.status_code==200,saved.text
    async with db.connection()as conn:
        await conn.execute('UPDATE users SET email=%s WHERE id=%s',('admin@example.invalid',admin))
        await conn.execute('INSERT INTO identity_security(user_id,email_verified) VALUES(%s,true) ON CONFLICT(user_id)DO UPDATE SET email_verified=true',(admin,))
    calls=[]
    async def perform(self,config,**kw):
        assert await kw['authorize']();calls.append(kw);assert kw['destination']=='admin@example.invalid'
    monkeypatch.setattr('alcor_api.provider_setting_operations.Smtp.perform',perform)
    command={'requestId':str(uuid4()),'expectedRevision':1}
    response=await client.post('/api/settings/mail-test',json=command)
    assert response.status_code==200 and response.json()['deliveryAuthority']=='smtp_accepted_not_inbox_delivery_confirmed',response.text
    assert (await client.post('/api/settings/mail-test',json=command)).json()==response.json()
    assert len(calls)==1
    read=await client.get('/api/admin/provider-operations/operations/'+command['requestId'])
    assert read.status_code==200 and read.json()['state']=='completed',read.text


async def test_old_model_icon_and_bound_cookie_are_real_owner_versions_without_secret_receipts(client,db,admin,settings,tmp_path):
    settings.file_root=tmp_path.resolve()/'provider-files'
    from test_private_workflow import policy
    service={'id':'gateway','name':'Explicit gateway','provider':'openai','apiUrl':'https://example.com/chat/completions','models':['explicit-model'],'selectedModel':'explicit-model','approval':policy(db,admin)}
    saved=await client.post('/api/admin/private-runtime-settings',json={'requestId':str(uuid4()),'expectedRevision':0,'group':'models','patch':{'modelServices':[service]},'secretActions':{'modelServices.gateway.apiKey':{'action':'set','value':'synthetic-key'}},'password':PASSWORD})
    assert saved.status_code==200,saved.text
    image=io.BytesIO();Image.new('RGB',(2,2),(10,20,30)).save(image,format='PNG')
    rid=str(uuid4());response=await client.post('/api/settings/model-icon',data={'requestId':rid,'expectedRevision':'1','serviceId':'gateway','currentPassword':PASSWORD},files={'file':('synthetic.png',image.getvalue(),'image/png')})
    assert response.status_code==200 and response.json()['imageVersion'],response.text
    replay=await client.post('/api/settings/model-icon',data={'requestId':rid,'expectedRevision':'1','serviceId':'gateway','currentPassword':PASSWORD},files={'file':('synthetic.png',image.getvalue(),'image/png')})
    assert replay.status_code==200 and replay.json()==response.json(),replay.text
    async with db.connection()as conn:
        from alcor_api.private_runtime_settings import PrivateRuntimeSettings
        revision,raw=await PrivateRuntimeSettings(db).private_on_connection(conn)
        assert revision==2 and raw['modelServices'][0]['icon']==response.json()['url']
        assert raw['modelServices'][0]['apiKey']=='synthetic-key'
        asset=await(await conn.execute('SELECT 1 FROM system_asset_versions WHERE id=%s',(response.json()['imageVersion'],))).fetchone();assert asset
    target={'id':'xueqiu','ownerId':admin,'instanceId':str(db.settings.instance_id),'provider':'xueqiu-status-json','purpose':'feed.person.read','personId':'duan','url':'https://api.xueqiu.com/statuses/user_timeline.json?user_id=1247347556','approvedAccess':True,'addresses':['93.184.216.34'],'licenseRevision':'synthetic-people','expiresAt':'2099-01-01T00:00:00+00:00'}
    saved=await client.post('/api/admin/private-runtime-settings',json={'requestId':str(uuid4()),'expectedRevision':2,'group':'sources','patch':{'feed_targets':[target]},'password':PASSWORD})
    assert saved.status_code==200,saved.text
    saved=await client.post('/api/admin/private-runtime-settings',json={'requestId':str(uuid4()),'expectedRevision':3,'group':'cookies','patch':{'xueqiuCookieTargetId':'xueqiu'},'secretActions':{'xueqiuCookie':{'action':'set','value':'synthetic-cookie=private'}},'password':PASSWORD})
    assert saved.status_code==200,saved.text
    rid=str(uuid4());command={'requestId':rid,'expectedRevision':4,'currentPassword':PASSWORD}
    rejected=await client.post('/api/settings/xueqiu-cookie',json={**command,'currentPassword':'wrong'})
    assert rejected.status_code==403,rejected.text
    reveal=await client.post('/api/settings/xueqiu-cookie',json=command)
    assert reveal.status_code==200 and reveal.json()['cookie']=='synthetic-cookie=private',reveal.text
    assert (await client.post('/api/settings/xueqiu-cookie',json=command)).json()==reveal.json()
    async with db.connection()as conn:
        row=await(await conn.execute('SELECT result FROM provider_setting_operations WHERE owner_id=%s AND request_id=%s',(admin,rid))).fetchone()
        assert 'synthetic-cookie'not in json.dumps(row['result'])and'cookie'not in row['result']


async def test_old_layout_declarations_round_trip_same_authority_and_model_health_exact_config(client,db,admin,monkeypatch):
    from test_private_workflow import policy
    command={'requestId':str(uuid4()),'revision':0,'privateRevision':0,'currentPassword':PASSWORD,'appDisplayName':'Synthetic display','stockIconCdn':True,'markets':['US','HK'],'indicesOrder':['dji','spx'],'holdingColumns':[{'key':'qty','visible':False}]}
    saved=await client.put('/api/settings',json=command)
    assert saved.status_code==200,saved.text
    view=await client.get('/api/settings');values=view.json()['settings']
    assert values['appDisplayName']=='Synthetic display'and values['stockIconCdn']is True and values['markets']==['US','HK']and values['indicesOrder']==['dji','spx']
    assert next(v for v in values['holdingColumns']if v['key']=='qty')['visible']is False
    assert (await client.put('/api/settings',json=command)).json()==saved.json()
    service={'id':'gateway','name':'Explicit gateway','provider':'openai','apiUrl':'https://example.com/chat/completions','models':['explicit-model'],'selectedModel':'explicit-model','approval':policy(db,admin)}
    configured=await client.post('/api/admin/private-runtime-settings',json={'requestId':str(uuid4()),'expectedRevision':0,'group':'models','patch':{'modelServices':[service]},'secretActions':{'modelServices.gateway.apiKey':{'action':'set','value':'synthetic-key'}},'password':PASSWORD})
    assert configured.status_code==200,configured.text
    calls=[]
    async def read(target):
        calls.append(target);return {'raw':b'{"choices":[{"finish_reason":"stop","message":{"content":"actual controlled reply"}}]}','status':200,'complete':True,'latencyMs':1}
    monkeypatch.setattr('alcor_api.provider_setting_operations.model_read',read)
    raw={'requestId':str(uuid4()),'expectedRevision':1,'serviceId':'gateway','model':'explicit-model'}
    checked=await client.post('/api/settings/model-test',json=raw)
    assert checked.status_code==200 and checked.json()['ok']is True,checked.text
    assert (await client.post('/api/settings/model-test',json=raw)).json()==checked.json()and len(calls)==1
    health=await client.get('/api/settings/model-test')
    assert health.status_code==200 and health.json()['tests']['gateway:explicit-model']['requestId']==raw['requestId'],health.text
