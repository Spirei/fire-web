"""Old desired-state leases, one shared domain, UUID replay and permission guards."""

import asyncio
import hashlib
import json
import os
import subprocess
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from alcor_api.backups import tables_and_hashes
from alcor_api.market_contract import MARKETS
from alcor_api.market_worker import claim, execute, schedule
from alcor_api.native_app_auth import issue_grant
from market_latest_candidate.test_market_alerts import attach
from market_latest_candidate.test_market_worker_process import (
    test_independent_worker_source_pg_fact_f19_reader_after_submitting_client_closes as worker_process_oracle,
)
from price_alerts_candidate.test_price_alerts import upsert

HERE=Path(__file__).parent
PATH='/api/v2/quote-subscriptions'


async def native(app,scope='portfolio.read portfolio.write',owner=None):
    async with app.state.db.connection() as conn:
        user=await (await conn.execute('SELECT * FROM users WHERE id=%s',(owner,))).fetchone() if owner else await (await conn.execute("SELECT * FROM users WHERE username='MarketReader'")).fetchone()
        grant=await issue_grant(conn,user,scope,'Synthetic subscription device')
    return {'authorization':'Bearer '+grant['access_token']},grant


def items(*codes):return {'items':[{'market':'US','code':code} for code in (codes or ('AAPL',))]}


async def test_frequent_quote_observation_renews_intent_without_shortening_source_cadence(market):
    client,app,_authority,transport,revision=market
    headers,_=await native(app)
    headers['x-alcor-market-source']=revision
    quote={'items':[{'id':'held','market':'US','code':'AAPL'}]}
    first=await client.post('/api/v2/quotes',json=quote,headers=headers)
    assert first.status_code==200,first.text
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE market_streams SET next_due=clock_timestamp()+interval '5 minutes'")
        before=(await (await conn.execute('SELECT next_due FROM market_streams')).fetchone())['next_due']
    again=await client.post('/api/v2/quotes',json=quote,headers=headers)
    assert again.status_code==200,again.text
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT next_due FROM market_streams')).fetchone())['next_due']==before
        await conn.execute("UPDATE market_demands SET hot_until=clock_timestamp()-interval '1 second'")
    revived=await client.post('/api/v2/quotes',json=quote,headers=headers)
    assert revived.status_code==200,revived.text
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT next_due<clock_timestamp() AS awake FROM market_streams')).fetchone())['awake']
    assert transport.calls==0


async def test_automatic_multi_security_selection_checks_source_catalog_once_per_operation(market,monkeypatch):
    from alcor_api.market_authority import Authority

    client,app,authority,transport,_revision=market
    base=authority.policies[0]
    authority.policies=tuple(replace(base,id=source,source=source,source_version=version,purposes=('latest',),markets=('US',))
        for source,version in [('futu','futu-sdk-records-v1'),('tencent','tencent-quotes-v1'),('eastmoney','eastmoney-quotes-v1')])
    for policy in authority.policies:
        saved=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':policy.id})
        assert saved.status_code==200,saved.text
    object.__setattr__(app.state.db.settings,'_legacy_quote_source','auto')
    headers,_=await native(app)
    calls=0
    config=Authority.config
    async def checked(self,*args,**kwargs):
        nonlocal calls
        calls+=1
        return await config(self,*args,**kwargs)
    monkeypatch.setattr(Authority,'config',checked)
    response=await client.post('/api/v2/quotes',headers=headers,json={
        'items':[{'id':str(i),'market':'US','code':f'SYN{i:02}'} for i in range(19)]})
    assert response.status_code==200,response.text
    assert calls<60 and transport.calls==0


async def mutate(client,headers,value=None,*,method='POST',uid=None,path=PATH):
    supplied={**headers}
    if uid is not None:supplied['x-alcor-request-id']=str(uid)
    return await client.request(method,path,json=value or items(),headers=supplied)


async def domain_hashes(app):
    async with app.state.db.connection() as conn,conn.transaction():value=await tables_and_hashes(conn)
    return {key:row for key,row in value.items() if key.startswith('market_') or key in ('tasks','task_events')}


async def test_actual_old_route_store_and_service_goldens_for_six_markets_renew_and_cancel(market):
    root=os.environ.get('ALCOR_MARKET_LEGACY_ROOT')
    if not root:pytest.skip('Explicit read-only old source required')
    evidence=json.loads((HERE/'source-evidence.json').read_text())
    for name,wanted in evidence['source_sha256'].items():assert hashlib.sha256((Path(root)/name).read_bytes()).hexdigest()==wanted
    client,app,authority,transport,_revision=market
    # Reconfigure after changing the test instance policy fingerprint.
    authority.policies=(replace(authority.policies[0],markets=MARKETS),)
    configured=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'fixture'})
    assert configured.status_code==200,configured.text
    headers,_=await native(app);headers['x-alcor-market-source']=configured.json()['revision']
    steps=[('POST',{'items':[{'market':m,'code':c} for m,c in [('US','aapl.n'),('US','AAPL'),('HK','700'),('CN','1'),('JP','7203.T'),('KR','005930.KS'),('ASSET','BTC-USD')]]}),('POST',items('AAPL','MSFT')),('DELETE',{'items':[{'market':'HK','code':'00700'}]}),('DELETE',{'all':True})]
    actual=[];vectors=[]
    for method,value in steps:
        response=await mutate(client,headers,value,method=method)
        assert response.status_code==200,response.text
        actual.append(response.json());subs=response.json()['data']['subscriptions']
        async with app.state.db.connection() as conn:stamp=(await (await conn.execute('SELECT clock_timestamp() AS at')).fetchone())['at']
        vectors.append({'method':method,'body':value,'now':max([s['lastRequestedAt'] for s in subs] or [int(stamp.timestamp()*1000)])})
    result=json.loads(await asyncio.to_thread(subprocess.check_output,['node',str(HERE/'run_subscription_golden.cjs'),root],input=json.dumps({'steps':vectors}),text=True))
    assert result['memoryOnly'] is True and result['syncCalls']>=4
    for current,old in zip(actual,result['results'],strict=True):
        assert old['status']==200
        wanted=old['body']['data']['subscriptions'];seen=current['data']['subscriptions']
        assert [{k:v for k,v in row.items() if k not in ('lastRequestedAt','expiresAt')} for row in seen]==[{**{k:v for k,v in row.items() if k not in ('lastRequestedAt','expiresAt')}, 'sourcePermission':'current'} for row in wanted]
        for row in seen:assert 0<=7*86400000-(row['expiresAt']-row['lastRequestedAt'])<1000
    assert transport.calls==0


async def test_original_UUID_replay_is_exact_and_receipt_survives_new_app_domain_instance(market):
    client,app,authority,transport,_revision=market;headers,_=await native(app);uid=uuid4()
    first=await mutate(client,headers,uid=uid);assert first.status_code==200,first.text
    assert first.headers['x-alcor-request-id']==str(uid)
    before=await domain_hashes(app)
    replay=await mutate(client,headers,uid=uid)
    assert replay.json()==first.json() and replay.headers['x-alcor-operation-replay']=='true'
    assert await domain_hashes(app)==before
    collision=await mutate(client,headers,items('MSFT'),uid=uid)
    assert collision.status_code==409 and await domain_hashes(app)==before
    from alcor_api.market_authority import Authority
    from alcor_api.market_subscription_writes import Subscriptions
    restored=Subscriptions(Authority(app.state.db,authority.policies))
    async with app.state.db.connection() as conn:
        receipt=await restored.authority.receipt(conn,authority.policies[0].owner_id,uid)
    assert receipt['subscriptions']==first.json()['data']['subscriptions']
    assert transport.calls==0


async def test_two_devices_aggregate_and_owner_cancel_all_preserves_background_alert_demand(market):
    client,app,authority,transport,_revision=market
    await attach(app,authority);await upsert(client)
    from alcor_api.market_alert_reader import project_alert_demands
    assert await project_alert_demands(authority)==1
    a,_=await native(app);b,_=await native(app)
    assert (await mutate(client,a)).status_code==200
    assert (await mutate(client,b)).status_code==200
    listed=await client.get(PATH,headers=b);assert len(listed.json()['data']['subscriptions'])==1
    assert await schedule(authority)==1
    removed=await mutate(client,a,{'all':True},method='DELETE')
    assert removed.status_code==200 and removed.json()['data']['subscriptions']==[]
    assert (await client.get(PATH,headers=b)).json()['data']['subscriptions']==[]
    async with app.state.db.connection() as conn:
        rows=await (await conn.execute('SELECT origin,revoked_at FROM market_demands')).fetchall()
    assert sum(row['origin']=='client' and row['revoked_at'] is not None for row in rows)==2
    assert sum(row['origin']=='price.alert' and row['revoked_at'] is None for row in rows)==1
    task=await claim(app.state.db,uuid4());assert task
    assert await execute(authority,task,transport)=='observed' and transport.calls==1
    assert (await client.get('/api/price-alerts')).json()['events']==[]


async def test_cancel_inflight_cannot_publish_fact_and_new_explicit_registration_can_resume(market):
    client,app,authority,transport,_revision=market;headers,_=await native(app)
    assert (await mutate(client,headers)).status_code==200;await schedule(authority)
    async def cancel():
        response=await mutate(client,headers,method='DELETE');assert response.status_code==200,response.text
    transport.hook=cancel;task=await claim(app.state.db,uuid4())
    assert await execute(authority,task,transport)=='cancelled'
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM market_facts')).fetchone())['n']==0
    transport.hook=None
    assert (await mutate(client,headers)).status_code==200
    assert await schedule(authority)==1
    task=await claim(app.state.db,uuid4());assert await execute(authority,task,transport)=='observed'
    assert transport.calls==2


async def test_same_UUID_concurrency_and_limit_are_atomic_across_devices(market):
    client,app,_authority,transport,_revision=market;a,_=await native(app);uid=uuid4()
    both=await asyncio.gather(mutate(client,a,uid=uid),mutate(client,a,uid=uid))
    assert all(row.status_code==200 for row in both) and {row.headers['x-alcor-operation-replay'] for row in both}=={'true','false'}
    for start in (0,100,200):
        values=items(*[f'S{n}' for n in range(start,min(start+100,255))])
        response=await mutate(client,a,values);assert response.status_code==200,response.text
    b,_=await native(app)
    same=await mutate(client,b);assert same.status_code==200,same.text
    before=await domain_hashes(app)
    excess=await mutate(client,a,items('AAPL','OVERLIMIT'))
    assert excess.status_code==409 and await domain_hashes(app)==before
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM market_streams')).fetchone())['n']==256
    assert transport.calls==0


async def test_current_scope_body_revalidation_other_owner_and_strict_fields(market):
    client,app,_authority,transport,_revision=market
    read_only,_=await native(app,'portfolio.read')
    assert (await mutate(client,read_only)).status_code==403
    headers,grant=await native(app)
    async def chunks():
        async with app.state.db.connection() as conn:await conn.execute("UPDATE identity_app_grants SET scope='portfolio.read' WHERE id=%s",(grant['grant_id'],))
        yield json.dumps(items()).encode()
    denied=await client.post(PATH,content=chunks(),headers={**headers,'content-type':'application/json'})
    assert denied.status_code==403 and denied.headers['x-alcor-retire-context']=='true'
    headers,_=await native(app)
    for value in [{'all':1},{'all':False},{'items':[]},{'items':[{'market':'US','code':'AAPL','extra':True}]},{'items':[{'market':'US','code':'bad code'}]},{'items':[{'market':'US','code':'AAPL'}],'extra':True}]:
        assert (await mutate(client,headers,value,method='DELETE')).status_code==400
    assert (await mutate(client,headers,path=PATH+'?market=US')).status_code==400
    assert (await mutate(client,headers,uid='not-uuid')).status_code==400
    assert (await mutate(client,headers,path='/api/market/subscriptions')).status_code==400
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as other:
        created=await other.post('/api/session/register',json={'username':'OtherSubscriptions','password':'Synthetic9Pass'})
        different,_=await native(app,owner=created.json()['user']['id'])
        assert (await mutate(client,headers)).status_code==200
        removed=await mutate(other,different,{'all':True},method='DELETE');assert removed.status_code==200
        assert len((await client.get(PATH,headers=headers)).json()['data']['subscriptions'])==1
    assert transport.calls==0


async def test_missing_or_changed_license_does_not_register_but_owner_can_cancel(market):
    client,app,authority,transport,_revision=market;headers,_=await native(app)
    original=authority.policies;authority.policies=()
    assert (await mutate(client,headers)).status_code==503
    async with app.state.db.connection() as conn:assert (await (await conn.execute('SELECT count(*) AS n FROM market_demands')).fetchone())['n']==0
    authority.policies=original;assert (await mutate(client,headers)).status_code==200
    assert await schedule(authority)==1
    authority.policies=(replace(original[0],license_revision='revoked-synthetic-license'),)
    removed=await mutate(client,headers,{'all':True},method='DELETE')
    assert removed.status_code==200 and removed.json()['data']['subscriptions']==[]
    assert await claim(app.state.db,uuid4()) is None and transport.calls==0


async def test_old_registration_is_used_by_real_independent_worker_and_shared_F19_reader(market):
    _client,app,_authority,_transport,_revision=market;headers,_=await native(app)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as submitting:
        response=await mutate(submitting,headers);assert response.status_code==200,response.text
    await worker_process_oracle(market)


async def second_source(client,authority):
    authority.policies+=(replace(authority.policies[0],id='other-approved-source',license_revision='other-license'),)
    response=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'other-approved-source'})
    assert response.status_code==200,response.text
    return response.json()['revision']


async def test_ambiguous_sources_require_selection_and_selected_cancel_keeps_other_lease(market):
    client,app,authority,transport,first=market;headers,_=await native(app)
    second=await second_source(client,authority)
    denied=await mutate(client,headers);assert denied.status_code==409
    a={**headers,'x-alcor-market-source':first};b={**headers,'x-alcor-market-source':second}
    assert (await mutate(client,a)).status_code==200
    assert (await mutate(client,b)).status_code==200
    removed=await mutate(client,a,{'all':True},method='DELETE')
    assert removed.status_code==200 and len(removed.json()['data']['subscriptions'])==1
    async with app.state.db.connection() as conn:
        active=await (await conn.execute('SELECT s.source_revision FROM market_demands d JOIN market_streams s ON s.id=d.stream_id AND s.owner_id=d.owner_id WHERE d.revoked_at IS NULL')).fetchall()
    assert [str(row['source_revision']) for row in active]==[second]
    removed=await mutate(client,headers,{'all':True},method='DELETE');assert removed.json()['data']['subscriptions']==[]
    assert transport.calls==0


async def test_cancel_receipt_survives_unavailable_other_subscription_projection_without_fake_empty(market):
    client,app,authority,transport,first=market;headers,_=await native(app)
    second=await second_source(client,authority)
    a={**headers,'x-alcor-market-source':first};b={**headers,'x-alcor-market-source':second}
    assert (await mutate(client,a)).status_code==200
    assert (await mutate(client,b,items('MSFT'))).status_code==200
    authority.policies=(authority.policies[0],replace(authority.policies[1],license_revision='changed'))
    uid=uuid4();response=await mutate(client,a,method='DELETE',uid=uid)
    assert response.status_code==503,response.text
    accepted=response.json()['data'];assert accepted['revoked'] and accepted['status']=='accepted' and accepted['subscriptions'] is None
    assert accepted['projectionError']['status']==503
    receipt=await client.get('/api/market/operations/'+str(uid),headers=headers)
    assert receipt.status_code==200 and receipt.json()==accepted
    replay=await mutate(client,a,method='DELETE',uid=uid)
    assert replay.json()==response.json() and replay.headers['x-alcor-operation-replay']=='true'
    async with app.state.db.connection() as conn:
        rows=await (await conn.execute("SELECT s.query->>'code' AS code,d.revoked_at FROM market_demands d JOIN market_streams s ON s.id=d.stream_id AND s.owner_id=d.owner_id ORDER BY code")).fetchall()
    assert rows[0]['code']=='AAPL' and rows[0]['revoked_at'] is not None
    assert rows[1]['code']=='MSFT' and rows[1]['revoked_at'] is None
    assert transport.calls==0


async def test_mid_batch_ambiguous_second_security_rolls_back_first_demand_and_child_receipt(market):
    client,app,_authority,transport,revision=market;headers,_=await native(app)
    from alcor_api.market_contract import Query
    from market_latest_candidate.test_market_authority import demand
    await demand(client,revision,Query('latest','US','MSFT'))
    await demand(client,revision,Query('latest','US','MSFT',session='PRE'))
    before=await domain_hashes(app)
    failed=await mutate(client,headers,items('AAPL','MSFT'),uid=uuid4())
    assert failed.status_code==409 and '多个采集口径' in failed.json()['message']
    assert await domain_hashes(app)==before and transport.calls==0
