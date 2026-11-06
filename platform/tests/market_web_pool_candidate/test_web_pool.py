"""Legacy Web session intent and source-aware reads without invented old writes."""

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
from request_telemetry_tables import REQUEST_TELEMETRY_TABLES
from alcor_api.backups import tables_and_hashes
from alcor_api.legacy_identity import WEB_COOKIE
from alcor_api.market_alert_reader import project_alert_demands
from market_latest_candidate.test_market_alerts import attach
from market_subscription_candidate.test_subscriptions import items, native
from price_alerts_candidate.test_price_alerts import upsert

HERE=Path(__file__).parent


async def old_web(client):
    response=await client.post('/api/auth/login',json={'username':'MarketReader','password':'Synthetic9Pass'})
    assert response.status_code==200,response.text
    return client.cookies.get(WEB_COOKIE)


def legacy(app,token):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',cookies={WEB_COOKIE:token},headers={'origin':'http://testserver'})


async def write(client,*,body=None,method='POST',uid=None,headers=None):
    uid=uid or str(uuid4())
    return await client.request(method,'/api/market/subscriptions',json=body or items(),headers={'x-alcor-request-id':uid,**(headers or {})})


async def hashes(app):
    async with app.state.db.connection() as conn,conn.transaction():
        observed = await tables_and_hashes(conn)
    # Request quotas and the independent recorder are not collection, renewal or business writes.
    telemetry = REQUEST_TELEMETRY_TABLES | {"auth_rate_limits"}
    return {name:value for name,value in observed.items() if name not in telemetry}


async def test_old_cookie_uses_same_UUID_subscriptions_and_receipts_all_GETs_are_pure(market):
    client,app,_authority,transport,_revision=market;token=await old_web(client)
    async with legacy(app,token) as old:
        uid=str(uuid4());accepted=await write(old,uid=uid)
        assert accepted.status_code==200,accepted.text
        assert accepted.json()['requestId']==uid and accepted.json()['subscriptions'][0]['code']=='AAPL'
        before=await hashes(app)
        for path in ['/api/market/operations/'+uid,'/api/market/pool','/api/market/pool?scope=shared','/api/market/subscriptions','/api/quote-pool']:
            response=await old.get(path);assert response.status_code==200,response.text
            assert response.headers['cache-control']=='no-store'
        assert await hashes(app)==before and transport.calls==0
        replay=await write(old,uid=uid)
        assert replay.json()==accepted.json() and replay.headers['x-alcor-operation-replay']=='true'
        removed=await write(old,method='DELETE',body={'all':True})
        assert removed.status_code==200 and removed.json()['subscriptions']==[]
        assert (await old.get('/api/market/operations/'+uid)).json()==accepted.json()


async def test_old_cookie_strict_origin_UUID_auth_precedence_and_expiry_withdraw_context(market):
    client,app,_authority,transport,_revision=market;token=await old_web(client)
    async with legacy(app,token) as old:
        for headers in [{'origin':'http://untrusted.invalid'},{'authorization':'Bearer invalid'}]:
            denied=await write(old,headers=headers)
            assert denied.status_code in (401,403) and denied.headers['x-alcor-retire-context']=='true'
        no_uuid=await old.post('/api/market/subscriptions',json=items())
        assert no_uuid.status_code==400
        old.headers.pop('origin')
        denied=await write(old);assert denied.status_code==403
        old.headers['origin']='http://testserver'
        uid=str(uuid4());assert (await write(old,uid=uid)).status_code==200
        async with app.state.db.connection() as conn:await conn.execute("UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE client_id='legacy-web'")
        for path in ['/api/market/pool','/api/market/operations/'+uid]:
            denied=await old.get(path)
            assert denied.status_code==401 and denied.headers['x-alcor-retire-context']=='true'
    assert transport.calls==0


async def test_background_only_demand_has_truthful_separate_projection_without_a_fake_client_lease(market):
    client,app,authority,transport,_revision=market;await attach(app,authority);await upsert(client)
    assert await project_alert_demands(authority)==1
    token=await old_web(client)
    async with legacy(app,token) as old:
        before=await hashes(app);result=await old.get('/api/market/pool')
        assert result.status_code==200,result.text
        value=result.json()['entries'][0]
        assert value['lastRequestedAt'] is None and value['expiresAt'] is None and value['cancellable'] is False
        assert value['lifetime']=='while_rule_enabled'
        source=value['sources'][0]
        assert source['kind']=='price.alert' and source['lifetime']=='while_rule_enabled' and source['cancellable'] is False
        assert isinstance(source['registeredAt'],int) and source['lastRequestedAt'] is None
        old_shared=await old.get('/api/quote-pool?scope=shared')
        assert old_shared.status_code==200,old_shared.text
        projected=old_shared.json()['data']
        assert projected['entryScope']=='finite_client_leases' and projected['entries']==[]
        background=projected['ongoingEntries'][0]
        assert background['expiresAt'] is None and background['lastRequestedAt'] is None
        assert background['lifetime']=='while_rule_enabled' and background['cancellable'] is False
        assert background['sources']==[{'kind':'price.alert','ownership':'mine','permission':'current','cancellable':False}]
        assert isinstance(background['registeredAt'],int)
        mine=(await old.get('/api/quote-pool')).json()['data']
        assert mine['entries']==[] and mine['ongoingEntries']==projected['ongoingEntries']
        assert await hashes(app)==before
        removed=await write(old,method='DELETE',body={'all':True})
        assert removed.status_code==200 and removed.json()['affectedStreams']==0
        again=await old.get('/api/market/pool')
        assert again.json()['entries'][0]['sources'][0]['kind']=='price.alert'
    assert transport.calls==0


async def test_mixed_shared_origins_never_expose_other_owners_or_delete_their_demands(market):
    client,app,authority,transport,_revision=market;await attach(app,authority);await upsert(client);await project_alert_demands(authority)
    token=await old_web(client)
    async with legacy(app,token) as old,httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as other:
        assert (await write(old)).status_code==200
        created=await other.post('/api/session/register',json={'username':'PoolOtherOwner','password':'Synthetic9Pass'})
        assert created.status_code==201;owner=created.json()['user']['id'];other.headers['x-csrf-token']=created.json()['csrf']
        authority.policies+=(replace(authority.policies[0],id='other-owner-policy',owner_id=owner),)
        configured=await other.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'other-owner-policy'})
        assert configured.status_code==200,configured.text
        foreign_source=configured.json()['revision']
        foreign=await write(other,body=items('AAPL','MSFT'));assert foreign.status_code==200,foreign.text
        snapshot=await old.get('/api/market/pool?scope=shared');assert snapshot.status_code==200,snapshot.text
        aapl=next(row for row in snapshot.json()['entries'] if row['code']=='AAPL');msft=next(row for row in snapshot.json()['entries'] if row['code']=='MSFT')
        assert aapl['lifetime']=='mixed' and aapl['expiresAt'] is None and aapl['cancellable'] is True
        assert {(s['kind'],s['ownership'],s['cancellable']) for s in aapl['sources']}=={('client','mine',True),('client','shared',False),('price.alert','mine',False)}
        assert msft['cancellable'] is False and msft['sources'][0]['sourceRevision'] is None
        assert owner not in snapshot.text and foreign_source not in snapshot.text
        for field in ['principal','native_grant_id','token_hash','ruleId','owner_id']:assert field not in snapshot.text
        assert (await write(old,body=items('MSFT'),method='DELETE')).json()['affectedStreams']==0
        assert (await write(old,method='DELETE')).status_code==200
        current=(await old.get('/api/market/pool?scope=shared')).json()['entries']
        assert next(row for row in current if row['code']=='AAPL')['cancellable'] is False
        assert len((await other.get('/api/market/subscriptions')).json()['subscriptions'])==2
        assert (await old.get('/api/market/operations/'+foreign.json()['requestId'])).status_code==404
    assert transport.calls==0


async def test_source_permission_unknown_is_explicit_and_does_not_remove_cancellation(market):
    client,app,authority,transport,_revision=market;token=await old_web(client)
    async with legacy(app,token) as old:
        assert (await write(old)).status_code==200
        authority.policies=(replace(authority.policies[0],license_revision='changed'),)
        before=await hashes(app);snapshot=await old.get('/api/market/pool')
        assert snapshot.status_code==200 and len(snapshot.json()['entries'])==1
        source=snapshot.json()['entries'][0]['sources'][0]
        assert source['permission']=='unavailable' and source['source'] is None and source['cancellable'] is True
        assert source['collectionStates']==['source_unavailable']
        assert 'price' not in snapshot.text and 'volume' not in snapshot.text
        assert await hashes(app)==before
        assert (await write(old,method='DELETE',body={'all':True})).status_code==200
        assert (await old.get('/api/market/pool')).json()['entries']==[]
    assert transport.calls==0


async def test_native_cannot_get_admin_shared_view_and_role_changes_block_late_old_cookie_writes(market):
    client,app,_authority,transport,_revision=market
    headers,_=await native(app,'portfolio.read')
    denied=await client.get('/api/market/pool?scope=shared',headers=headers)
    assert denied.status_code==403 and denied.headers['x-alcor-retire-context']=='true'
    token=await old_web(client)
    async with legacy(app,token) as old:
        async def chunks():
            async with app.state.db.connection() as conn:await conn.execute("UPDATE users SET role='user' WHERE username='MarketReader'")
            yield json.dumps(items()).encode()
        denied=await old.post('/api/market/subscriptions',content=chunks(),headers={'x-alcor-request-id':str(uuid4()),'content-type':'application/json'})
        assert denied.status_code==403 and denied.headers['x-alcor-retire-context']=='true'
        denied=await old.get('/api/market/pool?scope=shared');assert denied.status_code==403
        async with app.state.db.connection() as conn:assert (await (await conn.execute('SELECT count(*) AS n FROM market_demands')).fetchone())['n']==0
    assert transport.calls==0


async def test_actual_old_hook_accepts_client_DTO_but_requires_adaptation_for_nullable_business_source(market):
    root=os.environ.get('ALCOR_MARKET_LEGACY_ROOT')
    if not root:pytest.skip('Explicit read-only source required')
    proof=json.loads((HERE/'source-evidence.json').read_text())
    for name,wanted in proof['source_sha256'].items():assert hashlib.sha256((Path(root)/name).read_bytes()).hexdigest()==wanted
    client,app,authority,_transport,_revision=market;token=await old_web(client)
    async with legacy(app,token) as old:
        assert (await write(old)).status_code==200
        original=(await old.get('/api/quote-pool')).json()
        accepted=json.loads(await asyncio.to_thread(subprocess.check_output,['node',str(HERE/'run_old_pool_hook.cjs'),root],input=json.dumps({'scope':'mine','body':original}),text=True))
        assert accepted['accepted'] is True and accepted['failure'] is None
        await attach(app,authority);await upsert(client);await project_alert_demands(authority)
        compatible=(await old.get('/api/quote-pool')).json()
        assert compatible['data']['entries'] and compatible['data']['ongoingEntries']
        assert compatible['data']['ongoingEntries'][0]['expiresAt'] is None
        accepted=json.loads(await asyncio.to_thread(subprocess.check_output,['node',str(HERE/'run_old_pool_hook.cjs'),root],input=json.dumps({'scope':'mine','body':compatible}),text=True))
        assert accepted['accepted'] is True and accepted['failure'] is None
        detail=(await old.get('/api/market/pool')).json()
        rejected=json.loads(await asyncio.to_thread(subprocess.check_output,['node',str(HERE/'run_old_pool_hook.cjs'),root],input=json.dumps({'scope':'mine','body':{'data':detail}}),text=True))
        assert rejected['accepted'] is False and rejected['failure']['message']=='股票池暂时无法读取'
        denied=json.loads(await asyncio.to_thread(subprocess.check_output,['node',str(HERE/'run_old_pool_hook.cjs'),root],input=json.dumps({'scope':'mine','body':{'message':'connection expired'},'status':401,'initial':{'mine':original['data']}}),text=True))
        assert denied['retainedInitial'] is True  # Real old-client cleanup remains pending.
