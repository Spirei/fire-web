"""Real old HTTP adapters and durable links; all provider transports are local fakes."""
from datetime import UTC,datetime,timedelta
from uuid import uuid4

import pytest

from tests.price_alerts_candidate.test_price_alerts import alert_settings,alerts,native_pair
from tests.price_alerts_candidate.test_notification_bindings import install,configure

__all__=['alert_settings','alerts']


@pytest.mark.parametrize('version',[1,2])
async def test_old_social_and_telegram_link_actual_provider_uuid_and_expiry(alerts,version,monkeypatch):
    client,app,service,_=alerts
    wire,smtp=install(service)
    from dataclasses import replace
    target=service.providers.targets['fixture-telegram']
    service.providers.targets[target.id]=replace(target,label='我的电报通知')
    await configure(client,'telegram')
    read=await native_pair(app,'portfolio.read')
    read_headers={'authorization':'Bearer '+read['access_token']}
    prefix=f'/api/v{version}'
    response=await client.get(prefix+'/social-channels',headers=read_headers)
    assert response.status_code==200,response.text
    assert response.headers['x-alcor-api-version']==str(version)
    rows=response.json()['data']['channels']
    assert [row['id'] for row in rows]==['wechat','telegram','feishu','qq','discord','webpush','email']
    telegram=next(row for row in rows if row['id']=='telegram')
    assert telegram['name']=='我的电报通知'
    assert telegram['configured'] and telegram['bot_username']=='FixtureAlertsBot' and not telegram['ready']
    assert telegram['api_base'] is None
    assert '123456:'+('x'*30) not in response.text and 'target_fingerprint' not in response.text
    assert (await client.post(prefix+'/price-alerts/telegram-link',headers=read_headers,json={})).status_code==403
    grant=await native_pair(app)
    headers={'authorization':'Bearer '+grant['access_token'],'x-alcor-request-id':str(uuid4())}
    calls=len(wire.calls)
    linked=await client.post(prefix+'/price-alerts/telegram-link',headers=headers,json={})
    assert linked.status_code==200,linked.text
    result=linked.json()['data']
    assert result['state']=='pending' and result['legacyClientIdempotency'] is True
    assert result['requestId']==headers['x-alcor-request-id'] and result['url'].startswith('https://t.me/FixtureAlertsBot?start=')
    assert (await client.post(prefix+'/price-alerts/telegram-link',headers=headers,json={})).json()==linked.json()
    receipt=await client.get('/api/notifications/telegram-links/operations/'+result['requestId'],headers=headers)
    assert receipt.status_code==200 and receipt.json()==result
    assert len(wire.calls)==calls and smtp.messages==[]  # links never send a message
    # Same owner, different grant cannot recover the secret start URL.
    other=await native_pair(app)
    denied=await client.get('/api/notifications/telegram-links/operations/'+result['requestId'],headers={'authorization':'Bearer '+other['access_token']})
    assert denied.status_code==403 and result['url'] not in denied.text
    from urllib.parse import parse_qs,urlsplit
    from alcor_api.notification_telegram import poll
    from alcor_api.business_notification_worker import dispatch_one
    from alcor_api.notification_sender import Sender
    nonce=parse_qs(urlsplit(result['url']).query)['start'][0]
    wire.updates=[{'update_id':1,'message':{'text':'/start '+nonce,'chat':{'type':'private','id':456},'from':{'id':456,'is_bot':False}}}]
    assert (await poll(service.providers,uuid4()))['received']==1
    async def old_operation(raw):
        rid=str(uuid4())
        response=await client.post(prefix+'/price-alerts/operations/'+rid,headers=headers,json=raw)
        assert response.status_code==200,response.text
        assert (await client.get(prefix+'/price-alerts/operations/'+rid,headers=headers)).json()==response.json()
        return response.json()['data']
    confirmed=await old_operation({'action':'telegram_confirm','revision':1,'enabled':True})
    assert next(row for row in confirmed['snapshot']['channels']if row['channel']=='telegram')['ready']
    await old_operation({'action':'test','channel':'telegram'})
    count=len(wire.messages)
    assert await dispatch_one(app.state.db,uuid4(),Sender(service.bindings))=='accepted'
    assert await dispatch_one(app.state.db,uuid4(),Sender(service.bindings))=='idle'
    assert len(wire.messages)==count+1
    calls=len(wire.calls)
    import alcor_api.notification_bindings as bindings
    future=datetime.now(UTC)+timedelta(minutes=10)
    class Expired(datetime):
        @classmethod
        def now(cls,tz=None):return future if tz else future.replace(tzinfo=None)
    monkeypatch.setattr(bindings,'datetime',Expired)
    expired=await client.get('/api/notifications/telegram-links/operations/'+result['requestId'],headers=headers)
    assert expired.status_code==200 and expired.json()['state']=='expired' and expired.json()['url'] is None
    assert len(wire.calls)==calls
    async with app.state.db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM business_notification_telegram_link_operations')).fetchone())['n']==1


@pytest.mark.parametrize('path',['/api/notifications/providers','/api/notifications/provider-targets','/api/price-alerts'])
async def test_bad_explicit_authorization_never_inherits_cookie(alerts,path):
    client,_,service,_=alerts
    for bad in ('','garbage','Bearer malformed'):
        response=await client.get(path,headers={'authorization':bad})
        assert response.status_code==401,response.text
    duplicated=await client.get(path,headers=[('authorization','Bearer wrong'),('authorization','Bearer other')])
    assert duplicated.status_code==401,duplicated.text
    assert service.reader.calls==0


@pytest.mark.parametrize('path',['/api/notifications/providers','/api/notifications/provider-targets'])
async def test_private_channel_reads_recheck_actor_after_http_identity(alerts,path,monkeypatch):
    client,app,service,_=alerts
    original=service.authorize_read
    async def revoke(conn,who):
        async with app.state.db.connection() as other:
            await other.execute('DELETE FROM sessions WHERE token_hash=%s',(who.token_hash,))
        return await original(conn,who)
    monkeypatch.setattr(service,'authorize_read',revoke)
    response=await client.get(path)
    assert response.status_code==401,response.text
    assert 'providers' not in response.text and 'targets' not in response.text
    async with app.state.db.connection() as conn:
        for table in ('price_alert_collections','price_alert_operations','business_notification_events'):
            assert (await(await conn.execute('SELECT count(*) n FROM '+table)).fetchone())['n']==0


@pytest.mark.parametrize('version',[1,2])
@pytest.mark.parametrize('channel',['wechat','feishu','discord','qq'])
async def test_old_binding_actions_keep_native_consent_and_one_actual_fake_delivery(alerts,version,channel):
    import re
    from alcor_api.business_notification_worker import dispatch_one
    from alcor_api.notification_sender import Sender
    from tests.price_alerts_candidate.test_notification_bindings import DESTINATIONS
    client,app,service,_=alerts
    wire,_=install(service)
    await configure(client,channel)
    grant=await native_pair(app)
    headers={'authorization':'Bearer '+grant['access_token'],'x-alcor-price-alerts':'messengers-v1'}
    path=f'/api/v{version}/price-alerts'
    social=await client.get(f'/api/v{version}/social-channels',headers=headers)
    assert social.status_code==200,social.text
    declared=next(row for row in social.json()['data']['channels']if row['id']==channel)
    assert declared['configured'] and declared['bindable'] and not declared['ready']
    async def old(raw,rid=None):
        rid=rid or str(uuid4())
        response=await client.post(path+'/operations/'+rid,headers=headers,json=raw)
        assert response.status_code==200,response.text
        read=await client.get(path+'/operations/'+rid,headers=headers)
        assert read.status_code==200 and read.json()==response.json()
        return response.json()['data'],rid
    start={'action':channel+'_start','recipient':DESTINATIONS[channel],'revision':0}
    # New Web protocol retains its factor proof. A body flag cannot select old policy.
    assert (await client.post('/api/price-alerts/operations/'+str(uuid4()),json=start,headers={'x-alcor-price-alerts':'messengers-v1'})).status_code==428
    assert (await client.post(path+'/operations/'+str(uuid4()),json={**start,'legacy':True},headers=headers)).status_code==400
    begun,rid=await old(start)
    duplicate=await client.post(path+'/operations/'+rid,headers=headers,json=start)
    assert duplicate.status_code==409  # old mutation protocol requires GET original receipt
    state=next(row for row in begun['snapshot']['channels']if row['channel']==channel)
    assert await dispatch_one(app.state.db,uuid4(),Sender(service.bindings))=='accepted'
    code=re.search(r'验证码：(\d{6})',wire.messages[-1])[1]
    confirmed,_=await old({'action':channel+'_confirm','challengeId':state['challengeId'],'verificationCode':code,'revision':1,'enabled':True})
    assert next(row for row in confirmed['snapshot']['channels']if row['channel']==channel)['ready']
    tested,_=await old({'action':'test','channel':channel})
    count=len(wire.messages)
    assert await dispatch_one(app.state.db,uuid4(),Sender(service.bindings))=='accepted'
    assert await dispatch_one(app.state.db,uuid4(),Sender(service.bindings))=='idle'
    assert len(wire.messages)==count+1
    snapshot=await client.get(path,headers=headers)
    event=next(row for row in snapshot.json()['data']['events']if any(d['channel']==channel for d in row['deliveries']))
    delivery=next(row for row in event['deliveries']if row['channel']==channel)
    receipt=await client.get('/api/notifications/deliveries/'+delivery['id'],headers=headers)
    assert receipt.status_code==200 and receipt.json()['state']=='accepted' and not receipt.json()['willRetryAutomatically']
    # Native write consent never comes from a cookie or a read-only connection.
    read=await native_pair(app,'portfolio.read')
    assert (await client.post(path+'/operations/'+str(uuid4()),json={'action':channel+'_disconnect','revision':2},headers={'authorization':'Bearer '+read['access_token'],'x-alcor-price-alerts':'messengers-v1'})).status_code==403
    assert (await client.post(path+'/operations/'+str(uuid4()),json={'action':channel+'_disconnect','revision':2})).status_code==401
    disconnected,_=await old({'action':channel+'_disconnect','revision':2})
    assert not next(row for row in disconnected['snapshot']['channels']if row['channel']==channel)['ready']


@pytest.mark.parametrize('version',[1,2])
async def test_old_rule_actions_monitor_inbox_mark_read_delete_and_original_receipt(alerts,version):
    from tests.price_alerts_candidate.test_price_alerts import rule,run
    client,app,service,clock=alerts
    grant=await native_pair(app)
    headers={'authorization':'Bearer '+grant['access_token']}
    prefix=f'/api/v{version}/price-alerts'
    async def old(raw):
        rid=str(uuid4())
        response=await client.post(prefix+'/operations/'+rid,headers=headers,json=raw)
        assert response.status_code==200,response.text
        assert (await client.get(prefix+'/operations/'+rid,headers=headers)).json()==response.json()
        return response.json()['data'],rid
    config=rule()
    first,rid=await old({'action':'upsert','ruleId':config['id'],'revision':0,'rule':config})
    await old({'action':'state','ruleId':config['id'],'revision':1,'state':'paused'})
    await old({'action':'state','ruleId':config['id'],'revision':2,'state':'enabled'})
    await old({'action':'test','channel':'app'})
    clock[0]+=timedelta(seconds=1)
    assert (await run(service))[1]=='triggered'
    snapshot=(await client.get(prefix,headers=headers)).json()['data']
    assert len(snapshot['events'])==2 and snapshot['unreadCount']==2
    actual=next(row for row in snapshot['events']if row.get('priceExact'))
    assert actual['priceExact']=='340.000001' and actual['deliveries'][0]['channel']=='app'
    read,_=await old({'action':'read','eventIds':[row['id']for row in snapshot['events']]})
    assert read['snapshot']['unreadCount']==0
    active=next(row for row in read['snapshot']['rules']if row['rule']['id']==config['id'])
    deleted,_=await old({'action':'delete','ruleId':config['id'],'revision':active['revision']})
    assert not any(row['rule']['id']==config['id']for row in deleted['snapshot']['rules'])
    assert (await client.get(prefix+'/operations/'+rid,headers=headers)).json()['data']==first
    async with app.state.db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM business_notification_events')).fetchone())['n']==2
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==0
        assert (await(await conn.execute('SELECT count(*) n FROM cash_ledger_entries')).fetchone())['n']==0


def test_public_target_label_is_bounded_and_absence_preserves_old_fingerprint():
    import hashlib,json
    from dataclasses import asdict,replace
    from alcor_api.notification_providers import ProviderTarget
    target=ProviderTarget('synthetic','telegram',{},approved_access=True,fixture=True)
    original=asdict(target);original.pop('label');original.pop('public_discovery')
    assert target.fingerprint==hashlib.sha256(json.dumps(original,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    for invalid in ('','x'*81,'private\nsecret',{'not':'text'}):
        with pytest.raises(ValueError):replace(target,label=invalid)


@pytest.mark.parametrize('version',[1,2])
async def test_webpush_explicit_public_discovery_never_installs_a_delivery_consumer(alerts,version):
    from alcor_api.notification_providers import ProviderTarget
    client,app,service,_=alerts
    wire,_=install(service)
    grant=await native_pair(app)
    headers={'authorization':'Bearer '+grant['access_token']}
    path=f'/api/v{version}/social-channels'
    row=next(row for row in (await client.get(path,headers=headers)).json()['data']['channels']if row['id']=='webpush')
    assert row['enabled']is None and row['configured']is None and row['configurationKnown']is False and row['bindable']is False
    target=ProviderTarget('public-webpush','webpush',{},approved_access=True,label='已迁公开发现',public_discovery={'enabled':True,'configured':True})
    service.providers.targets[target.id]=target
    row=next(row for row in (await client.get(path,headers=headers)).json()['data']['channels']if row['id']=='webpush')
    assert row['enabled']is True and row['configured']is True and row['configurationKnown']is True
    assert row['name']=='已迁公开发现' and row['bindable']is False and row['ready']is False
    targets=await client.get('/api/notifications/provider-targets')
    assert all(row['channel']!='webpush'for row in targets.json()['targets'])
    denied=await client.post(f'/api/v{version}/price-alerts/operations/'+str(uuid4()),headers=headers,json={'action':'test','channel':'webpush'})
    assert denied.status_code==400,denied.text
    assert wire.calls==[] and wire.messages==[]
