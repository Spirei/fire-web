"""Migration regression: explicit setup, typed indices and real session intent."""
from datetime import UTC,datetime,timedelta
from dataclasses import asdict
from uuid import uuid4
import json

import pytest
from alcor_api.market_contract import Query
from alcor_api.market_eastmoney_latest import parse
from alcor_api.market_sessions import requested_session
from test_legacy_site_settings import legacy  # noqa: F401


def test_us_session_intent_and_weekend_do_not_turn_regular_prices_into_extended():
    assert requested_session(datetime(2026,11,12,7,tzinfo=UTC))=='OVERNIGHT'
    assert requested_session(datetime(2026,11,12,12,tzinfo=UTC))=='PRE'
    assert requested_session(datetime(2026,11,12,16,tzinfo=UTC))=='REGULAR'
    assert requested_session(datetime(2026,11,12,22,tzinfo=UTC))=='AFTER'
    assert requested_session(datetime(2026,11,14,7,tzinfo=UTC))=='REGULAR'


def test_eastmoney_typed_index_observed_epoch_and_exact_identity():
    q=Query('latest','US','IXIC',instrument='index')
    row={'f2':25466.19,'f3':1.6,'f4':401.05,'f12':'NDX','f13':100,'f124':1794430800}
    facts,_,_=parse(json.dumps({'rc':0,'data':{'diff':[row]}}).encode(),q)
    assert facts[0]['price']=='25466.19' and facts[0]['sourceSymbol']=='100.NDX'
    for bad in ({**row,'f12':'SPX'},{k:v for k,v in row.items() if k!='f124'},{**row,'f2':0}):
        with pytest.raises((ValueError,TypeError)):parse(json.dumps({'data':{'diff':[bad]}}).encode(),q)


def test_tencent_minute_keeps_original_clock_and_prices_without_making_bars():
    from types import SimpleNamespace
    from alcor_api.market_tencent_minute import VERSION,parse as minute_parse
    from alcor_api.legacy_chart_series import minute_points
    query=Query('price_series','CN','002602',frame='minute',start='2026-11-11',through='2026-11-12')
    body={'code':0,'data':{'sz002602':{'data':{'date':'20261112','data':['0930 11.85 8108 9607980.00','0931 11.75 54333 63975032.00']}}}}
    facts,issues,cursor=minute_parse(json.dumps(body).encode(),query)
    assert not issues and cursor is None and len(facts)==2
    assert facts[0]['at']=='2026-11-12T01:30:00+00:00' and facts[0]['price']=='11.85'
    assert not {'o','h','l','c','volume','sourceBlank'} & set(facts[0])
    policy=SimpleNamespace(source='tencent',source_version=VERSION)
    rows=[{'contents':dict(f,fixture=False),'source_time':datetime.fromisoformat(f['at'])} for f in facts]
    points=minute_points(rows,policy,query,1,datetime(2026,11,12,4,tzinfo=UTC))
    assert [p['price'] for p in points]==[11.85,11.75]
    for wrong in ({'code':0,'data':{'sz000001':body['data']['sz002602']}},
                  {'code':0,'data':{'sz002602':{'data':{'date':'','data':[]}}}},
                  {'code':0,'data':{'sz002602':{'data':{'date':'20261112','data':['0930 11.85 1','0930 12.00 2']}}}}):
        with pytest.raises(ValueError):minute_parse(json.dumps(wrong).encode(),query)


async def test_tencent_minute_preparation_collection_and_app_read_share_facts(legacy,app,monkeypatch):
    from zoneinfo import ZoneInfo
    from alcor_api.market_worker import schedule,claim,execute
    from alcor_api.native_app_auth import issue_grant
    async def resolve(host,port):return ['8.8.8.8']
    monkeypatch.setattr('alcor_api.market_source_setup.resolve',resolve)
    assert (await legacy.post('/api/fire/market-sources/setup',json={'requestId':str(uuid4())})).status_code==200
    body={'items':[{'id':'cn','market':'CN','code':'002602'}]}
    first=await legacy.post('/api/charts',json=body)
    assert first.status_code==200,first.text
    rid=str(uuid4())
    intent=await legacy.post('/api/kline/prepare',json={'requestId':rid,'items':[{'market':'CN','code':'002602'}],'days':5,'minute':True})
    assert intent.status_code==200,intent.text
    before=await legacy.get('/api/kline/preparations/'+rid)
    assert before.status_code==200 and before.json()['pending'] is True,before.text
    class Source:
        fixture=True
        async def read(self,policy,query,cursor):
            assert policy.source_version=='tencent-minute-v1'
            date=(datetime.now(ZoneInfo('Asia/Shanghai'))-timedelta(days=1)).strftime('%Y%m%d')
            return json.dumps({'code':0,'data':{'sz002602':{'data':{'date':date,'data':['0930 11.85 1','0931 11.75 2']}}}}).encode(),'http_response_body'
    assert await schedule(app.state.market_authority)==1
    task=await claim(app.state.db,uuid4(),kind='market.history');assert task
    assert await execute(app.state.market_authority,task,Source())=='complete'
    after=await legacy.get('/api/kline/preparations/'+rid)
    assert after.status_code==200 and after.json()['pending'] is False and after.json()['state']=='complete',after.text
    web=await legacy.post('/api/charts',json=body)
    assert web.status_code==200 and len(web.json()['charts']['cn']['points'])==2,web.text
    async with app.state.db.connection() as conn:
        user=await (await conn.execute("SELECT * FROM users WHERE username='AdminOne'")).fetchone()
        pair=await issue_grant(conn,user,'portfolio.read','Synthetic minute reader')
    native=await legacy.post('/api/v2/charts',json=body,headers={'authorization':'Bearer '+pair['access_token']})
    assert native.status_code==200 and native.json()['code']==0,native.text
    assert native.json()['data']['charts']==web.json()['charts']


async def test_explicit_setup_is_owner_bound_durable_and_ticker_get_is_pure(legacy,app,monkeypatch):
    calls=[]
    async def resolve(host,port):calls.append(host);return ['8.8.8.8']
    monkeypatch.setattr('alcor_api.market_source_setup.resolve',resolve)
    rid=str(uuid4())
    response=await legacy.post('/api/fire/market-sources/setup',json={'requestId':rid})
    assert response.status_code==200,response.text
    assert response.json()['state']=='configured' and len(calls)==4
    replay=await legacy.post('/api/fire/market-sources/setup',json={'requestId':rid})
    assert replay.json()==response.json()
    settings=app.state.db.settings
    policies=settings.market_data_policies
    assert {p['source'] for p in policies}=={'tencent','eastmoney','yahoo'}
    assert next(p for p in policies if p['source']=='tencent')['timestamp_zones']
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM market_source_configs')).fetchone())['n']==4
    quote=await legacy.post('/api/quotes',json={'items':[{'id':'a','market':'CN','code':'002602'}]})
    assert quote.status_code==200 and quote.headers['x-alcor-quote-tracked']=='true',quote.text
    prep=await legacy.post('/api/kline/prepare',json={'requestId':str(uuid4()),'items':[{'market':'HK','code':'00700'}],'days':330})
    assert prep.status_code==200,prep.text
    async with app.state.db.connection() as conn:
        n=(await (await conn.execute('SELECT count(*) n FROM market_streams')).fetchone())['n']
    assert (await legacy.get('/api/fire/ticker')).status_code==200
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM market_streams')).fetchone())['n']==n
    assert (await legacy.post('/api/fire/market-sources/setup',json={'requestId':str(uuid4()),'url':'http://127.0.0.1'})).status_code==400


async def test_setup_upgrades_owned_pins_once_and_dns_rotation_does_not_reset_source_identity(legacy,app,monkeypatch):
    from alcor_api import market_source_setup as setup
    from alcor_api.dividend_sources import Target
    address='8.8.8.8'
    async def resolve(host,port):return [address]
    def old_target(*args,**kwargs):kwargs['dns_policy']='pinned';return Target(*args,**kwargs)
    monkeypatch.setattr(setup,'resolve',resolve)
    monkeypatch.setattr(setup,'Target',old_target)
    assert (await legacy.post('/api/fire/market-sources/setup',json={'requestId':str(uuid4())})).status_code==200
    old_policies={p['id']:p for p in app.state.db.settings.market_data_policies}
    old_targets=app.state.db.settings.dividend_source_targets
    assert all(t['dns_policy']=='pinned' for t in old_targets)
    monkeypatch.setattr(setup,'Target',Target)
    address='1.1.1.1'
    rid=str(uuid4())
    upgraded=await legacy.post('/api/fire/market-sources/setup',json={'requestId':rid})
    assert upgraded.status_code==200,upgraded.text
    targets=app.state.db.settings.dividend_source_targets
    assert all(t['dns_policy']=='public_dns' and t['addresses']==['1.1.1.1'] for t in targets)
    for policy in app.state.db.settings.market_data_policies:
        previous=old_policies[policy['id']]
        assert policy['target_fingerprint']!=previous['target_fingerprint']
        assert {k:v for k,v in policy.items() if k!='target_fingerprint'}=={k:v for k,v in previous.items() if k!='target_fingerprint'}
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM market_source_configs')).fetchone())['n']==8
    assert (await legacy.post('/api/fire/market-sources/setup',json={'requestId':rid})).json()==upgraded.json()
    address='8.8.4.4'
    repeated=await legacy.post('/api/fire/market-sources/setup',json={'requestId':str(uuid4())})
    assert repeated.status_code==200,repeated.text
    assert app.state.db.settings.dividend_source_targets==targets
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM market_source_configs')).fetchone())['n']==8


def test_futu_night_uses_real_minute_clock_when_snapshot_keeps_regular_close():
    from alcor_api.market_contract import futu_rows
    q=Query('latest','US','AAPL',session='OVERNIGHT')
    snapshot={'code':'US.AAPL','name':'AAPL','update_time':'2026-11-11 16:00:00','last_price':'355.63','prev_close_price':'348.51','overnight_price':'346.46','overnight_change_val':'-2.05'}
    minute={'code':'US.AAPL','name':'AAPL','time':'2026-11-11 20:12:00','is_blank':False,'cur_price':'356.20','last_close':'355.63','volume':100}
    facts,issues=futu_rows({'records':[snapshot],'realTimeRecords':[minute]},q)
    assert not issues and len(facts)==1
    quote=facts[0]
    assert quote['price']=='356.20' and quote['at']=='2026-11-12T01:12:00+00:00'
    assert quote['priceField']=='rt_data.cur_price' and quote['prevClose']=='355.63' and quote['change']=='0.57'
    assert quote['session']=='OVERNIGHT' and 'volume' not in quote and 'high' not in quote
    for bad in ({**minute,'code':'US.MSFT'},{**minute,'is_blank':True},{**minute,'time':'2026-11-11 16:00:00'},{**minute,'last_close':None}):
        rejected,issues=futu_rows({'records':[snapshot],'realTimeRecords':[bad]},q)
        assert not rejected and issues
    # An old night field beside a current regular close is never refreshed at now.
    rejected,issues=futu_rows({'records':[snapshot]},q)
    assert not rejected and issues


@pytest.mark.parametrize('error,reason,message',[
    (ValueError('address_not_approved'),'source_target_changed','来源地址校验未通过'),
    (TimeoutError('private host and token'),'source_timeout','来源响应超时'),
    (ValueError('private provider response with credentials'),'quote_not_observed','未取得该市场报价'),
])
def test_probe_failures_explain_fixed_categories_without_exposing_private_details(error,reason,message):
    from alcor_api.market_source_tests import public_probe_failure
    assert public_probe_failure(error)=={'reason':reason,'message':message}


def test_probe_http_failure_never_exposes_vendor_body():
    from alcor_api.dividend_source_transport import ResponseFailure
    from alcor_api.market_source_tests import public_probe_failure
    assert public_probe_failure(ResponseFailure(b'private response with token',429))=={'reason':'source_http_error','message':'来源返回 HTTP 429'}


async def test_adding_history_preserves_opend_and_replaces_superseded_client_leases(legacy,app,monkeypatch):
    async def resolve(host,port):return ['8.8.8.8']
    async def diagnostic(self,policy,action):return {'responded':True,'qotLogined':True}
    monkeypatch.setattr('alcor_api.market_source_setup.resolve',resolve)
    monkeypatch.setattr('alcor_api.market_transport.Transport.diagnostic',diagnostic)
    current=(await legacy.get('/api/settings')).json()
    saved=await legacy.put('/api/settings',json={'requestId':str(uuid4()),'revision':current['revision'],'privateRevision':current['privateRevision'],'currentPassword':'Synthetic9Pass','futuHost':'192.0.2.41','futuPort':'11111','futuApproved':True,'quoteSource':'auto'})
    assert saved.status_code==200,saved.text
    body={'items':[{'id':'a','market':'US','code':'AAPL'}]}
    first=await legacy.post('/api/quotes',json=body)
    assert first.headers['x-alcor-quote-tracked']=='true',first.text
    configured=await legacy.post('/api/fire/market-sources/setup',json={'requestId':str(uuid4())})
    assert configured.status_code==200,configured.text
    again=await legacy.post('/api/quotes',json=body)
    assert again.status_code==200 and again.headers['x-alcor-quote-tracked']=='true',again.text
    targets=[t for t in app.state.db.settings.dividend_source_targets if t['source']=='futu']
    assert len(targets)==1 and targets[0]['host']=='192.0.2.41' and targets[0]['port']==11111
    async with app.state.db.connection() as conn:
        retired=(await (await conn.execute("SELECT count(*) n FROM market_demands WHERE origin='client' AND revoked_at IS NOT NULL")).fetchone())['n']
        active=(await (await conn.execute("SELECT count(*) n FROM market_demands WHERE origin='client' AND revoked_at IS NULL")).fetchone())['n']
    assert retired==1 and active==1


async def test_native_prepare_requires_write_scope_and_keeps_versioned_envelope(legacy,app):
    from alcor_api.native_app_auth import issue_grant
    async with app.state.db.connection() as conn:
        user=await (await conn.execute("SELECT * FROM users WHERE username='AdminOne'")).fetchone()
        reader=await issue_grant(conn,user,'portfolio.read','Synthetic read-only history')
        writer=await issue_grant(conn,user,'portfolio.read portfolio.write','Synthetic history intent')
    request={'requestId':str(uuid4()),'items':[{'market':'US','code':'AAPL'}],'days':330}
    denied=await legacy.post('/api/v2/kline/prepare',json=request,headers={'authorization':'Bearer '+reader['access_token']})
    assert denied.status_code==403 and denied.json()['code']!=0,denied.text
    accepted=await legacy.post('/api/v2/kline/prepare',json=request,headers={'authorization':'Bearer '+writer['access_token']})
    assert accepted.status_code==200 and accepted.json()['code']==0,accepted.text
    assert accepted.json()['data']['requestId']==request['requestId']
    progress_url='/api/v2/kline/preparations/'+request['requestId']
    async with app.state.db.connection() as conn:
        before={t:(await (await conn.execute('SELECT count(*) n FROM '+t)).fetchone())['n'] for t in ('market_demands','market_data_jobs','market_source_pages','market_data_operations')}
    # A read-only App connection can follow the original task. Reading state
    # neither starts a new task nor renews an existing subscription.
    state=await legacy.get(progress_url,headers={'authorization':'Bearer '+reader['access_token']})
    assert state.status_code==200 and state.json()['data']['state']=='complete',state.text
    assert state.json()['data']['unavailable']==[{**request['items'][0],'instrument':'equity'}]
    assert (await legacy.get('/api/v2/kline/preparations/'+str(uuid4()),headers={'authorization':'Bearer '+reader['access_token']})).status_code==404
    async with app.state.db.connection() as conn:
        after={t:(await (await conn.execute('SELECT count(*) n FROM '+t)).fetchone())['n'] for t in before}
    assert before==after
    empty=await legacy.post('/api/v2/portfolio-series/prepare',json={'requestId':str(uuid4()),'days':330},headers={'authorization':'Bearer '+writer['access_token']})
    assert empty.status_code==200 and empty.json()['code']==0 and empty.json()['data']['state']=='empty',empty.text


async def test_web_app_and_ticker_share_typed_index_facts_and_reads_never_collect(legacy,app,monkeypatch):
    import time
    from alcor_api.market_indices import INDEXES,provider_index
    from alcor_api.market_worker import schedule,claim,execute
    from alcor_api.native_app_auth import issue_grant
    async def resolve(host,port):return ['8.8.8.8']
    monkeypatch.setattr('alcor_api.market_source_setup.resolve',resolve)
    configured=await legacy.post('/api/fire/market-sources/setup',json={'requestId':str(uuid4())})
    assert configured.status_code==200,configured.text
    for _ in range(2):
        demanded=await legacy.post('/api/fire/indices/demand',json={'requestId':str(uuid4())})
        assert demanded.status_code==200,demanded.text
    authority=app.state.market_authority
    class Source:
        fixture=True
        async def read(self,policy,query,cursor):
            assert policy.source=='eastmoney'
            from alcor_api.market_eastmoney_latest import symbol
            market,code=symbol(query).split('.',1)
            row={'f12':code,'f13':int(market),'f2':123.45 if query.instrument=='index' else 9.87,'f3':1.25,'f17':120,'f124':int(time.time())}
            return json.dumps({'rc':0,'data':{'diff':[row]}}).encode(),'http_response_body'
    assert await schedule(authority)==9
    for _ in range(9):
        task=await claim(authority.db,uuid4(),kind='market.latest');assert task
        assert await execute(authority,task,Source())=='observed'
    presentation=[{'key':'dji','market':'US','secid':'100.DJIA','label':'道琼斯指数'}]
    monkeypatch.setattr('alcor_api.fire_current_web.ticker_items',lambda config:(presentation,[{'id':'dji','market':'US','code':'DJI'}]))
    async with app.state.db.connection() as conn:
        user=await (await conn.execute("SELECT * FROM users WHERE username='AdminOne'")).fetchone()
        pair=await issue_grant(conn,user,'portfolio.read','Synthetic shared index reader')
        before={t:(await (await conn.execute('SELECT count(*) n FROM '+t)).fetchone())['n'] for t in ('market_demands','market_data_jobs','market_source_pages')}
    web=await legacy.get('/api/indices');assert web.status_code==200,web.text
    native_headers={'authorization':'Bearer '+pair['access_token']}
    denied=await legacy.post('/api/v2/indices/prepare',headers=native_headers,json={'requestId':str(uuid4())})
    assert denied.status_code==403 and denied.json()['code']!=0,denied.text
    native=await legacy.get('/api/v2/indices',headers=native_headers)
    assert native.status_code==200 and native.json()['code']==0,native.text
    ticker=await legacy.get('/api/fire/ticker');assert ticker.status_code==200,ticker.text
    first=web.json()['groups'][0]['indices'][0]
    assert first==native.json()['data']['groups'][0]['indices'][0]
    assert first['latest']==ticker.json()['items'][0]['price']==123.45
    assert first['sourceRevision']==ticker.json()['items'][0]['sourceRevision']
    assert first['time']==ticker.json()['items'][0]['observedAt']
    assert web.json()['coverage']['observedCount']==len(INDEXES) and web.json()['coverage']['complete'] is True
    assert all(g['open'] is None for g in web.json()['groups']),'a quote does not prove a trading calendar status'
    async with app.state.db.connection() as conn:
        after={t:(await (await conn.execute('SELECT count(*) n FROM '+t)).fetchone())['n'] for t in before}
    assert after==before
    # CN 000001 is both an index identity and an SZ equity code. A stock
    # request must never inherit the index value while its own fact is missing.
    selected={'x-alcor-market-source':first['sourceRevision']}
    stock_body={'items':[{'id':'bank','market':'CN','code':'000001'}]}
    missing=await legacy.post('/api/quotes',json=stock_body,headers=selected)
    assert missing.status_code==200 and missing.json()['quotes']=={},missing.text
    await legacy.post('/api/quotes',json=stock_body,headers=selected)
    assert await schedule(authority)==1
    for _ in range(12):
        task=await claim(authority.db,uuid4(),kind='market.latest');assert task
        assert await execute(authority,task,Source())=='observed'
        async with app.state.db.connection() as conn:
            found=await (await conn.execute("SELECT 1 FROM market_facts f JOIN market_streams s ON s.owner_id=f.owner_id AND s.id=f.stream_id WHERE s.query->>'instrument'='equity' LIMIT 1")).fetchone()
        if found:break
    stock=await legacy.post('/api/quotes',json=stock_body,headers=selected)
    assert stock.json()['quotes']['bank']['price']==9.87,stock.text
    indices_again=await legacy.get('/api/v2/indices',headers=native_headers)
    cn=next(g for g in indices_again.json()['data']['groups'] if g['market']=='CN')
    assert cn['indices'][0]['latest']==123.45
    subscribed=await legacy.get('/api/v2/quote-subscriptions',headers=native_headers)
    assert subscribed.status_code==200,subscribed.text
    assert len(subscribed.json()['data']['subscriptions'])==1,'stock subscription presentation excludes internal index intent'
