"""No actual clipboard is read or written: host process admission is always mocked."""
import base64
import io
from uuid import uuid4

import pytest
from PIL import Image
from test_card_wallet import owner


def png():
    output=io.BytesIO();Image.new('RGB',(2,2),'white').save(output,format='PNG')
    return base64.b64encode(output.getvalue()).decode()


async def test_clipboard_explicit_host_receipt_replay_unknown_and_restored_context(client,app,settings,monkeypatch):
    await owner(client)
    service=app.state.local_host_clipboard
    monkeypatch.setattr(service,'installed',lambda who:False)
    disabled=await client.post('/api/clipboard',json={'requestId':str(uuid4()),'image':png()})
    assert disabled.status_code==503
    monkeypatch.setattr(service,'installed',lambda who:True)
    calls=[]
    class Process:
        returncode=None
        async def communicate(self):self.returncode=0;return b'ok',b''
        def kill(self):self.returncode=-9
        async def wait(self):return self.returncode
    async def spawn(*args,**kwargs):calls.append(args);return Process()
    monkeypatch.setattr('alcor_api.local_host_clipboard.asyncio.create_subprocess_exec',spawn)
    rid=str(uuid4());data={'requestId':rid,'image':png()}
    first=await client.post('/api/clipboard',json=data)
    assert first.status_code==200 and first.json()['ok'] is True and first.json()['clientClipboardConfirmed'] is False,first.text
    assert (await client.post('/api/clipboard',json=data)).json()==first.json() and len(calls)==1
    receipt=await client.get('/api/clipboard/operations/'+rid)
    assert receipt.headers['cache-control']=='no-store'
    assert {**receipt.json(),'legacyClientIdempotency':True}==first.json()
    historical=service.project({'result':receipt.json(),'request_id':rid,'origin_instance':uuid4()})
    assert historical['currentInstanceMatches'] is False and historical['currentHostEffectKnown'] is False
    class Unknown(Process):
        async def communicate(self):raise OSError('synthetic lost process outcome')
    async def uncertain(*args,**kwargs):calls.append(args);return Unknown()
    monkeypatch.setattr('alcor_api.local_host_clipboard.asyncio.create_subprocess_exec',uncertain)
    unknown={'requestId':str(uuid4()),'image':png()}
    response=await client.post('/api/clipboard',json=unknown)
    assert response.status_code==200 and response.json()['state']=='unknown'
    assert (await client.post('/api/clipboard',json=unknown)).json()==response.json() and len(calls)==2
    for headers in ({'authorization':''},{'authorization':'Bearer '},[('authorization','Bearer one'),('authorization','Bearer two')]):
        assert (await client.post('/api/clipboard',json=data,headers=headers)).status_code==401
    assert len(calls)==2


@pytest.mark.parametrize('revoked',['restore','actor'])
async def test_clipboard_preflight_rechecks_restore_and_actor_without_os_call(client,app,db,monkeypatch,revoked):
    uid=await owner(client);service=app.state.local_host_clipboard
    monkeypatch.setattr(service,'installed',lambda who:True)
    async def forbidden(*args,**kwargs):raise AssertionError('No actual OS admission after revocation')
    monkeypatch.setattr('alcor_api.local_host_clipboard.asyncio.create_subprocess_exec',forbidden)
    if revoked=='restore':
        checks=[]
        async def blocked(conn):checks.append(1);return len(checks)>1
        monkeypatch.setattr('alcor_api.fx_reference.external_delivery_blocked',blocked)
    else:
        checks=[];lock=service.lock
        async def recheck(conn,who):
            checks.append(1)
            if len(checks)==2:
                async with db.connection() as other:
                    await other.execute('UPDATE users SET session_version=session_version+1 WHERE id=%s',(uid,))
            return await lock(conn,who)
        monkeypatch.setattr(service,'lock',recheck)
    rid=str(uuid4())
    response=await client.post('/api/clipboard',json={'requestId':rid,'image':png()})
    assert response.status_code==(200 if revoked=='restore' else 401),response.text
    if revoked=='actor':assert response.headers['x-alcor-retire-context']=='true'
    async with db.connection() as conn:
        row=await(await conn.execute('SELECT result FROM host_clipboard_operations WHERE owner_id=%s AND request_id=%s',(uid,rid))).fetchone()
        assert row['result']['state']=='unavailable'
