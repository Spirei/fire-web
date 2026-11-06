"""Installed real parser contracts over synthetic retained bytes; no external IO."""
from dataclasses import asdict, replace
from datetime import datetime
from hashlib import sha256
from uuid import uuid4

from alcor_api.market_contract import Query, canonical
from alcor_api.market_worker import claim, execute, schedule
from alcor_api.market_yahoo_history import VERSION
from alcor_api.native_app_auth import issue_grant
from market_latest_candidate.test_market_authority import demand, market, market_settings  # noqa: F401
from test_history_protocols import seeded


async def test_true_yahoo_index_is_not_etf_proxy_and_original_is_retained(market):  # noqa: F811
    client,app,authority,_,_ = market
    authority.policies = (replace(authority.policies[0],source='yahoo',source_version=VERSION,fixture=False,purposes=('bars.day',)),)
    configured = await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'fixture'})
    revision = configured.json()['revision']
    authority.clock = lambda:datetime.fromisoformat('2026-10-21T20:30:00+00:00')
    query = Query('bars','US','SPX','day','none',instrument='index',start='2026-10-20',through='2026-10-21')
    stamps = [int(datetime.fromisoformat(value).timestamp()) for value in ('2026-10-20T14:00:00+00:00','2026-10-21T14:00:00+00:00')]
    raw = canonical({'chart':{'error':None,'result':[{'meta':{'symbol':'^GSPC','instrumentType':'INDEX','currency':'USD'},'timestamp':stamps,'indicators':{'quote':[{'open':[100,110],'high':[112,122],'low':[90,100],'close':[110,120],'volume':[None,0]}]}}]}}).encode()
    class YahooOriginal:
        fixture = True
        calls = 0
        async def read(self,policy,selected,cursor):
            self.calls += 1
            assert selected == query and cursor is None
            return raw,'http_response_body'
    transport = YahooOriginal()
    await demand(client,revision,query)
    assert await schedule(authority) == 1
    assert await execute(authority,await claim(authority.db,uuid4(),kind='market.history'),transport) == 'complete'
    async with app.state.db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE username='MarketReader'")).fetchone()
        grant = await issue_grant(conn,user,'portfolio.read','Synthetic true index evidence')
        page = await (await conn.execute('SELECT * FROM market_source_pages WHERE source_revision=%s',(revision,))).fetchone()
    headers = {'authorization':'Bearer '+grant['access_token'],'x-alcor-market-source':revision}
    for version in ('v1','v2'):
        for suffix in ('','&view=daily'):
            response = await client.get(f'/api/{version}/index-kline?key=spx'+suffix,headers=headers)
            assert response.status_code == 200,response.text
            data = response.json()['data']
            assert data['kind'] == 'index' and data['proxy'] is False and data['isActualIndex'] is True
            assert data['sourceSymbol'] == '^GSPC' and data['adjust'] == 'none'
            assert data['rows'] == [{'d':'2026-10-20','c':110},{'d':'2026-10-21','c':120}] if suffix else data['closes'] == [120]
    original = await client.get(f"/api/market/history/originals/{page['id']}?source_revision={revision}")
    assert original.status_code == 200 and original.content == raw
    assert sha256(original.content).hexdigest() == page['raw_sha256']
    assert transport.calls == 1


async def test_security_detail_positive_quote_history_and_unknown_metrics(market):  # noqa: F811
    client,_app,authority,revision,old_transport,headers = await seeded(market)
    class ActualQuote:
        fixture = True
        calls = 0
        async def read(self,policy,query,cursor):
            self.calls += 1
            return canonical({'query':asdict(query),'licenseRevision':policy.license_revision,'facts':[{
                'at':'2026-10-21T20:29:00+00:00','price':'123.4500','name':'Synthetic verified security',
                'currency':'USD','session':'REGULAR','cached':False,'prevClose':'120','volume':'0'}]}).encode(),'controlled_original'
    transport = ActualQuote()
    await demand(client,revision,Query('latest','US','AAPL'))
    assert await schedule(authority) == 1
    assert await execute(authority,await claim(authority.db,uuid4(),kind='market.latest'),transport) == 'observed'
    for version in ('v1','v2'):
        response = await client.get(f'/api/{version}/stock-detail?market=US&code=AAPL',headers=headers)
        assert response.status_code == 200,response.text
        data = response.json()['data']
        assert data['quote']['price'] == 123.45 and data['quote']['volume'] == 0
        assert data['quote']['name'] == 'Synthetic verified security'
        assert data['quote']['open'] is None and data['quote']['high'] is None and data['quote']['low'] is None
        assert [row['c'] for row in data['kline']] == [10,11]
        assert data['migration']['klineState'] == 'observed'
        assert data['migration']['quoteState']['priceExact'] == '123.4500'
    assert transport.calls == 1 and old_transport.calls == 4


async def test_every_old_entry_rejects_bad_credentials_without_source_or_business_writes(market):  # noqa: F811
    client,app,_authority,_revision,transport,_headers = await seeded(market)
    entries = [
        ('GET','/api/kline?market=US&code=AAPL'),
        ('GET','/api/kline/full?market=US&code=AAPL'),
        ('GET','/api/kline/five-day?market=US&code=AAPL'),
        ('GET','/api/kline/session-day?market=US&code=AAPL'),
        ('POST','/api/charts'),
    ]
    for version in ('v1','v2'):
        entries += [('GET',f'/api/{version}/'+route) for route in (
            'kline?market=US&code=AAPL','chart-series?market=US&code=AAPL&days=1',
            'index-kline?key=spx','kline-sessions?market=US&code=AAPL',
            'stock-detail?market=US&code=AAPL')]
        entries.append(('POST',f'/api/{version}/charts'))
    async def counts():
        async with app.state.db.connection() as conn:
            result = {}
            for table in ('market_facts','market_source_pages','market_data_operations','market_demands','market_streams','market_data_jobs','broker_accounts','cash_ledger_entries','portfolio_records'):
                result[table] = (await (await conn.execute('SELECT count(*) AS n FROM '+table)).fetchone())['n']
            return result
    before = await counts()
    for method,path in entries:
        kwargs = {'headers':{'authorization':'Bearer fat_invalid'}}
        if method == 'POST':kwargs['json'] = {'items':[{'id':'security','market':'US','code':'AAPL'}]}
        response = await client.request(method,path,**kwargs)
        assert response.status_code == 401,(path,response.text)
        assert response.headers['x-alcor-retire-context'] == 'true'
    assert await counts() == before
    assert transport.calls == 4
