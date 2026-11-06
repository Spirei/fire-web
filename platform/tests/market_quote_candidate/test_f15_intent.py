"""Old quote POST intent may renew only an already licensed owner write scope."""
from dataclasses import replace
from uuid import uuid4

from alcor_api.market_subscription_writes import Subscriptions
from alcor_api.native_app_auth import issue_grant
from test_quote_reads import body, hashes


async def token(app,scope):
    async with app.state.db.connection() as conn:
        user=await(await conn.execute("SELECT * FROM users WHERE username='MarketReader'")).fetchone()
        pair=await issue_grant(conn,user,scope,'Synthetic explicit quote intent')
    return {'authorization':'Bearer '+pair['access_token']}


async def test_old_unmodified_post_has_real_generated_receipt_but_canonical_never_renews(market):
    client,app,_authority,transport,_=market
    before=await hashes(app)
    pure=await client.post('/api/market/quotes/read',json=body())
    assert pure.status_code==200 and pure.json()['quotes']=={}
    assert await hashes(app)==before
    legacy=await client.post('/api/quotes',json=body())
    assert legacy.status_code==200 and legacy.json()=={'quotes':{}},legacy.text
    assert legacy.headers['x-alcor-quote-tracked']=='true'
    assert legacy.headers['x-alcor-legacy-client-idempotency']=='false'
    receipt=await client.get(legacy.headers['x-alcor-operation-receipt'])
    assert receipt.status_code==200 and receipt.json()['observation'] is True
    assert receipt.json()['legacyClientIdempotency'] is False
    assert receipt.json()['requestId']==legacy.headers['x-alcor-request-id']
    assert transport.calls==0


async def test_read_scope_is_pure_and_write_scope_original_uuid_replays_without_extra_leases(market):
    client,app,_authority,transport,_=market
    readonly=await token(app,'portfolio.read')
    before=await hashes(app)
    read=await client.post('/api/v2/quotes',json=body(),headers=readonly)
    assert read.status_code==200 and read.headers['x-alcor-quote-tracked']=='false'
    assert await hashes(app)==before
    writer=await token(app,'portfolio.read portfolio.write')
    rid=str(uuid4());headers={**writer,'x-alcor-request-id':rid}
    accepted=await client.post('/api/v2/quotes',json=body(),headers=headers)
    assert accepted.status_code==200 and accepted.headers['x-alcor-quote-tracked']=='true',accepted.text
    assert accepted.headers['x-alcor-legacy-client-idempotency']=='true'
    before=await hashes(app)
    replay=await client.post('/api/v2/quotes',json=body(),headers=headers)
    assert replay.json()==accepted.json() and await hashes(app)==before
    receipt=await client.get('/api/market/operations/'+rid,headers=writer)
    assert receipt.status_code==200 and receipt.json()['requestId']==rid
    assert transport.calls==0


async def test_old_post_never_installs_or_chooses_first_of_multiple_owner_sources(market):
    client,app,authority,transport,revision=market
    original=authority.policies[0]
    authority.policies+=(replace(original,id='second-licensed-source',license_revision='second-license'),)
    response=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'second-licensed-source'})
    assert response.status_code==200,response.text
    before=await hashes(app)
    ambiguous=await client.post('/api/quotes',json=body())
    assert ambiguous.status_code==200 and ambiguous.headers['x-alcor-quote-tracked']=='false'
    assert await hashes(app)==before
    chosen=await client.post('/api/quotes',json=body(),headers={'x-alcor-market-source':revision})
    assert chosen.status_code==200 and chosen.headers['x-alcor-quote-tracked']=='true'
    async with app.state.db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM market_source_configs')).fetchone())['n']==2
        rows=await(await conn.execute('SELECT source_revision FROM market_streams')).fetchall()
    assert len(rows)==1 and str(rows[0]['source_revision'])==revision and transport.calls==0


async def test_commit_then_response_loss_exposes_original_uuid_for_query_without_provider_io(market,monkeypatch):
    client,app,_authority,transport,_=market
    original=Subscriptions.mutate
    async def uncertain(self,*args,**kwargs):
        await original(self,*args,**kwargs)
        raise TimeoutError('synthetic response loss after durable receipt')
    monkeypatch.setattr(Subscriptions,'mutate',uncertain)
    response=await client.post('/api/quotes',json=body())
    assert response.status_code==200 and response.headers['x-alcor-quote-tracked']=='unknown'
    rid=response.headers['x-alcor-request-id']
    assert response.headers['x-alcor-operation-receipt']=='/api/market/operations/'+rid
    assert response.headers['x-alcor-legacy-client-idempotency']=='false'
    before=await hashes(app)
    for _ in range(2):
        receipt=await client.get('/api/market/operations/'+rid)
        assert receipt.status_code==200 and receipt.json()['requestId']==rid
    assert await hashes(app)==before and transport.calls==0


async def test_diagnostics_fixed_owner_target_exact_purpose_and_original_uuid_unknown_are_real(market,monkeypatch):
    from dataclasses import asdict

    from alcor_api.dividend_sources import Target
    from alcor_api.market_transport import Transport
    client,app,authority,_transport,_=market
    target=Target('controlled-opend','futu','opend.example.invalid',11111,('8.8.8.8',),approved_access=True,scheme='http',allow_plaintext=True)
    app.state.db.settings.dividend_source_targets=[asdict(target)]
    policy=replace(authority.policies[0],id='diagnostic-installed',source='futu',source_version='futu-sdk-records-v1',target_id=target.id,target_fingerprint=target.fingerprint,purposes=('latest','futu.test','futu.quota'))
    authority.policies=(policy,)
    selected=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':policy.id})
    assert selected.status_code==200,selected.text
    revision=selected.json()['revision'];calls=[]
    async def check(self,approved,action):
        calls.append(action)
        assert approved.owner_id==policy.owner_id and approved.target_fingerprint==target.fingerprint
        return {'responded':True,'qotLogined':True} if action=='futu.test' else {'subscription':{'total_used':0,'remain':2,'own_used':0,'private_security_list':['never publish']},'historyKl':{'used_quota':0,'remain_quota':3}}
    monkeypatch.setattr(Transport,'diagnostic',check)
    for action in ('test','quota'):
        rid=str(uuid4());raw={'requestId':rid,'sourceRevision':revision}
        first=await client.post('/api/futu/'+action,json=raw)
        assert first.status_code==200,first.text
        if action=='quota':
            result=first.json();assert result['quota']['subscription']['totalUsed']==0
            assert result['quota']['historyKl']['used']==0 and result['quota']['subscription']['totalQuota'] is None
            assert 'never publish' not in first.text
        else:assert first.json()['ok'] is True and first.json()['quotePermissionVerified'] is False
        replay=await client.post('/api/futu/'+action,json=raw)
        assert replay.json()==first.json()
        assert (await client.get('/api/market/operations/'+rid)).json()==first.json()
    assert calls==['futu.test','futu.quota']
    denied=await client.post('/api/futu/test',json={'requestId':str(uuid4()),'sourceRevision':revision,'host':'unapproved.example.invalid'})
    assert denied.status_code==403 and len(calls)==2
    invalid=await client.post('/api/futu/test',content=b'{invalid',headers={'content-type':'application/json'})
    assert invalid.status_code==400 and len(calls)==2
    async def uncertain(self,approved,action):
        calls.append(action)
        raise TimeoutError('controlled absent SDK response')
    monkeypatch.setattr(Transport,'diagnostic',uncertain)
    rid=str(uuid4());raw={'requestId':rid,'sourceRevision':revision}
    unknown=await client.post('/api/futu/test',json=raw)
    assert unknown.status_code==200 and unknown.json()['state']=='unknown'
    assert (await client.post('/api/futu/test',json=raw)).json()==unknown.json()
    assert len(calls)==3


async def test_diagnostics_admin_web_only_before_admission_or_provider_io(market, monkeypatch):
    from alcor_api.market_transport import Transport

    client, app, authority, _transport, revision = market
    calls = []

    async def forbidden(*args, **kwargs):
        calls.append(True)
        raise AssertionError('Unauthorized diagnostics must never contact a provider')

    monkeypatch.setattr(Transport, 'diagnostic', forbidden)
    native = await token(app, 'portfolio.read portfolio.write')
    paths = ('/api/futu/test', '/api/futu/quota')
    # Even a token issued to the administrator is not a Web management session.
    for path in paths:
        response = await client.post(path, json={'requestId': str(uuid4()), 'sourceRevision': revision}, headers=native)
        assert response.status_code == 401, response.text
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE users SET role='user' WHERE id=%s", (authority.policies[0].owner_id,))
    for path in paths:
        response = await client.post(path, json={'requestId': str(uuid4()), 'sourceRevision': revision})
        assert response.status_code == 403, response.text
    client.cookies.clear()
    for path in paths:
        response = await client.post(path, json={'requestId': str(uuid4()), 'sourceRevision': revision})
        assert response.status_code == 401, response.text
    async with app.state.db.connection() as conn:
        assert not await (await conn.execute('SELECT 1 FROM market_diagnostic_admissions')).fetchone()
    assert not calls
