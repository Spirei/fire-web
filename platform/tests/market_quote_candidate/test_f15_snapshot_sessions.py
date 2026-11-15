"""Actual SDK record schema through PG, explicit session and owner quote projection."""
from dataclasses import asdict,replace
from datetime import UTC,datetime,timedelta
from uuid import uuid4

from alcor_api.market_contract import Query,canonical
from alcor_api.market_worker import claim,execute,schedule
from market_latest_candidate.test_market_authority import demand
from test_quote_reads import hashes


async def test_provider_extended_fields_and_underlying_identity_never_become_regular_or_underlying_price(market, monkeypatch):
    client,app,authority,_transport,_=market
    policy=replace(authority.policies[0],id='actual-futu-schema',source='futu',source_version='futu-sdk-records-v1')
    authority.policies=(policy,)
    authority.clock=lambda:datetime(2026,10,21,2,tzinfo=UTC)
    configured=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':policy.id})
    assert configured.status_code==200,configured.text
    revision=configured.json()['revision']
    class SDK:
        fixture=True
        calls=0
        async def read(self,policy,query,cursor):
            self.calls+=1
            hour={'REGULAR':'10','PRE':'08','AFTER':'17','OVERNIGHT':'21'}[query.session]
            day = '21' if query.code == 'MSFT' and query.session == 'PRE' else '20'
            row={'code':f'US.{query.code}','name':'Controlled SDK snapshot','update_time':f'2026-10-{day} {hour}:00:00',
                 'last_price':'100','prev_close_price':'90','stock_owner':'US.REAL-OWNER',
                 'pre_price':'110','pre_change_val':'5','after_price':'120','after_change_val':'7',
                 'overnight_price':'130','overnight_change_val':'10','volume':'999','turnover':'777'}
            return canonical({'records':[row]}).encode(),'sdk_json_representation_not_wire_bytes'
    sdk=SDK()
    for session in ('REGULAR','PRE','AFTER','OVERNIGHT'):
        q=Query('latest','US','AAPL',session=session)
        await demand(client,revision,q)
        assert await schedule(authority)==1
        task=await claim(authority.db,uuid4(),kind='market.latest');assert task
        assert await execute(authority,task,sdk)=='observed'
    before=await hashes(app)
    for session,expected in [('REGULAR',100),('PRE',110),('AFTER',120),('OVERNIGHT',130)]:
        result=await client.post('/api/market/quotes/read',headers={'x-alcor-market-source':revision},json={'items':[{'id':'x','market':'US','code':'AAPL'}],'session':session})
        assert result.status_code==200,result.text
        dto=result.json()['quotes']['x']
        assert dto['price']==expected and dto['requestedSession']==session
        assert dto['session']==('UNKNOWN' if session=='REGULAR' else session)
        assert dto['underlyingSymbol']=='US.REAL-OWNER' and 'underlyingPrice' not in dto
        assert dto['cached'] is None and dto['sourceTimestampAuthority'].startswith('snapshot_update_time_not_individual')
        if session!='REGULAR':
            assert 'volume' not in dto and 'amount' not in dto
            assert dto['priceField']=={'PRE':'pre_price','AFTER':'after_price','OVERNIGHT':'overnight_price'}[session]
    from alcor_api.native_app_auth import issue_grant
    async with app.state.db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE username='MarketReader'")).fetchone()
        grant = await issue_grant(conn, user, 'portfolio.read', 'Isolated extended quote playback')
    headers = {'authorization': 'Bearer ' + grant['access_token'], 'x-alcor-market-source': revision}
    for session, expected in [('PRE',110), ('AFTER',120), ('OVERNIGHT',130)]:
        monkeypatch.setattr('alcor_api.legacy_quote_api.requested_session', lambda: session)
        for version in (1, 2):
            reply = await client.post(f'/api/v{version}/quotes', headers=headers, json={
                'items': [{'id':'x','market':'US','code':'AAPL'}], 'includeMarketCap':False})
            assert reply.status_code == 200, reply.text
            dto = reply.json()['data']['quotes']['x']
            expected_session = 'UNKNOWN' if session == 'PRE' else session
            assert dto['price'] == (100 if session == 'PRE' else expected)
            assert dto['session'] == expected_session
            assert dto['expectedSession'] == session and dto['extendedUnavailable'] == (session == 'PRE')
            assert dto['time'] and dto['prevClose'] is not None
    assert sdk.calls==4
    async with app.state.db.connection() as conn:
        rows=await(await conn.execute('SELECT contents FROM market_facts')).fetchall()
    assert len(rows)==4 and all('underlyingPrice' not in row['contents'] for row in rows)

    authority.clock = lambda: datetime(2026, 10, 21, 12, 1, tzinfo=UTC)
    for session in ('REGULAR', 'PRE'):
        await demand(client, revision, Query('latest', 'US', 'MSFT', session=session))
        assert await schedule(authority) == 1
        task = await claim(authority.db, uuid4(), kind='market.latest')
        assert task and await execute(authority, task, sdk) == 'observed'
    monkeypatch.setattr('alcor_api.legacy_quote_api.requested_session', lambda: 'PRE')
    for version in (1, 2):
        reply = await client.post(f'/api/v{version}/quotes', headers=headers, json={
            'items': [{'id': 'current-pre', 'market': 'US', 'code': 'MSFT'}],
            'includeMarketCap': False,
        })
        assert reply.status_code == 200, reply.text
        dto = reply.json()['data']['quotes']['current-pre']
        assert dto['session'] == dto['expectedSession'] == 'PRE'
        assert dto['extendedUnavailable'] is False
        assert (dto['price'], dto['prevClose'], dto['change']) == (110, 105, 5)
        assert datetime.fromisoformat(dto['time']) == datetime(2026, 10, 21, 12, tzinfo=UTC)


async def test_fund_units_are_exact_observation_and_aum_is_not_market_cap(market):
    client,app,authority,_transport,_=market
    policy=replace(authority.policies[0],id='fund-futu-schema',source='futu',source_version='futu-sdk-records-v1')
    authority.policies=(policy,)
    authority.clock=lambda:datetime(2026,10,20,14,tzinfo=UTC)+timedelta(seconds=1)
    configured=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':policy.id})
    assert configured.status_code==200,configured.text
    revision=configured.json()['revision']
    class SDK:
        fixture=True
        async def read(self,policy,query,cursor):
            row={'code':'US.FUND','name':'Controlled fund','update_time':'2026-10-20 10:00:00','last_price':'123.45',
                 'stock_valid':False,'trust_valid':True,'trust_outstanding_units':'100.000001',
                 'trust_aum':'999999','trust_netAssetValue':'122.2'}
            return canonical({'records':[row]}).encode(),'sdk_json_representation_not_wire_bytes'
    await demand(client,revision,Query('latest','US','FUND'))
    assert await schedule(authority)==1
    task=await claim(authority.db,uuid4(),kind='market.latest');assert task
    assert await execute(authority,task,SDK())=='observed'
    for include in (False,True):
        result=await client.post('/api/market/quotes/read',headers={'x-alcor-market-source':revision},json={'items':[{'id':'fund','market':'US','code':'FUND'}],'includeMarketCap':include})
        assert result.status_code==200,result.text
        dto=result.json()['quotes']['fund'];metrics=dto['fundMetrics']
        assert metrics['units']=='100.000001' and metrics['assetsUnderManagement']=='999999'
        assert metrics['aumIsMarketCapitalization'] is False
        if include:
            assert metrics['calculatedMarketCap']=='12345.00012345'
            assert dto['marketCapBasis']=='observed_fund_units_times_observed_quote'
        else:
            assert metrics['calculatedMarketCap'] is None and 'marketCap' not in dto
