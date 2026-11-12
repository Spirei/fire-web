"""Migration regression: explicit setup, typed indices and real session intent."""
from datetime import UTC,datetime
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


async def test_explicit_setup_is_owner_bound_durable_and_ticker_get_is_pure(legacy,app,monkeypatch):
    calls=[]
    async def resolve(host,port):calls.append(host);return ['8.8.8.8']
    monkeypatch.setattr('alcor_api.market_source_setup.resolve',resolve)
    rid=str(uuid4())
    response=await legacy.post('/api/fire/market-sources/setup',json={'requestId':rid})
    assert response.status_code==200,response.text
    assert response.json()['state']=='configured' and len(calls)==3
    replay=await legacy.post('/api/fire/market-sources/setup',json={'requestId':rid})
    assert replay.json()==response.json()
    settings=app.state.db.settings
    policies=settings.market_data_policies
    assert {p['source'] for p in policies}=={'tencent','eastmoney','yahoo'}
    assert next(p for p in policies if p['source']=='tencent')['timestamp_zones']
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM market_source_configs')).fetchone())['n']==3
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
    empty=await legacy.post('/api/v2/portfolio-series/prepare',json={'requestId':str(uuid4()),'days':330},headers={'authorization':'Bearer '+writer['access_token']})
    assert empty.status_code==200 and empty.json()['code']==0 and empty.json()['data']['state']=='empty',empty.text
