"""Owner source workflows use synthetic approved replies, never live provider IO."""
import json
from copy import deepcopy
from dataclasses import replace
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from alcor_api.market_discovery_protocol import VERSION, Target
from alcor_api.native_app_auth import issue_grant
from alcor_api.security import Identity
from alcor_api.security import digest as token_digest
from fastapi import HTTPException
from market_latest_candidate.test_market_authority import market, market_settings  # noqa: F401


async def configured(market,service,target,source,version,purposes,markets=('US',)):  # noqa: F811
    client,_app,authority,_,_ = market
    authority.policies = (replace(authority.policies[0],source=source,source_version=version,target_id=target.id,
        target_fingerprint=target.fingerprint,fixture=False,purposes=purposes,markets=markets),)
    service.targets = (target,)
    response = await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'fixture'})
    assert response.status_code == 200,response.text
    return response.json()['revision']


async def actor(app,client):
    token=client.cookies.get('alcor_session')
    async with app.state.db.connection() as conn:
        row=await (await conn.execute('SELECT u.id,u.username,u.role,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=%s',(token_digest(token),))).fetchone()
    return Identity(**row,token_hash=token_digest(token),csrf=client.headers['x-csrf-token'])


async def native(app):
    async with app.state.db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE username='MarketReader'")).fetchone()
        grant = await issue_grant(conn,user,'portfolio.read','Synthetic F17 read')
    return {'authorization':'Bearer '+grant['access_token']}


@pytest.mark.parametrize('kind',['search','indices','top','ranking'])
async def test_owner_discovery_old_envelopes_uuid_original_and_revoke(market,kind):  # noqa: F811
    client,app,_authority,_,_ = market
    service = app.state.market_discovery
    if kind == 'search':
        target = Target('search-test','tencent','smartbox.gtimg.cn',('8.8.8.8',),True)
        query = {'kind':'search','q':'ZZZX'}
        raw = b'v_hint="us~ZZZX~Synthetic Corp~unused~GP-A";'
        paths = ['/api/search?q=ZZZX','/api/v1/search?q=ZZZX','/api/v2/search?q=ZZZX']
    elif kind == 'indices':
        target = Target('indices-test','tencent','qt.gtimg.cn',('8.8.8.8',),True)
        query = {'kind':'indices'}
        records=[]
        for symbol in ('usIXIC','usINX','hkHSI','hkHSTECH','sh000001','sz399001'):
            fields=['']*35;fields[1]='Synthetic Index';fields[3]='100';fields[5]='90';fields[30]='2026-11-03 10:00';fields[32]='1'
            records.append('v_'+symbol+'="'+'~'.join(fields)+'";')
        raw = ''.join(records).encode()
        paths = ['/api/indices','/api/v1/indices','/api/v2/indices']
    else:
        target = Target('list-test','eastmoney','push2.eastmoney.com',('8.8.8.8',),True)
        query = {'kind':kind,'market':'US',**({'metric':'volume'} if kind=='ranking' else {})}
        raw = json.dumps({'data':{'total':10,'diff':[{'f12':f'ZZZ{i}','f14':f'Synthetic {i}','f2':None,'f3':None,'f20':1000-i,'f5':1000-i,'f124':int(datetime.now(UTC).timestamp())} for i in range(10)]}}).encode()
        paths = ['/api/top-stocks?market=US'] if kind=='top' else ['/api/v1/market-ranking?market=US&metric=volume','/api/v2/market-ranking?market=US&metric=volume']
    revision = await configured(market,service,target,'market-discovery',VERSION,('discovery.'+kind+('.volume' if kind=='ranking' else ''),),('US','HK','CN'))
    class Source:
        calls=0
        async def read(self,selected,value):
            self.calls+=1
            assert selected == target and value == query
            return raw,200,{}
    source=Source();service.transport=source
    request={'requestId':str(uuid4()),'sourceRevision':revision,'query':query}
    acquired=await client.post('/api/market/discovery/collect',json=request)
    assert acquired.status_code==200,acquired.text
    assert acquired.json()['state']=='observed',acquired.text
    assert (await client.post('/api/market/discovery/collect',json=request)).json()==acquired.json()
    headers={**await native(app),'x-alcor-market-source':revision}
    for path in paths:
        response=await client.get(path,headers=headers)
        assert response.status_code==200,(path,response.text)
        body=response.json()['data'] if '/v1/' in path or '/v2/' in path else response.json()
        assert body['results'] if kind=='search' else body['groups'] if kind=='indices' else body['items']
        assert (await client.get(path,headers={'authorization':'Bearer fat_invalid'})).status_code==401
    forged=deepcopy(acquired.json())
    if kind=='indices':forged['projection']['groups'][0]['indices'][0]['name']='not the retained source'
    else:forged['projection']['items'][0]['name']='not the retained source'
    from alcor_api.market_discovery_protocol import digest
    forged['revision']=digest({'requestId':forged['requestId'],'originals':forged['originals'],'projection':forged['projection']})
    who=await actor(app,client)
    async with app.state.db.connection() as conn:
        with pytest.raises(HTTPException) as mismatch:await service.validate_projection(conn,who,forged)
        assert mismatch.value.status_code==503
    page=acquired.json()['originals'][0]
    original=await client.get(page['path'])
    assert original.status_code==200 and original.content==raw
    revoked=await client.request('DELETE','/api/market/sources/'+revision,json={'request_id':str(uuid4())})
    assert revoked.status_code==200,revoked.text
    assert (await client.get(paths[0],headers=headers)).status_code in (403,409,503)
    assert source.calls==1


@pytest.mark.parametrize('name',['company','financial'])
async def test_sec_real_directory_document_and_legacy_read_share_immutable_evidence(market,name):  # noqa: F811
    client,app,_authority,_,_=market
    service=app.state.sec_company_profiles if name=='company' else app.state.sec_financial_statements
    target=service.target_type('sec-test',('8.8.8.8',),('1.1.1.1',),'Synthetic contact@example.invalid')
    revision=await configured(market,service,target,'sec',service.source_version,(service.purpose,))
    directory=json.dumps({'0':{'ticker':'ZZZX','cik_str':1234567,'title':'Synthetic Corp'}}).encode()
    document=json.dumps({'cik':1234567,'tickers':['ZZZX'],'name':'Synthetic Corp','entityName':'Synthetic Corp','facts':{'us-gaap':{}},'exchanges':['NYSE']}).encode()
    class Source:
        calls=0
        async def read(self,selected,cik=None):
            self.calls+=1
            return directory if cik is None else document
    source=Source();service.transport=source
    base='/api/market/company-profiles' if name=='company' else '/api/market/financial-statements'
    request={'requestId':str(uuid4()),'sourceRevision':revision,'code':'ZZZX'}
    acquired=await client.post(base+'/collect',json=request)
    assert acquired.status_code==200,acquired.text
    assert acquired.json()['data']['state']=='observed'
    assert (await client.post(base+'/collect',json=request)).json()==acquired.json()
    headers=await native(app)
    paths=['/api/company-profile','/api/v1/company-profile','/api/v2/company-profile'] if name=='company' else ['/api/financials']
    for path in paths:
        response=await client.get(path+'?market=US&code=ZZZX&sourceRevision='+revision,headers=headers)
        assert response.status_code==200,response.text
        data=response.json()['data'] if '/v1/' in path or '/v2/' in path else response.json()
        assert data['company']=='Synthetic Corp'
        assert data['migration']['sourceRevision']==revision
    page=acquired.json()['data']['sourcePageId']
    original=await client.get(base+'/originals/'+page)
    assert original.status_code==200 and original.content==document
    who=await actor(app,client)
    async with app.state.db.connection() as conn:
        row=await (await conn.execute(f'SELECT * FROM {service.receipt_table} WHERE request_id=%s',(request['requestId'],))).fetchone()
        forged=deepcopy(row);forged['result']['profile']['company']='not the retained source'
        with pytest.raises(HTTPException) as mismatch:await service.verify_observation(conn,who,forged,service.authority.policies[0])
        assert mismatch.value.status_code==503
    assert source.calls==2


async def test_earnings_three_old_entries_original_and_real_missing_dates(market,monkeypatch):  # noqa: F811
    from alcor_api import earnings_calendar_protocol as protocol
    client,app,_authority,_,_=market
    service=app.state.earnings_calendar
    target=protocol.Target('calendar-test','nasdaq',('8.8.8.8',),True)
    revision=await configured(market,service,target,'nasdaq',protocol.SOURCE_VERSION,(protocol.PURPOSE,))
    day=datetime.now(UTC).date().isoformat();month=day[:7]
    raw=json.dumps({'data':{'rows':[{'symbol':'ZZZX','name':'Synthetic Corp','time':'time-pre-market','fiscalQuarterEnding':'Sep/2026','epsForecast':'1.23','noOfEsts':'2'}]}}).encode()
    calls=[]
    async def fetch(selected,market,selected_month,key):
        calls.append((selected.id,market,selected_month,key))
        return raw
    monkeypatch.setattr(protocol,'fetch',fetch)
    request={'requestId':str(uuid4()),'sourceRevision':revision,'market':'US','month':month,'pageKey':day}
    acquired=await client.post('/api/market/earnings/collect',json=request)
    assert acquired.status_code==200,acquired.text
    assert acquired.json()['data']['state']=='observed',acquired.text
    assert (await client.post('/api/market/earnings/collect',json=request)).json()==acquired.json()
    headers=await native(app)
    for path in ('/api/earnings','/api/v1/earnings','/api/v2/earnings'):
        response=await client.get(path+f'?market=US&month={month}&sourceRevision={revision}',headers=headers)
        assert response.status_code==200,response.text
        data=response.json()['data'] if '/v1/' in path or '/v2/' in path else response.json()
        assert data['items'][0]['symbol']=='ZZZX'
        assert data['coverage']['complete'] is False and len(data['coverage']['missingDates'])>=27
        assert data['items'][0]['price'] is None
    page=acquired.json()['data']['sourcePageId']
    original=await client.get('/api/market/earnings/originals/'+page)
    assert original.status_code==200 and original.content==raw
    actual_parse=protocol.parse
    def altered_parse(*args):
        parsed=actual_parse(*args);parsed['items'][0]['name']='not the retained source';return parsed
    monkeypatch.setattr(protocol,'parse',altered_parse)
    rejected=await client.get(f'/api/earnings?market=US&month={month}&sourceRevision={revision}',headers=headers)
    assert rejected.status_code==503,rejected.text
    assert len(calls)==1


async def test_owner_amount_ranking_reuses_exact_retained_quote_facts_not_new_prices(market):  # noqa: F811
    from zoneinfo import ZoneInfo

    from alcor_api.market_contract import Query, canonical
    from alcor_api.market_worker import claim, execute, schedule
    from market_latest_candidate.test_market_authority import demand
    client,app,authority,_,_=market
    now=datetime.now(UTC);authority.clock=lambda:now
    quote_policy=replace(authority.policies[0],id='futu-amounts',source='futu',source_version='futu-sdk-records-v1',purposes=('latest',))
    authority.policies=(quote_policy,)
    installed=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':quote_policy.id})
    quote_revision=installed.json()['revision']
    local=now.astimezone(ZoneInfo('America/New_York'))
    class SDK:
        fixture=True
        calls=0
        async def read(self,policy,query,cursor):
            self.calls+=1
            index=int(query.code[3:])
            return canonical({'records':[{'code':'US.'+query.code,'name':'Synthetic '+query.code,
                'update_time':local.strftime('%Y-%m-%d %H:%M:%S'),'last_price':'10','prev_close_price':'9',
                'volume':'100','turnover':str(10000-index*100)}]}).encode(),'sdk_json_representation_not_wire_bytes'
    sdk=SDK()
    for index in range(10):await demand(client,quote_revision,Query('latest','US','ZZZ'+str(index)))
    assert await schedule(authority)==10
    for _ in range(10):assert await execute(authority,await claim(authority.db,uuid4(),kind='market.latest'),sdk)=='observed'
    service=app.state.market_discovery
    target=Target('amount-scanner','tradingview','scanner.tradingview.com',('8.8.8.8',),True)
    scanner_policy=replace(quote_policy,id='scanner-amounts',source='market-discovery',source_version=VERSION,
        target_id=target.id,target_fingerprint=target.fingerprint,fixture=False,purposes=('discovery.ranking.amount',))
    authority.policies=(quote_policy,scanner_policy);service.targets=(target,)
    configured_response=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':scanner_policy.id})
    revision=configured_response.json()['revision']
    day=int(datetime.combine(local.date(),datetime.min.time(),UTC).timestamp())
    raw=json.dumps({'totalCount':10,'data':[{'s':'NASDAQ:ZZZ'+str(index),'d':['ZZZ'+str(index),'Synthetic '+str(index),100,100,day,'stock','NASDAQ','USD']} for index in range(10)]}).encode()
    class Scanner:
        calls=0
        async def read(self,selected,value):
            self.calls+=1
            return raw,200,{}
    scanner=Scanner();service.transport=scanner
    request={'requestId':str(uuid4()),'sourceRevision':revision,'query':{'kind':'ranking','market':'US','metric':'amount'}}
    collected=await client.post('/api/market/discovery/collect',json=request)
    assert collected.status_code==200,collected.text
    assert collected.json()['projection']['rankingVerified'] is True,collected.text
    headers={**await native(app),'x-alcor-market-source':revision}
    for version in ('v1','v2'):
        response=await client.get(f'/api/{version}/market-ranking?market=US&metric=amount',headers=headers)
        assert response.status_code==200,response.text
        items=response.json()['data']['items']
        assert [item['amount'] for item in items]==[10000-index*100 for index in range(10)]
    assert sdk.calls==10 and scanner.calls==1


@pytest.mark.parametrize('region',['CN','HK'])
async def test_earnings_non_us_fixed_sources_preserve_market_and_unknowns(market,monkeypatch,tmp_path,region):  # noqa: F811
    from alcor_api import earnings_calendar_protocol as protocol
    client,app,_authority,_,_=market
    service=app.state.earnings_calendar
    provider='eastmoney' if region=='CN' else 'xueqiu'
    cookie=None
    if region=='HK':
        file=tmp_path/'synthetic-cookie';file.write_text('synthetic_cookie=not-a-real-credential');file.chmod(0o600);cookie=str(file)
    target=protocol.Target('calendar-'+region,provider,('8.8.8.8',),True,cookie_file=cookie)
    revision=await configured(market,service,target,provider,protocol.SOURCE_VERSION,(protocol.PURPOSE,),(region,))
    day=datetime.now(UTC).date().isoformat();month=day[:7]
    if region=='CN':
        body={'success':True,'result':{'pages':1,'data':[{'SECURITY_CODE':'000001','SECURITY_NAME_ABBR':'Synthetic CN','FIRST_APPOINT_DATE':day,'REPORT_TYPE_NAME':'Q3'}]}}
    else:
        epoch=int(datetime.fromisoformat(day+'T04:00:00+00:00').timestamp()*1000)
        body={'error_code':0,'data':{'items':[{'pre_hour':[{'symbol':'700','name':'Synthetic HK','report_date':epoch,'fiscal_year':2026,'report_type_name':'Q3'}]}]}}
    raw=json.dumps(body).encode();calls=[]
    async def fetch(*args):calls.append(args[1:]);return raw
    monkeypatch.setattr(protocol,'fetch',fetch)
    acquired=await client.post('/api/market/earnings/collect',json={'requestId':str(uuid4()),'sourceRevision':revision,'market':region,'month':month,'pageKey':'1' if region=='CN' else 'month'})
    assert acquired.status_code==200,acquired.text
    assert acquired.json()['data']['state']=='observed',acquired.text
    headers=await native(app)
    for path in ('/api/earnings','/api/v1/earnings','/api/v2/earnings'):
        response=await client.get(path+f'?market={region}&month={month}&sourceRevision={revision}',headers=headers)
        if region=='HK' and path!='/api/earnings':
            assert response.status_code==400,response.text
            continue
        assert response.status_code==200,response.text
        data=response.json()['data'] if '/v1/' in path or '/v2/' in path else response.json()
        assert data['items'][0]['market']==region and data['items'][0]['price'] is None
        assert data['items'][0]['symbol']==('000001' if region=='CN' else '00700')
        assert data['coverage']['complete'] is False
    assert len(calls)==1
