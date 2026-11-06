"""Actual HTTP recognition admission with synthetic bytes and no provider IO."""
import hashlib
import io
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
from PIL import Image
from test_card_wallet import owner

ROOT = '/api/account/card-recognition'


def image():
    output = io.BytesIO()
    Image.new('RGB',(2,2),'white').save(output,format='PNG')
    return output.getvalue()


def install(settings, uid):
    settings.card_ocr_targets = [{'id':'synthetic-card-model','ownerId':uid,
        'instanceId':str(settings.instance_id),'approvedAccess':True,'purpose':'card.image.recognize',
        'licenseRevision':'synthetic-license','expiresAt':(datetime.now(UTC)+timedelta(days=1)).isoformat(),
        'provider':'deepseek','host':'api.deepseek.com','model':'deepseek-flash',
        'addresses':['8.8.8.8'],'credentialCiphertext':'synthetic-not-used'}]


async def upload(client, rid):
    return await client.post(ROOT+'/operations',data={'requestId':rid,'targetId':'synthetic-card-model'},files={'file':('synthetic.png',image(),'image/png')})


async def test_recognition_candidate_replay_current_permission_and_private_originals(client, app, settings, db, monkeypatch):
    uid = await owner(client)
    install(settings,uid)
    calls = []
    raw = json.dumps({'model':'deepseek-flash','choices':[{'finish_reason':'stop','message':{'content':json.dumps({'name':'Synthetic Card','bank':'Synthetic Bank','region':'美国','brand':'Visa','type':'借记卡','level':None,'number':'4111111111111111','cvv':'123','balance':'999'})}}]}).encode()
    async def fetch(target, prepared, mime, *, before_request=None):
        await before_request()
        calls.append(prepared)
        return raw,200,True
    monkeypatch.setattr(app.state.card_recognition,'fetch',fetch)
    rid = str(uuid4())
    response = await upload(client,rid)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['state'] == 'recognized' and data['financialWrites'] is False
    assert set(data['card']) == {'name','bank','region','type','brand','level'}
    assert '4111111111111111' not in response.text and '999' not in response.text
    assert (await upload(client,rid)).json() == data and len(calls) == 1
    page = await client.get(ROOT+'/originals/'+data['sourcePageId'])
    assert page.content == raw
    assert (await client.get(ROOT+'/operations/'+rid+'/input')).content == image()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as peer:
        await owner(peer,'RecognitionPeer')
        assert (await peer.get(ROOT+'/operations/'+rid)).status_code == 404
        assert (await peer.get(ROOT+'/originals/'+data['sourcePageId'])).status_code == 404
        assert (await peer.get(ROOT+'/operations/'+rid+'/input')).status_code == 404
    settings.card_ocr_targets=[]
    unavailable = await client.get(ROOT+'/operations/'+rid)
    assert unavailable.status_code == 200 and unavailable.json()['state'] == 'unavailable' and unavailable.json()['card'] is None
    assert (await client.get(ROOT+'/originals/'+data['sourcePageId'])).content == raw
    async with db.connection() as conn:
        for table in ('card_wallet_accounts','card_custom_records','cash_ledger_entries'):
            assert (await (await conn.execute('SELECT count(*) AS n FROM '+table+' WHERE owner_id=%s',(uid,))).fetchone())['n'] == 0
        stored = await (await conn.execute('SELECT raw_sha256 FROM card_recognition_pages WHERE owner_id=%s',(uid,))).fetchone()
        assert stored['raw_sha256'] == hashlib.sha256(raw).hexdigest()


async def test_incomplete_original_retained_unknown_never_reissued_and_preflight_target_change(client,app,settings,monkeypatch):
    uid = await owner(client)
    install(settings,uid)
    calls=[]
    raw=b'{"choices":[{"message":'
    async def fetch(target,prepared,mime,*,before_request=None):
        await before_request()
        calls.append(1)
        return raw,200,False
    monkeypatch.setattr(app.state.card_recognition,'fetch',fetch)
    rid=str(uuid4())
    first=await upload(client,rid)
    assert first.status_code == 200 and first.json()['state'] == 'unknown',first.text
    assert (await client.get(ROOT+'/originals/'+first.json()['sourcePageId'])).content == raw
    assert (await upload(client,rid)).json() == first.json()
    assert {**(await client.get(ROOT+'/operations/'+rid)).json(), 'legacyClientIdempotency':True} == first.json()
    assert len(calls)==1
    async def no_io(target,prepared,mime,*,before_request=None):
        settings.card_ocr_targets=[]
        await before_request()
        raise AssertionError('revoked target must prevent IO')
    monkeypatch.setattr(app.state.card_recognition,'fetch',no_io)
    stopped=await upload(client,str(uuid4()))
    assert stopped.status_code==200 and stopped.json()['state']=='unavailable',stopped.text


async def test_actor_revoked_after_admission_stops_io_and_retires_http_context(client,app,settings,db,monkeypatch):
    uid=await owner(client)
    install(settings,uid)
    async def no_io(target,prepared,mime,*,before_request=None):
        async with db.connection() as conn:
            await conn.execute('UPDATE users SET session_version=session_version+1 WHERE id=%s',(uid,))
        await before_request()
        raise AssertionError('revoked actor must prevent IO')
    monkeypatch.setattr(app.state.card_recognition,'fetch',no_io)
    rid=str(uuid4())
    response=await upload(client,rid)
    assert response.status_code==401 and response.headers.get('x-alcor-retire-context')=='true',response.text
    async with db.connection() as conn:
        row=await(await conn.execute('SELECT result FROM card_recognition_operations WHERE owner_id=%s AND request_id=%s',(uid,rid))).fetchone()
        assert row['result']['state']=='unavailable'
        assert (await(await conn.execute('SELECT count(*) AS n FROM card_recognition_pages WHERE owner_id=%s',(uid,))).fetchone())['n']==0


async def test_real_fetch_keeps_received_prefix_and_rechecks_before_stream(monkeypatch):
    from types import SimpleNamespace

    from alcor_api import card_recognition as module
    from cryptography.fernet import Fernet
    key=Fernet.generate_key()
    instance=uuid4()
    target={'id':'synthetic','provider':'deepseek','model':'deepseek-flash','host':'api.deepseek.com','addresses':['8.8.8.8']}
    target['credentialCiphertext']=Fernet(key).encrypt(json.dumps({'kind':'card-ocr:synthetic','instance':str(instance),'password':'synthetic-token-not-real'}).encode()).decode()
    service=module.CardRecognition(SimpleNamespace(settings=SimpleNamespace(instance_id=instance)))
    monkeypatch.setattr(module,'NotificationSecurity',lambda db:SimpleNamespace(existing_key=lambda:key))
    async def resolved(*args):return ['8.8.8.8']
    monkeypatch.setattr(module,'resolve',resolved)
    monkeypatch.setattr(module,'approved_target',lambda *args:['8.8.8.8'])
    prefix=b'{"synthetic":"retained prefix"'
    checks=[]
    class Response:
        status=200
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        async def aiter_stream(self):
            yield prefix
            raise OSError('synthetic interruption')
    class Pool:
        def __init__(self,**kwargs):assert kwargs['retries']==0
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        def stream(self,*args,**kwargs):
            assert len(checks)==2
            return Response()
    monkeypatch.setattr(module.httpcore,'AsyncConnectionPool',Pool)
    async def check():checks.append(1)
    assert await service.fetch(target,image(),'image/png',before_request=check)==(prefix,200,False)


async def test_old_recognize_registered_original_and_disabled_source_response(client,app,settings,tmp_path,monkeypatch):
    uid=await owner(client)
    disabled=await client.post('/api/cards/recognize',json={'image':'/uploads/not-installed.png'})
    assert disabled.status_code==200 and disabled.json()=={'enabled':False,'card':None}
    settings.file_root=tmp_path/'synthetic-images'
    material=await client.post('/api/admin/shared-assets/upload',data={'kind':'asset','folder':'card','name':'Synthetic image','requestId':str(uuid4()),'expectedRevision':'0'},files={'file':('synthetic.png',image(),'image/png')})
    assert material.status_code==200,material.text
    install(settings,uid)
    calls=[]
    async def fetch(target,prepared,mime,*,before_request=None):
        await before_request()
        calls.append(1)
        return json.dumps({'model':'deepseek-flash','choices':[{'finish_reason':'stop','message':{'content':'{"name":"Synthetic","bank":null,"region":null,"type":null,"brand":null,"level":null}'}}]}).encode(),200,True
    monkeypatch.setattr(app.state.card_recognition,'fetch',fetch)
    rid=str(uuid4())
    data={'requestId':rid,'image':material.json()['legacyUrl']}
    first=await client.post('/api/cards/recognize',json=data)
    assert first.status_code==200 and first.json()['enabled'] is True and first.json()['card']=={'name':'Synthetic','bank':None,'region':None,'type':None,'brand':None,'level':None},first.text
    assert (await client.post('/api/cards/recognize',json=data)).json()==first.json()
    assert len(calls)==1
    for path in ('https://example.invalid/x.png','/uploads/../x.png','/uploads/unregistered.png'):
        rejected=await client.post('/api/cards/recognize',json={'image':path})
        assert rejected.status_code in (400,404),rejected.text
    assert len(calls)==1
