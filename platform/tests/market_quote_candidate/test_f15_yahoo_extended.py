"""Fixed Yahoo Chart raw pages through owner PG, no fabricated overnight/PRE marks."""
import hashlib
import json
from dataclasses import replace
from datetime import UTC,datetime,timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from alcor_api.dividend_sources import Target
from alcor_api.market_contract import Query
from alcor_api.market_transport import Transport
from alcor_api.market_worker import claim,execute,schedule
from market_latest_candidate.test_market_authority import demand
from test_quote_reads import hashes


def page():
    today=datetime.now(ZoneInfo('America/New_York')).replace(hour=0,minute=0,second=0,microsecond=0)
    times=[today-timedelta(days=1)+timedelta(hours=8),today+timedelta(hours=8),today+timedelta(hours=17),today+timedelta(hours=20)]
    meta={'symbol':'AAPL','instrumentType':'EQUITY','currency':'USD','regularMarketPrice':100,
          'regularMarketTime':int((today-timedelta(days=1)+timedelta(hours=16)).timestamp()),
          'previousClose':90,'regularMarketVolume':9999,'regularMarketDayHigh':150,'regularMarketDayLow':80}
    result={'meta':meta,'timestamp':[int(at.timestamp()) for at in times],
            'indicators':{'quote':[{'close':[999,110,120,777]}]}}
    return today,result


async def installed(client,authority):
    target=Target('yahoo-extended','yahoo','query1.finance.yahoo.com',443,('8.8.8.8',),approved_access=True)
    authority.policies=(replace(authority.policies[0],id='yahoo-extended',source='yahoo',source_version='yahoo-chart-history-v1',target_id=target.id,target_fingerprint=target.fingerprint,fixture=False),)
    result=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'yahoo-extended'})
    assert result.status_code==200,result.text
    return result.json()['revision'],Transport(authority.db,[target])


async def test_yahoo_pre_after_raw_times_exact_baselines_and_no_overnight_alias(market,monkeypatch):
    client,app,authority,_transport,_=market
    revision,transport=await installed(client,authority)
    today,result=page();authority.clock=lambda:(today+timedelta(hours=23)).astimezone(UTC)
    raw=json.dumps({'chart':{'error':None,'result':[result]}}).encode();calls=[]
    async def fetch(url,approval):
        calls.append(url)
        assert '/v8/finance/chart/AAPL?' in url and 'interval=1m' in url and 'includePrePost=true' in url
        return raw
    monkeypatch.setattr('alcor_api.market_yahoo_history.fetch_page',fetch)
    for session in ('PRE','AFTER'):
        await demand(client,revision,Query('latest','US','AAPL',session=session))
        assert await schedule(authority)==1
        task=await claim(authority.db,uuid4(),kind='market.latest');assert task
        assert await execute(authority,task,transport)=='observed'
    before=await hashes(app)
    for session,price,baseline,hour in [('PRE',110,100,8),('AFTER',120,90,17)]:
        response=await client.post('/api/market/quotes/read',headers={'x-alcor-market-source':revision},json={'items':[{'id':'a','market':'US','code':'AAPL'}],'session':session})
        assert response.status_code==200,response.text
        dto=response.json()['quotes']['a'];state=response.json()['quoteStates']['a']
        assert dto['price']==price and dto['prevClose']==baseline and dto['session']==session
        assert dto['time']==(today+timedelta(hours=hour)).astimezone(UTC).isoformat()
        assert state['priceExact']==str(price) and dto['cached'] is None
        assert dto['priceBasis']=='provider_one_minute_close' and dto['individualSessionTradeTimeKnown'] is False
        assert 'volume' not in dto and 'high' not in dto and 'low' not in dto
    assert await hashes(app)==before and len(calls)==2
    descriptors=await client.get('/api/market/sources')
    assert descriptors.status_code==200,descriptors.text
    # No implicit query2 retry, no 20:00 point relabeled as an overnight trade.
    rejected=await client.post('/api/market/demands',json={'request_id':str(uuid4()),'source_revision':revision,'query':{'kind':'latest','market':'US','code':'AAPL','session':'OVERNIGHT'},'expected_revision':0})
    assert rejected.status_code==503 and len(calls)==2
    async with app.state.db.connection() as conn:
        pages=await(await conn.execute('SELECT raw_bytes,raw_sha256 FROM market_source_pages')).fetchall()
    assert len(pages)==2 and all(bytes(row['raw_bytes'])==raw and row['raw_sha256']==hashlib.sha256(raw).hexdigest() for row in pages)


async def test_yahoo_no_today_pre_point_does_not_invent_regular_price_at_now(market,monkeypatch):
    client,app,authority,_transport,_=market
    revision,transport=await installed(client,authority)
    today,result=page();authority.clock=lambda:(today+timedelta(hours=9)).astimezone(UTC)
    # Only yesterday PRE and today's 20:00 post boundary remain. Neither is a
    # fresh PRE observation. The old synthetic regular-close/now branch is refused.
    result['timestamp']=[result['timestamp'][0],result['timestamp'][3]]
    result['indicators']['quote'][0]['close']=[999,777]
    raw=json.dumps({'chart':{'error':None,'result':[result]}}).encode();calls=[]
    async def fetch(url,approval):calls.append(url);return raw
    monkeypatch.setattr('alcor_api.market_yahoo_history.fetch_page',fetch)
    q=Query('latest','US','AAPL',session='PRE');await demand(client,revision,q)
    assert await schedule(authority)==1
    task=await claim(authority.db,uuid4(),kind='market.latest');assert task
    assert await execute(authority,task,transport)=='source_outcome_unknown'
    response=await client.post('/api/market/quotes/read',headers={'x-alcor-market-source':revision},json={'items':[{'id':'a','market':'US','code':'AAPL'}],'session':'PRE'})
    assert response.status_code==200 and response.json()['quotes']=={},response.text
    async with app.state.db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM market_facts')).fetchone())['n']==0
        saved=await(await conn.execute('SELECT raw_bytes,issues FROM market_source_pages')).fetchone()
    assert bytes(saved['raw_bytes'])==raw and saved['issues']==[{'reason':'source_extended_observation_unavailable'}]
    assert len(calls)==1
