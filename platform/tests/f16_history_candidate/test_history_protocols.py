"""Four legacy capabilities consume preserved source facts without fetching on GET."""
from dataclasses import asdict, replace
from datetime import datetime
from uuid import uuid4

from alcor_api.market_contract import Query, canonical, digest
from alcor_api.market_worker import claim, execute, schedule
from alcor_api.native_app_auth import issue_grant
from market_latest_candidate.test_market_authority import demand, market, market_settings  # noqa: F401
from psycopg.types.json import Jsonb


async def seeded(market):  # noqa: F811
    client, app, authority, _, _ = market
    authority.policies = (replace(authority.policies[0], purposes=('latest', 'bars.day', 'bars.minute.ALL', 'bars.minute.REGULAR')),)
    source = await client.post('/api/market/sources', json={'request_id':str(uuid4()),'policy_id':'fixture'})
    assert source.status_code == 200, source.text
    revision = source.json()['revision']
    authority.clock = lambda: datetime.fromisoformat('2026-10-21T20:30:00+00:00')
    class Original:
        fixture = True
        calls = 0
        async def read(self, policy, query, cursor):
            self.calls += 1
            stamps = ['2026-10-20T14:00:00+00:00','2026-10-21T14:00:00+00:00'] if query.frame == 'day' else ['2026-10-21T13:30:00+00:00','2026-10-21T13:31:00+00:00']
            return canonical({'query':asdict(query),'licenseRevision':policy.license_revision,'facts':[
                {'at':stamp,'o':'10','h':'12','l':'9','c':str(10+i),'session':query.session,'currency':'USD'} for i, stamp in enumerate(stamps)]}).encode(), 'controlled_original'
    transport = Original()
    for query in [Query('bars','US','AAPL','day','qfq',start='2026-10-20',through='2026-10-21'),
                  Query('bars','US','SPY','day','qfq',start='2026-10-20',through='2026-10-21'),
                  Query('bars','US','AAPL','minute','none','ALL',start='2026-10-21',through='2026-10-21'),
                  Query('bars','US','AAPL','minute','none','REGULAR',start='2026-10-21',through='2026-10-21')]:
        await demand(client,revision,query)
    assert await schedule(authority) == 4
    for _ in range(4):
        task = await claim(authority.db,uuid4(),kind='market.history')
        assert await execute(authority,task,transport) == 'complete'
    async with app.state.db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE username='MarketReader'")).fetchone()
        grant = await issue_grant(conn,user,'portfolio.read','Synthetic F16 protocol decoder')
    return client,app,authority,revision,transport,{'authorization':'Bearer '+grant['access_token'],'x-alcor-market-source':revision}


async def test_four_capabilities_share_real_history_and_never_collect(market):  # noqa: F811
    client,app,_,revision,transport,headers = await seeded(market)
    for version in ('v1','v2'):
        full = await client.get(f'/api/{version}/stock-detail?market=US&code=AAPL&view=history',headers=headers)
        assert full.status_code == 200, full.text
        assert [row['c'] for row in full.json()['data']['kline']] == [10,11]
        detail = await client.get(f'/api/{version}/stock-detail?market=US&code=AAPL',headers=headers)
        assert detail.status_code == 200,detail.text
        assert detail.json()['data']['quote'] is None
        assert detail.json()['data']['currency'] == 'USD'
        assert detail.json()['data']['migration']['klineState'] == 'observed'
        assert detail.json()['data']['kline'] == full.json()['data']['kline']
        series = await client.get(f'/api/{version}/chart-series?market=US&code=AAPL&days=1',headers=headers)
        assert series.status_code == 200,series.text
        assert [point['price'] for point in series.json()['data']['points']] == [10,11]
        sessions = await client.get(f'/api/{version}/kline-sessions?market=US&code=AAPL',headers=headers)
        assert sessions.status_code == 200,sessions.text
        assert sessions.json()['data']['sessionClassificationAuthority'] == 'legacy_clock_ranges_not_verified_trading_calendar'
        assert sessions.json()['data']['actualTradingSessionKnown'] is False
        chart = await client.post(f'/api/{version}/charts',json={'items':[{'id':'actual','market':'US','code':'AAPL'}]},headers=headers)
        assert chart.status_code == 200,chart.text
        assert chart.json()['data']['charts']['actual']['points']
        for view, expected_kind in [('', 'benchmark_proxy')]:
            index = await client.get(f'/api/{version}/index-kline?key=spx'+view,headers=headers)
            assert index.status_code == 200,index.text
            assert index.json()['data']['kind'] == expected_kind
            assert index.json()['data']['proxy'] == (expected_kind == 'benchmark_proxy')
    five = await client.get('/api/kline/five-day?market=US&code=AAPL',headers=headers)
    assert five.status_code == 200,five.text
    assert five.json()['observationCoverage']['requestedDays'] == 5
    assert five.json()['observationCoverage']['observedLocalDates'] == ['2026-10-21']
    web_chart = await client.post('/api/charts',json={'items':[{'id':'actual','market':'US','code':'AAPL'}]},headers=headers)
    assert web_chart.status_code == 200,web_chart.text
    assert web_chart.json()['charts']['actual']['points']
    full = await client.get('/api/kline/full?market=US&code=AAPL&period=WEEK',headers=headers)
    assert full.status_code == 200,full.text
    assert full.json()['items'] == [{'d':'2026-10-21','o':10,'h':12,'l':9,'c':11,'v':None}]
    canonical_read = await client.get('/api/market/history?market=US&code=AAPL&frame=day&adjust=qfq&source_revision='+revision)
    assert canonical_read.status_code == 200,canonical_read.text
    assert len(canonical_read.json()['facts']) == 2
    assert transport.calls == 4
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM market_source_pages')).fetchone())['n'] == 4


async def test_history_fact_without_original_evidence_is_rejected_by_old_and_canonical(market):  # noqa: F811
    client,app,_,revision,transport,headers = await seeded(market)
    async with app.state.db.connection() as conn:
        row = await (await conn.execute("SELECT f.* FROM market_facts f JOIN market_streams s ON s.id=f.stream_id AND s.owner_id=f.owner_id WHERE s.query->>'code'='AAPL' AND s.query->>'frame'='day' LIMIT 1")).fetchone()
        contents = {**row['contents'],'at':'2026-10-21T15:00:00+00:00','c':'11.5'}
        await conn.execute('''INSERT INTO market_facts(owner_id,source_revision,series_fingerprint,stream_id,page_id,id,source_time,contents,fingerprint)
            VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(row['owner_id'],row['source_revision'],row['series_fingerprint'],row['stream_id'],row['page_id'],uuid4(),datetime.fromisoformat(contents['at']),Jsonb(contents),digest(contents)))
    for path in ['/api/kline/full?market=US&code=AAPL', '/api/market/history?market=US&code=AAPL&frame=day&adjust=qfq&source_revision='+revision]:
        response = await client.get(path,headers=headers if path.startswith('/api/kline/') else {})
        assert response.status_code == 503,response.text
    assert transport.calls == 4


async def test_legacy_default_history_uses_one_current_authorized_source_and_preserves_explicit_choice(market):  # noqa: F811
    client,app,authority,_,_=market
    base=authority.policies[0]
    authority.policies=(replace(base,id='futu',source='futu',source_version='futu-sdk-records-v1'),
                        replace(base,id='backup',source='eastmoney'))
    revisions={}
    q=Query('bars','US','AAPL','day','qfq',start='2026-10-20',through='2026-10-21')
    class Sources:
        fixture=True
        calls=0
        futu_day='20'
        async def read(self,policy,query,cursor):
            self.calls+=1
            if policy.source=='futu':
                return canonical({'records':[{'code':'US.AAPL','time_key':f'2026-10-{self.futu_day} 00:00:00',
                    'open':10,'high':12,'low':9,'close':10}],'nextCursor':None}).encode(),'controlled_sdk_body'
            return canonical({'query':asdict(query),'licenseRevision':policy.license_revision,
                'facts':[{'at':'2026-10-21T14:00:00+00:00','o':'10','h':'12','l':'9','c':'11','currency':'USD','session':query.session}],
                'nextCursor':None}).encode(),'controlled_source_body'
    source=Sources()
    for policy in authority.policies:
        response=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':policy.id})
        assert response.status_code==200,response.text
        revisions[policy.id]=response.json()['revision']
        await demand(client,revisions[policy.id],q)
    assert await schedule(authority)==2
    for _ in range(2):
        task=await claim(authority.db,uuid4(),kind='market.history')
        assert await execute(authority,task,source)=='complete'
    async with app.state.db.connection() as conn,conn.transaction():
        user=await(await conn.execute("SELECT * FROM users WHERE username='MarketReader'")).fetchone()
        pair=await issue_grant(conn,user,'portfolio.read','Synthetic source fallback')
    headers={'authorization':'Bearer '+pair['access_token']}
    for version in (1,2):
        path=f'/api/v{version}/stock-detail?market=US&code=AAPL&view=history'
        response=await client.get(path,headers=headers)
        assert response.status_code==200,response.text
        assert response.headers['x-alcor-market-source']==revisions['backup']
        assert [row['c'] for row in response.json()['data']['kline']]==[11]
        explicit=await client.get(path,headers={**headers,'x-alcor-market-source':revisions['futu']})
        assert explicit.status_code==200,explicit.text
        assert [row['c'] for row in explicit.json()['data']['kline']]==[10]
        missing=await client.get(path,headers={**headers,'x-alcor-market-source':str(uuid4())})
        assert missing.status_code==404,missing.text
    # Canonical explicit-selection clients retain their ambiguity contract.
    canonical_response=await client.get('/api/market/history?market=US&code=AAPL&frame=day&adjust=qfq')
    assert canonical_response.status_code==409,canonical_response.text
    assert source.calls==2
    # Once both sources have the same observed market date, configured Futu
    # precedence wins even though Yahoo-style timestamps can be later that day.
    source.futu_day='21'
    await demand(client,revisions['futu'],q,expected=1)
    assert await schedule(authority)==1
    assert await execute(authority,await claim(authority.db,uuid4(),kind='market.history'),source)=='complete'
    response=await client.get('/api/v2/stock-detail?market=US&code=AAPL&view=history',headers=headers)
    assert response.status_code==200,response.text
    assert response.headers['x-alcor-market-source']==revisions['futu']
    # Removing the live licence never authorizes reuse of the retained originals.
    authority.policies=tuple(p for p in authority.policies if p.id!='futu')
    response=await client.get('/api/v2/stock-detail?market=US&code=AAPL&view=history',headers=headers)
    assert response.status_code==200 and response.headers['x-alcor-market-source']==revisions['backup']
    refused=await client.get('/api/v2/stock-detail?market=US&code=AAPL&view=history',
        headers={**headers,'x-alcor-market-source':revisions['futu']})
    assert refused.status_code==403 and refused.headers['x-alcor-retire-context']=='true'
    assert source.calls==3
