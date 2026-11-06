"""Frozen actual QQ source versus the installed, pinned Alcor transport contract."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
from uuid import uuid4

import pytest
from alcor_api.notification_provider_protocols import ProviderRejected,send
from alcor_api.business_notification_worker import dispatch_one
from alcor_api.notification_sender import Sender
from tests.price_alerts_candidate.test_provider_protocols import Wire,allowed
from tests.price_alerts_candidate.test_notification_bindings import alert_settings,alerts,install,configure,binding_mutation

__all__=['alert_settings','alerts']


async def test_actual_frozen_qq_send_oracle_matches_new_method_path_payload_and_redacted_receipt(tmp_path):
    root=os.environ.get('ALCOR_ALERT_LEGACY_ROOT')
    if not root:pytest.skip('Explicit frozen original source root required')
    here=Path(__file__).resolve().parent
    result=subprocess.run(['node',str(here/'run_qq_golden.cjs'),root,str(here.parent/'price_alerts_candidate/source-evidence.json')],capture_output=True,text=True,timeout=15)
    assert result.returncode==0,result.stderr
    old=json.loads(result.stdout)
    (tmp_path/'old-qq-redacted-oracle.json').write_text(json.dumps(old,ensure_ascii=True,indent=2))
    assert old['real_network']is False and old['results'][0]['accepted']
    content='a'*1799+'🙂x'
    wire=Wire([{'access_token':'synthetic-access','expires_in':'3600'},{'id':'synthetic-receipt'}])
    receipt=await send('qq',{'appId':'12345678','appSecret':'synthetic-only'},'a'*20,content,allowed,wire)
    assert receipt.id=='synthetic-receipt' and receipt.protocol=='qq-bot-api-v2'
    hosts={'auth':'bots.qq.com','api':'api.sgroup.qq.com'}
    for original,current in zip(old['results'][0]['calls'],wire.calls,strict=True):
        label,method,path,kwargs=current
        assert (hosts[label],method,path)==(original['host'],original['method'],original['path'])
        body=kwargs['json_body']
        assert sorted(body)==original['fields']
        assert (body.get('appId')or kwargs.get('headers',{}).get('X-Union-Appid'))==original['appId']
        if 'content'in body:
            encoded=body['content'].encode('utf-16-le',errors='surrogatepass')
            assert len(encoded)//2==original['contentUtf16Units']==1800
            assert hashlib.sha256(encoded).hexdigest()==original['contentUtf16Sha']
            assert kwargs['headers']['Authorization'].split(' ')[0]==original['authorizationScheme']=='QQBot'
            assert body['msg_type']==original['msg_type']==0
    # Credentials never appear in saved oracle output; only protocol metadata/hash.
    assert 'synthetic-access'not in result.stdout and 'synthetic-only'not in result.stdout
    permits=iter([True,False])
    async def revoked():return next(permits)
    denied=Wire([{'access_token':'synthetic-access','expires_in':3600}])
    with pytest.raises(ProviderRejected):await send('qq',{'appId':'12345678','appSecret':'synthetic-only'},'a'*20,content,revoked,denied)
    assert len(denied.calls)==len(old['results'][1]['calls'])==1
    rejected=Wire([{'access_token':'synthetic-access','expires_in':3600},{'code':40001}])
    with pytest.raises(ProviderRejected):await send('qq',{'appId':'12345678','appSecret':'synthetic-only'},'a'*20,content,allowed,rejected)
    assert len(rejected.calls)==len(old['results'][2]['calls'])==2


@pytest.mark.parametrize('revoke_target',[False,True])
async def test_qq_unknown_never_repeats_and_target_revoke_after_token_prevents_send(alerts,revoke_target):
    client,app,service,_=alerts
    wire,_=install(service)
    await configure(client,'qq')
    started,rid=await binding_mutation(client,{'action':'qq_start','recipient':'a'*20,'revision':0})
    assert started.status_code==200,started.text
    if revoke_target:
        original=wire.call
        async def removed(label,method,path,**kwargs):
            response=await original(label,method,path,**kwargs)
            if path=='/app/getAppAccessToken':service.providers.targets.clear()
            return response
        wire.call=removed
    else:wire.fail_message=True
    result=await dispatch_one(app.state.db,uuid4(),Sender(service.bindings))
    assert result==('failed'if revoke_target else 'unknown')
    calls=len(wire.calls)
    assert await dispatch_one(app.state.db,uuid4(),Sender(service.bindings))==('disabled'if revoke_target else 'idle')
    assert len(wire.calls)==calls and len(wire.messages)==(0 if revoke_target else 1)
    async with app.state.db.connection() as conn:
        row=await(await conn.execute("SELECT * FROM business_notification_deliveries WHERE channel='qq'")).fetchone()
    receipt=await client.get('/api/notifications/deliveries/'+str(row['id']))
    assert receipt.status_code==200 and receipt.json()['state']==result and not receipt.json()['willRetryAutomatically']
    assert (await client.get('/api/price-alerts/operations/'+rid,headers={'x-alcor-price-alerts':'messengers-v1'})).json()==started.json()
