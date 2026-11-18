"""Public discovery publication has no personal-owner authority or GET IO."""
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from uuid import uuid4

import pytest
from alcor_api.market_discovery_protocol import VERSION, Target
from alcor_api.public_discovery import PublicDiscovery, PublicDiscoveryPolicy
from fastapi import HTTPException
from public_market_candidate.test_authority import setup

RAW=b'v_hint="us~AAPL~Synthetic~unused~GP-A";'


class Transport:
    def __init__(self):self.calls=0;self.hook=None;self.raw=RAW
    async def read(self,target,value):
        self.calls+=1
        if self.hook:await self.hook()
        return self.raw,200,{'content-type':'text/plain'}


async def prepared(db,client,admin):
    who,_=await setup(db,client,admin);now=datetime.now(UTC)
    target=Target('public-search','tencent','smartbox.gtimg.cn',('8.8.8.8',),True)
    policy=PublicDiscoveryPolicy('public-discovery','market-discovery',VERSION,target.id,target.fingerprint,'public-discovery-license','b'*64,str(db.settings.instance_id),(now-timedelta(days=1)).isoformat(),(now+timedelta(days=1)).isoformat(),('US',),('collect','display','discovery.search'))
    transport=Transport();service=PublicDiscovery(db,(policy,),(target,),transport=transport)
    return who,policy,target,transport,service


async def test_public_default_closed_explicit_collect_original_uuid_and_pure_read(db,client,admin):
    who,p,_target,transport,service=await prepared(db,client,admin)
    with pytest.raises(HTTPException) as absent:await service.read({'kind':'search','q':'AAPL'})
    assert absent.value.status_code==503 and transport.calls==0
    saved=await service.install(who,str(uuid4()),p.id,'Synthetic9Pass')
    rid=str(uuid4());result=await service.collect(who,rid,saved['licenseId'],{'kind':'search','q':'AAPL'},'Synthetic9Pass')
    assert result['state']=='observed' and transport.calls==1
    assert await service.collect(who,rid,saved['licenseId'],{'kind':'search','q':'AAPL'},'')==result
    assert transport.calls==1
    observed=await service.read({'kind':'search','q':'AAPL'})
    assert observed['items'][0]['code']=='AAPL' and observed['items'][0]['price'] is None
    assert observed['originals']==[] and observed['collectionOnRead'] is False
    raw,sha=await service.original(who,result['pageId'],'Synthetic9Pass')
    assert raw==RAW and sha==sha256(RAW).hexdigest()
    with pytest.raises(HTTPException):await service.collect(who,rid,saved['licenseId'],{'kind':'search','q':'MSFT'},'Synthetic9Pass')
    await service.revoke(who,str(uuid4()),saved['licenseId'],'Synthetic9Pass')
    with pytest.raises(HTTPException):await service.read({'kind':'search','q':'AAPL'})
    assert (await service.original(who,result['pageId'],'Synthetic9Pass'))[0]==RAW
    assert transport.calls==1


@pytest.mark.parametrize('failure',['revoke','parse','timeout'])
async def test_received_response_or_unknown_never_reissues_and_never_borrows_private(db,client,admin,failure):
    who,p,_target,transport,service=await prepared(db,client,admin)
    saved=await service.install(who,str(uuid4()),p.id,'Synthetic9Pass');rid=str(uuid4())
    if failure=='revoke':
        async def late():await service.revoke(who,str(uuid4()),saved['licenseId'],'Synthetic9Pass')
        transport.hook=late
    elif failure=='parse':transport.raw=b'invalid response with token=private'
    else:
        async def timeout():raise TimeoutError()
        transport.hook=timeout
    result=await service.collect(who,rid,saved['licenseId'],{'kind':'search','q':'AAPL'},'Synthetic9Pass')
    assert result['state'] in ('retained_unavailable','unavailable')
    with pytest.raises(HTTPException):await service.read({'kind':'search','q':'AAPL'})
    await service.collect(who,rid,saved['licenseId'],{'kind':'search','q':'AAPL'},'')
    assert transport.calls==1
    receipt=await service.receipt(who,rid)
    if failure!='timeout':assert (await service.original(who,receipt['pageId'],'Synthetic9Pass'))[0]==transport.raw
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM market_source_configs')).fetchone()


async def test_http_admin_controls_and_plain_credentials_never_public(app,db,client,admin,settings):
    _who,p,target,transport,_service=await prepared(db,client,admin)
    settings.public_discovery_policies=[asdict(p)];settings.public_discovery_targets=[asdict(target)]
    service=app.state.public_discovery
    service.transport=transport
    saved=await client.post('/api/system/public-discovery/install',json={'requestId':str(uuid4()),'policyId':p.id,'password':'Synthetic9Pass'})
    assert saved.status_code==200,saved.text
    captured=await client.post('/api/system/public-discovery/collect',json={'requestId':str(uuid4()),'licenseId':saved.json()['licenseId'],'query':{'kind':'search','q':'AAPL'},'password':'Synthetic9Pass'})
    assert captured.status_code==200,captured.text
    original_path='/api/system/public-discovery/originals/'+captured.json()['pageId']
    path=original_path
    assert (await client.post(path,json={'password':'wrong'})).status_code==403
    response=await client.post(path,json={'password':'Synthetic9Pass'})
    assert response.content==RAW
    client.cookies.clear()
    client.headers.pop('x-csrf-token',None)
    for path in ('/api/search?q=AAPL','/api/v1/search?q=AAPL','/api/v2/search?q=AAPL'):
        public=await client.get(path)
        assert public.status_code==200,public.text
        data=public.json().get('data',public.json())
        assert data['results'][0]['code']=='AAPL'
        assert 'pageId' not in public.text and 'public-search' not in public.text
        denied=await client.get(path,headers={'Authorization':'Bearer invalid'})
        assert denied.status_code==401,denied.text
        denied=await client.get(path,headers={'Cookie':'alcor_session=expired'})
        assert denied.status_code==401,denied.text
    assert transport.calls==1
    assert (await client.get('/api/system/public-discovery/licenses')).status_code==401
    assert (await client.post(original_path,json={'password':'Synthetic9Pass'})).status_code==401


@pytest.mark.parametrize('kind',['indices','top','ranking'])
async def test_public_each_discovery_purpose_has_real_fixed_protocol_projection(db,client,admin,kind):
    import json
    from dataclasses import replace

    who,p,_target,transport,service=await prepared(db,client,admin)
    if kind=='indices':
        target=Target('public-index','cnn','production.dataviz.cnn.io',('8.8.8.8',),True)
        value={'kind':'indices'}
        transport.raw=json.dumps({'fear_and_greed':{'score':40,'previous_close':39,'timestamp':'2026-11-03T10:00:00Z','rating':'fear'}}).encode()
        scope='discovery.indices'
    else:
        target=Target('public-list','eastmoney','push2.eastmoney.com',('8.8.8.8',),True)
        value={'kind':kind,'market':'US',**({'metric':'volume'} if kind=='ranking' else {})}
        count=10 if kind=='ranking' else 1
        transport.raw=json.dumps({'data':{'total':count,'diff':[{'f12':f'SYN{i}','f14':f'Synthetic {i}','f20':100-i,'f5':100-i,'f2':10,'f3':1,'f124':int(datetime.now(UTC).timestamp())} for i in range(count)]}}).encode()
        scope='discovery.ranking.volume' if kind=='ranking' else 'discovery.top'
    policy=replace(p,target_id=target.id,target_fingerprint=target.fingerprint,purposes=('collect','display',scope))
    service.policies=(policy,);service.targets=(target,)
    license=await service.install(who,str(uuid4()),policy.id,'Synthetic9Pass')
    outcome=await service.collect(who,str(uuid4()),license['licenseId'],value,'Synthetic9Pass')
    assert outcome['state']=='observed',outcome
    observed=await service.read(value)
    if kind=='indices':assert observed['groups'][0]['indices'][0]['latest']==40
    else:assert len(observed['items'])==(10 if kind=='ranking' else 1)
    assert transport.calls==1 and observed['collectionOnRead'] is False


async def test_public_original_immutable_and_policy_change_restore_fail_closed(db,client,admin):
    from dataclasses import replace

    from psycopg import errors

    who,p,_target,transport,service=await prepared(db,client,admin)
    license=await service.install(who,str(uuid4()),p.id,'Synthetic9Pass')
    result=await service.collect(who,str(uuid4()),license['licenseId'],{'kind':'search','q':'AAPL'},'Synthetic9Pass')
    async with db.connection() as conn:
        with pytest.raises(errors.CheckViolation):
            async with conn.transaction():
                await conn.execute("UPDATE public_discovery_pages SET raw_bytes=%s WHERE id=%s",(b'changed',result['pageId']))
        await conn.execute("INSERT INTO restore_quarantine(category,payload) VALUES('external_delivery_disabled','{\"disabled\":true}')")
    with pytest.raises(HTTPException):await service.collect(who,str(uuid4()),license['licenseId'],{'kind':'search','q':'AAPL'},'Synthetic9Pass')
    assert (await service.read({'kind':'search','q':'AAPL'}))['state']=='observed'
    service.policies=(replace(p,license_revision='changed-public-license'),)
    with pytest.raises(HTTPException):await service.read({'kind':'search','q':'AAPL'})
    assert (await service.original(who,result['pageId'],'Synthetic9Pass'))[0]==RAW
    assert transport.calls==1


async def test_public_quote_snapshot_rechecks_original_fact_not_newer_price_or_new_license(db,client,admin):
    import json

    from alcor_api.market_contract import Query
    from alcor_api.market_worker import decode
    from alcor_api.public_market_quotes import PublicQuotes
    from psycopg.types.json import Jsonb
    from public_market_candidate.test_public_quotes import prepared as quotes_prepared
    from public_market_candidate.test_public_quotes import publish

    who,p,_installed,authority=await quotes_prepared(db,client,admin)
    license=await publish(db,authority,who,p)
    reader=PublicQuotes(authority);items=[{'id':'a','market':'US','code':'AAPL'}]
    captured=await reader.read(items,retain_evidence=True)
    snapshot=captured.pop('_publicEvidence');clock=datetime.now(UTC)
    q=Query('latest','US','AAPL');queued=await authority.enqueue(who,uuid4(),license['licenseId'],q,'Synthetic9Pass')
    stamp=datetime.now(UTC)
    raw=json.dumps({'query':asdict(q),'licenseRevision':p.license_revision,'facts':[{'at':stamp.isoformat(),'currency':'USD','price':'999.0000','session':'REGULAR','cached':False}]}).encode()
    facts,_,_=decode(p,q,raw);page_id=uuid4()
    async with db.connection() as conn,conn.transaction():
        await conn.execute("UPDATE public_market_tasks SET status='running' WHERE id=%s",(queued['taskId'],))
        await conn.execute("INSERT INTO public_market_pages(id,task_id,raw_bytes,raw_sha256,representation,http_status,complete) VALUES(%s,%s,%s,%s,'raw',200,true)",(page_id,queued['taskId'],raw,sha256(raw).hexdigest()))
        await conn.execute('INSERT INTO public_market_facts(id,task_id,page_id,license_id,query,source_time,contents) VALUES(%s,%s,%s,%s,%s,%s,%s)',(uuid4(),queued['taskId'],page_id,license['licenseId'],Jsonb(asdict(q)),stamp,Jsonb(facts[0])))
        await conn.execute("UPDATE public_market_tasks SET status='completed' WHERE id=%s",(queued['taskId'],))
    assert (await reader.read(items))['quotes']['a']['price']==999
    assert await reader.read(items,snapshot=snapshot,observed_at=clock)==captured
    await authority.revoke(who,uuid4(),license['licenseId'],'Synthetic9Pass')
    with pytest.raises(HTTPException):await reader.read(items,snapshot=snapshot,observed_at=clock)


@pytest.mark.parametrize(('market','currency','exchange','code_prefix','zone'),[
    ('US','USD','NASDAQ','ZZZ','America/New_York'),
    ('HK','HKD','HKEX','0060','Asia/Hong_Kong'),
    ('CN','CNY','SSE','60000','Asia/Shanghai'),
])
async def test_public_amount_ranking_retains_ten_original_quote_facts_and_rechecks_license(app,db,client,admin,market,currency,exchange,code_prefix,zone):
    import asyncio
    import json
    from dataclasses import replace
    from unittest.mock import patch
    from zoneinfo import ZoneInfo

    from alcor_api.db import Database
    from alcor_api.dividend_sources import security
    from alcor_api.market_contract import Query, canonical
    from alcor_api.market_worker import decode
    from alcor_api.public_market_authority import PublicAuthority, PublicPolicy
    from alcor_api.public_market_quotes import PublicQuotes
    from psycopg.types.json import Jsonb

    who,p,_target,scanner,service=await prepared(db,client,admin)
    app.state.public_discovery=service
    client.cookies.clear()
    client.headers.pop('x-csrf-token',None)
    for version in (1,2):
        path=f'/api/v{version}/market-ranking'
        config=await client.get(f'/api/v{version}/auth/config')
        assert config.status_code==200,config.text
        assert config.json()['data']['market_amount_ranking']=={
            'version':1,'path':path,'markets':['US','HK','CN'],'metric':'amount',
        }
        unavailable=await client.get(path,params={'market':market,'metric':'amount'})
        assert unavailable.status_code==503,unavailable.text
    assert scanner.calls==0
    now=datetime.now(UTC).replace(microsecond=0)
    timezone=ZoneInfo(zone)
    newer_date=min(now.date(),now.astimezone(timezone).date())
    trade_date=newer_date-timedelta(days=1)
    observed_at=datetime.combine(trade_date,datetime.min.time(),timezone).replace(hour=12)
    codes=[f'{code_prefix}{index}' for index in range(10)]
    quote_policy=PublicPolicy('public-amount-quotes','futu','futu-sdk-records-v1','synthetic-public-sdk','a'*64,
        'public-amount-license','c'*64,str(db.settings.instance_id),(now-timedelta(days=1)).isoformat(),
        (now+timedelta(days=1)).isoformat(),tuple((market,code,'equity','REGULAR') for code in codes),('collect','display'),True)
    authority=PublicAuthority(db,(quote_policy,));service.quote_authority=authority
    quote_license=await authority.install(who,uuid4(),quote_policy.id,'Synthetic9Pass')

    async def publish(code,index,updated=False):
        q=Query('latest',market,code)
        task=await authority.enqueue(who,uuid4(),quote_license['licenseId'],q,'Synthetic9Pass')
        stamp=observed_at+timedelta(seconds=int(updated))
        local=stamp.astimezone(timezone)
        amount=10000-index*100 if not updated else 100+index*100
        raw=canonical({'records':[{'code':security('futu',market,code),'name':'Synthetic '+code,
            'update_time':local.strftime('%Y-%m-%d %H:%M:%S'),'last_price':'99' if updated else '10',
            'prev_close_price':'9','volume':'100','turnover':str(amount)}]}).encode()
        facts,issues,cursor=decode(quote_policy,q,raw)
        assert not issues and cursor is None and len(facts)==1
        page=uuid4()
        async with db.connection() as conn,conn.transaction():
            await conn.execute("UPDATE public_market_tasks SET status='running' WHERE id=%s",(task['taskId'],))
            await conn.execute("INSERT INTO public_market_pages(id,task_id,raw_bytes,raw_sha256,representation,http_status,complete) VALUES(%s,%s,%s,%s,'sdk_json_representation_not_wire_bytes',200,true)",(page,task['taskId'],raw,sha256(raw).hexdigest()))
            await conn.execute('INSERT INTO public_market_facts(id,task_id,page_id,license_id,query,source_time,contents) VALUES(%s,%s,%s,%s,%s,%s,%s)',(uuid4(),task['taskId'],page,quote_license['licenseId'],Jsonb(asdict(q)),datetime.fromisoformat(facts[0]['at']),Jsonb(facts[0])))
            await conn.execute("UPDATE public_market_tasks SET status='completed' WHERE id=%s",(task['taskId'],))
    for index,code in enumerate(codes):await publish(code,index)
    target=Target('public-amount-scanner','tradingview','scanner.tradingview.com',('8.8.8.8',),True)
    policy=replace(p,target_id=target.id,target_fingerprint=target.fingerprint,markets=(market,),purposes=('collect','display','discovery.ranking.amount'))
    service.policies=(policy,);service.targets=(target,)
    day=int(datetime.combine(trade_date,datetime.min.time(),UTC).timestamp())
    rows=[{'s':exchange+':'+code,'d':[code,'Synthetic '+code,100,100,day,'stock',exchange,currency]} for code in codes]
    if market=='US':
        for index in range(5990):
            code=f'ZZSMALL{index}'
            rows.append({'s':exchange+':'+code,'d':[code,'Synthetic '+code,1,1,day,'stock',exchange,currency]})
    original=json.dumps({'totalCount':len(rows),'data':rows}).encode()
    scanner.raw=original
    license=await service.install(who,uuid4(),policy.id,'Synthetic9Pass');rid=uuid4()
    value={'kind':'ranking','market':market,'metric':'amount'}
    _,_,scanner_body,_=target.request(value)
    assert {'left':'currency','operation':'equal','right':currency} in json.loads(scanner_body)['filter']
    captured=await service.collect(who,rid,license['licenseId'],value,'Synthetic9Pass')
    assert captured['state']=='observed' and captured['projection']['rankingVerified'],captured
    refs=captured['projection']['publicQuoteFacts']
    assert len(refs)==10 and all(ref['licenseId']==quote_license['licenseId'] for ref in refs.values())
    first=await service.read(value)
    assert first['coverage']['complete'] and [item['code'] for item in first['items']]==codes
    assert [item['amount'] for item in first['items']]==[10000-index*100 for index in range(10)]
    assert all(item['price']==10 and datetime.fromisoformat(item['time'])==observed_at for item in first['items'])
    assert all(item['quoteState']=='stale' and item['displayStale'] is True and item['cached'] is None for item in first['items'])
    assert all(item['sourceTime']==item['time'] for item in first['items'])
    assert first['coverage']['realTimePricesAssumed'] is False
    assert first['coverage']['rankingBasis']=='retained_provider_observations_on_trade_date_not_live'
    assert 'publicQuoteFacts' not in first and 'publicQuoteEvidence' not in first

    # The replay must work at Fire's smallest supported PostgreSQL pool size.
    one_connection=Database(db.settings.model_copy(update={'pool_size':1,'pool_min_size':1}))
    await one_connection.open()
    try:
        single_reader=PublicDiscovery(one_connection,(policy,),(target,),quote_authority=PublicAuthority(one_connection,(quote_policy,)))
        assert await single_reader.read(value)==first
    finally:
        await one_connection.close()

    # Concurrent public reads must share the locks held by an existing reader.
    async with db.connection() as conn,conn.transaction():
        await service.lock(conn,license['licenseId'],shared=True)
        await authority.lock(conn,quote_license['licenseId'],shared=True)
        responses=await asyncio.gather(*(client.get(f'/api/v{version}/market-ranking',params={'market':market,'metric':'amount'}) for version in (1,2)))
    for response in responses:
        assert response.status_code==200,response.text
        ranking=response.json()['data']
        assert (ranking['market'],ranking['currency'],ranking['metric'])==(market,currency,'amount')
        assert ranking['tradeDate']==first['tradeDate']==trade_date.isoformat()
        assert ranking['updatedAt']==first['updatedAt']
        assert ranking['items']==first['items'] and ranking['coverage']['complete']
    assert (await service.original(who,captured['pageId'],'Synthetic9Pass'))[0]==original
    unknown_code=code_prefix[:-1]+'19'
    rows.append({'s':exchange+':'+unknown_code,'d':[unknown_code,'Synthetic unresolved candidate',200,100,day,'stock',exchange,currency]})
    scanner.raw=json.dumps({'totalCount':len(rows),'data':rows}).encode()
    partial=await service.collect(who,uuid4(),license['licenseId'],value,'Synthetic9Pass')
    assert partial['state']=='observed' and not partial['projection']['rankingVerified']
    assert await service.read(value)==first

    newer=await service.install(who,uuid4(),policy.id,'Synthetic9Pass')
    for row in rows:
        row['d'][4]=int(datetime.combine(newer_date,datetime.min.time(),UTC).timestamp())
    scanner.raw=json.dumps({'totalCount':len(rows),'data':rows}).encode()
    partial=await service.collect(who,uuid4(),newer['licenseId'],value,'Synthetic9Pass')
    assert partial['projection']['tradeDate']==newer_date.isoformat() and not partial['projection']['rankingVerified']
    unavailable=await client.get('/api/v2/market-ranking',params={'market':market,'metric':'amount'})
    assert unavailable.status_code==503,unavailable.text
    await service.revoke(who,uuid4(),newer['licenseId'],'Synthetic9Pass')

    for index,code in enumerate(codes):await publish(code,index,updated=True)
    latest=await PublicQuotes(authority).read([{'id':code,'market':market,'code':code} for code in codes])
    assert latest['quotes'][codes[0]]['price']==99
    assert await service.read(value)==first
    with patch('alcor_api.public_discovery.datetime',wraps=datetime) as clock:
        clock.now.return_value=now+timedelta(days=11)
        with pytest.raises(HTTPException) as expired:await service.read(value)
        assert expired.value.status_code==503
    assert await service.collect(who,rid,license['licenseId'],value,'')==captured
    assert scanner.calls==3
    await authority.revoke(who,uuid4(),quote_license['licenseId'],'Synthetic9Pass')
    with pytest.raises(HTTPException) as revoked:await service.read(value)
    assert revoked.value.status_code==503
    assert (await service.original(who,captured['pageId'],'Synthetic9Pass'))[0]==original
    async with db.connection() as conn:
        for table in ('market_facts','market_source_configs','market_discovery_pages'):
            assert not await(await conn.execute(f'SELECT 1 FROM {table}')).fetchone()
    assert scanner.calls==3
