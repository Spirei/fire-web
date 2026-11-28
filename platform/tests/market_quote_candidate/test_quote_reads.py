"""Actual old route oracle and one PG fact authority; no read-induced collection."""

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
from dataclasses import asdict, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
from request_telemetry_tables import REQUEST_TELEMETRY_TABLES
from alcor_api.backups import tables_and_hashes
from alcor_api.market_contract import canonical
from alcor_api.market_worker import claim, execute, schedule
from alcor_api.native_app_auth import issue_grant
from alcor_api.security import digest
from market_latest_candidate.test_market_authority import demand

HERE=Path(__file__).parent
AT=datetime(2026,10,20,14,tzinfo=UTC)


@pytest_asyncio.fixture
async def quoted(market):
    client,app,authority,transport,revision=market
    authority.clock=lambda:AT+timedelta(seconds=1)
    source={'at':AT.isoformat(),'price':'120','currency':'USD','session':'REGULAR','cached':False,'name':'Observed','prevClose':'100','open':'110','high':'130','low':'90','volume':'0','amount':'1000'}
    async def collect(policy,query,cursor):
        transport.calls+=1
        return canonical({'query':asdict(query),'licenseRevision':policy.license_revision,'facts':[source],'nextCursor':None}).encode(),'controlled_http_response_body'
    transport.read=collect
    await demand(client,revision)
    await schedule(authority)
    task=await claim(app.state.db,uuid4())
    assert await execute(authority,task,transport)=='observed'
    async with app.state.db.connection() as conn:
        user=await (await conn.execute("SELECT * FROM users WHERE username='MarketReader'")).fetchone()
        grant=await issue_grant(conn,user,'portfolio.read','Synthetic quote reader')
    headers={'authorization':'Bearer '+grant['access_token']}
    return client,app,authority,transport,revision,headers,source


async def hashes(app):
    async with app.state.db.connection() as conn,conn.transaction():
        result = await tables_and_hashes(conn)
    # The independent request recorder flushes while the original Swift decoder
    # runs. Preserve every business/source/receipt hash, excluding only telemetry.
    telemetry = REQUEST_TELEMETRY_TABLES | {"auth_rate_limits"}
    return {name: row for name, row in result.items() if name not in telemetry}


def body(*items):
    return {'items':list(items or [{'id':'known','market':'US','code':'AAPL'}]),'includeMarketCap':False}


async def old_login(client):
    response=await client.post('/api/auth/login',json={'username':'MarketReader','password':'Synthetic9Pass'})
    assert response.status_code==200,response.text


async def test_three_actual_old_route_envelopes_and_gzip_match_observed_PG_quote(quoted,monkeypatch):
    root=os.environ.get('ALCOR_MARKET_LEGACY_ROOT')
    if not root:pytest.skip('Explicit read-only source required')
    evidence=json.loads((HERE/'source-evidence.json').read_text())
    for name,wanted in evidence['source_sha256'].items():assert hashlib.sha256((Path(root)/name).read_bytes()).hexdigest()==wanted
    # The fixture is a regular-session observation. Freeze the request clock's
    # session so the old envelope oracle is independent of the machine's time.
    monkeypatch.setattr('alcor_api.legacy_quote_api.requested_session',lambda:'REGULAR')
    client,app,_authority,transport,_revision,headers,_source=quoted
    await old_login(client)
    requested=body(*[{'id':str(index),'market':'US','code':'AAPL'} for index in range(15)])
    expected={'name':'Observed','price':120,'time':AT.isoformat(),'source':'controlled_market','session':'REGULAR','displayStale':False,'cached':False,'open':110,'high':130,'low':90,'prevClose':100,'volume':0,'amount':1000,'change':20,'changePct':20}
    # Additive typed cache/source validity metadata is forwarded by the original
    # routes; unknown source flags remain explicit null, never fabricated false.
    expected.update(providerCacheState='source_declared',otc=None,suspended=None,
                    individualSessionTradeTimeKnown=None,indexValid=None,warrantValid=None,optionValid=None)
    expected['dayStatsExact']={'open':'110','high':'130','low':'90','prevClose':'100','volume':'0','amount':'1000'}
    expected.update(expectedSession='REGULAR',extendedUnavailable=False)
    expected['detailMetrics']={'currency':'USD','time':AT.isoformat(),'source':'controlled_market',
                               'turnoverRate':None,'peTtm':None,'pe':None,'marketCap':None,'dividendYieldTtm':None}
    raw=await asyncio.to_thread(subprocess.check_output,['node',str(HERE/'run_quote_golden.cjs'),root],input=json.dumps({'body':requested,'quotesBySymbol':{'US:AAPL':expected},'acceptEncoding':'gzip;q=1'}),text=True)
    old=json.loads(raw)
    assert old['oldTrackedCalls']==3 and old['oldEnrichmentCalls']==0
    for index,path in enumerate(['/api/quotes','/api/v1/quotes','/api/v2/quotes']):
        before=await hashes(app)
        supplied={'accept-encoding':'gzip;q=1'} if index==0 else {**headers,'accept-encoding':'gzip;q=1'}
        response=await client.post(path,json=requested,headers=supplied)
        assert response.status_code==old['routes'][index]['status']==200,response.text
        actual=response.json()
        old_body=old['routes'][index]['body']
        actual_quotes=actual.get('quotes',actual.get('data',{}).get('quotes',{}))
        old_quotes=old_body.get('quotes',old_body.get('data',{}).get('quotes',{}))
        diff={key:(actual_quotes['0'].get(key,'<missing>'),old_quotes['0'].get(key,'<missing>'))
              for key in actual_quotes['0'].keys() | old_quotes['0'].keys()
              if actual_quotes['0'].get(key,'<missing>')!=old_quotes['0'].get(key,'<missing>')}
        assert actual==old_body, diff
        assert response.headers.get('content-encoding')==old['routes'][index]['encoding']
        if index:
            # These App grants deliberately authorize reads only.
            assert await hashes(app)==before
        else:
            assert response.headers['x-alcor-quote-tracked']=='true'
            receipt=await client.get(response.headers['x-alcor-operation-receipt'])
            assert receipt.status_code==200 and receipt.json()['observation'] is True
    assert transport.calls==1


async def test_request_is_not_collection_and_missing_security_has_no_placeholder(market):
    client,app,_authority,transport,_revision=market
    await old_login(client)
    before=await hashes(app)
    response=await client.post('/api/market/quotes/read',json=body())
    assert response.status_code==200 and response.json()['quotes']=={}
    assert await hashes(app)==before and transport.calls==0


async def test_stale_and_future_source_times_are_not_replaced_by_request_time(quoted):
    client,app,authority,transport,_revision,headers,_source=quoted
    authority.clock=lambda:AT+timedelta(seconds=120)
    before=await hashes(app)
    response=await client.post('/api/market/quotes/read',json=body(),headers=headers)
    value=response.json()['quotes']['known']
    assert value['time']==AT.isoformat() and value['price']==120 and value['displayStale'] is True
    assert value['cached'] is False  # Provider cache flag is not the PG-read mechanism.
    authority.clock=lambda:AT-timedelta(seconds=6)
    future=await client.post('/api/v2/quotes',json=body(),headers=headers)
    assert future.status_code==200 and future.json()['data']['quotes']=={}
    assert await hashes(app)==before and transport.calls==1


async def test_different_owner_and_anonymous_cannot_borrow_licensed_facts(quoted):
    _client,app,_authority,transport,revision,_headers,_source=quoted
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as other:
        for path in ['/api/quotes','/api/v1/quotes','/api/v2/quotes']:
            assert (await other.post(path,json=body())).status_code == (401 if path == '/api/v2/quotes' else 503)
            assert (await other.post(path,json={'items':[]})).status_code == (401 if path == '/api/v2/quotes' else 200)
        created=await other.post('/api/session/register',json={'username':'OtherQuoteOwner','password':'Synthetic9Pass'})
        assert created.status_code==201
        async with app.state.db.connection() as conn:
            user=await (await conn.execute('SELECT * FROM users WHERE id=%s',(created.json()['user']['id'],))).fetchone()
            pair=await issue_grant(conn,user,'portfolio.read','Synthetic other owner')
        headers={'authorization':'Bearer '+pair['access_token']}
        response=await other.post('/api/v2/quotes',json=body(),headers=headers)
        assert response.json()['data']['quotes']=={}
        denied=await other.post('/api/v2/quotes',json=body(),headers={**headers,'x-alcor-market-source':revision})
        assert denied.status_code==403 and denied.headers['x-alcor-retire-context']=='true'
    assert transport.calls==1


async def test_permission_changes_no_fallback_to_other_sources_or_old_quotes(quoted):
    client,app,authority,transport,_revision,headers,_source=quoted
    original=authority.policies
    authority.policies=(replace(original[0],license_revision='changed-license'),)
    response=await client.post('/api/v2/quotes',json=body(),headers=headers)
    assert response.status_code==403 and response.headers['x-alcor-retire-context']=='true'
    authority.policies=original
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE identity_app_grants SET scope='security.read' WHERE id=(SELECT grant_id FROM identity_app_access_tokens WHERE token_hash=%s)",(digest(headers['authorization'][7:]),))
    assert (await client.post('/api/v2/quotes',json=body(),headers=headers)).status_code==403
    assert transport.calls==1


async def test_multiple_licensed_sources_require_selection_not_timestamp_guess(quoted):
    client,app,authority,transport,revision,headers,_source=quoted
    original=authority.policies[0]
    authority.policies+=(replace(original,id='other-source',license_revision='other-license'),)
    configured=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'other-source'})
    assert configured.status_code==200,configured.text
    second=configured.json()['revision']
    await demand(client,second)
    await schedule(authority)
    task=await claim(app.state.db,uuid4())
    assert await execute(authority,task,transport)=='observed'
    response=await client.post('/api/market/quotes/read',json=body(),headers=headers)
    assert response.json()['quotes']=={} and response.json()['quoteStates']['known']['state']=='ambiguous_source'
    selected=await client.post('/api/v2/quotes',json=body(),headers={**headers,'x-alcor-market-source':revision})
    assert selected.status_code==200 and selected.json()['data']['quotes']['known']['price']==120


async def test_reconfirmed_same_policy_after_identity_change_uses_only_new_facts(quoted):
    client,app,authority,transport,old_revision,_headers,_source=quoted
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE users SET session_version=session_version+1 WHERE username='MarketReader'")
    login=await client.post('/api/session/login',json={'login':'MarketReader','password':'Synthetic9Pass'})
    assert login.status_code==200,login.text
    client.headers['x-csrf-token']=login.json()['csrf']
    configured=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'fixture'})
    assert configured.status_code==200,configured.text
    revision=configured.json()['revision']
    await demand(client,revision)
    await old_login(client)
    pending=await client.post('/api/quotes',json=body())
    assert pending.status_code==200,pending.text
    assert pending.json()['quotes']=={},'old-session facts cannot fill the new authorization'
    _source['price']='125'
    _source['price']='125'
    await schedule(authority)
    task=await claim(app.state.db,uuid4())
    assert task is not None
    assert await execute(authority,task,transport)=='observed'
    observed=await client.post('/api/quotes',json=body())
    assert observed.status_code==200,observed.text
    assert observed.json()['quotes']['known']['price']==125
    explicit_old=await client.post('/api/quotes',json=body(),headers={'x-alcor-market-source':old_revision})
    assert explicit_old.status_code==403


async def test_reconfirmed_alternative_without_new_stream_does_not_block_current_quote(quoted):
    client,app,authority,transport,_revision,headers,_source=quoted
    original=authority.policies[0]
    alternative=replace(original,id='alternative',source='controlled_alternative',license_revision='alternative-v1')
    authority.policies+=(alternative,)
    configured=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'alternative'})
    old_revision=configured.json()['revision']
    await demand(client,old_revision)
    await schedule(authority)
    task=await claim(app.state.db,uuid4());assert task
    assert await execute(authority,task,transport)=='observed'
    authority.policies=(original,replace(alternative,license_revision='alternative-v2'))
    renewed=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'alternative'})
    assert renewed.status_code==200,renewed.text
    app.state.db.settings._legacy_quote_source='auto'
    app.state.db.settings._legacy_quote_order=['controlled_market','controlled_alternative']
    response=await client.post('/api/v2/quotes',json=body(),headers=headers)
    assert response.status_code==200,response.text
    assert response.json()['data']['quotes']['known']['price']==120
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM market_streams WHERE source_revision=%s',(renewed.json()['revision'],))).fetchone())['n']==0
    explicit_old=await client.post('/api/v2/quotes',json=body(),headers={**headers,'x-alcor-market-source':old_revision})
    assert explicit_old.status_code==403
    # The retired alternative is never used, but it must not retire the App's
    # entire market context while an independently authorized quote is valid.
    authority.policies=(original,replace(alternative,license_revision='alternative-v3'))
    available=await client.post('/api/v2/quotes',json=body(),headers=headers)
    assert available.status_code==200,available.text
    assert available.json()['data']['quotes']['known']['source']==original.source
    assert (await client.post('/api/v2/quotes',json=body(),headers={**headers,'x-alcor-market-source':old_revision})).status_code==403
    # Without any current authorization, old material still cannot be displayed.
    authority.policies=(replace(original,license_revision='current-also-unconfirmed'),replace(alternative,license_revision='alternative-v3'))
    assert (await client.post('/api/v2/quotes',json=body(),headers=headers)).status_code==403


async def test_latest_failure_cools_provider_after_rescheduling_and_new_success_recovers(quoted):
    from types import SimpleNamespace
    from alcor_api.market_subscription_writes import Subscriptions
    client,app,authority,transport,revision,_headers,_source=quoted
    original=authority.policies[0]
    authority.clock=lambda:datetime.now(UTC)
    authority.policies+=(replace(original,id='backup',source='controlled_backup',license_revision='backup-v1'),)
    backup=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'backup'})
    assert backup.status_code==200,backup.text
    app.state.db.settings._legacy_quote_order=['controlled_market','controlled_backup']
    collect=transport.read
    async def refused(*_):raise ValueError('synthetic_source_refused')
    transport.read=refused
    async with app.state.db.connection() as conn:
        await conn.execute('UPDATE market_streams SET next_due=clock_timestamp() WHERE source_revision=%s',(revision,))
    task=await claim(app.state.db,uuid4());assert task
    assert await execute(authority,task,transport)=='source_outcome_unknown'
    await demand(client,revision,expected=1)
    async with app.state.db.connection() as conn:
        await conn.execute('UPDATE market_streams SET next_due=clock_timestamp() WHERE source_revision=%s',(revision,))
    assert await schedule(authority)==1
    # The source's current task is queued now, but its real recent failure remains.
    async with app.state.db.connection() as conn:
        owner=(await(await conn.execute("SELECT id FROM users WHERE username='MarketReader'")).fetchone())['id']
        selected=await Subscriptions(authority).source(conn,SimpleNamespace(id=owner),[{'market':'US','code':'AAPL'}],None,'auto')
        assert str(selected)==backup.json()['revision']
    transport.read=collect
    task=await claim(app.state.db,uuid4());assert task
    assert await execute(authority,task,transport)=='observed'
    async with app.state.db.connection() as conn:
        selected=await Subscriptions(authority).source(conn,SimpleNamespace(id=owner),[{'market':'US','code':'AAPL'}],None,'auto')
        assert str(selected)==revision


async def test_quote_and_index_observation_do_not_roll_back_for_unrelated_retired_equity(quoted):
    client,app,authority,transport,_revision,_headers,_source=quoted
    original=authority.policies[0]
    backup=replace(original,id='current-backup',source='controlled_backup',license_revision='backup-current')
    authority.policies+=(backup,)
    configured=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':backup.id})
    assert configured.status_code==200,configured.text
    authority.policies=(replace(original,license_revision='not-reconfirmed'),backup)
    app.state.db.settings._legacy_quote_source='auto'
    app.state.db.settings._legacy_quote_order=['controlled_backup']
    app.state.db.settings.public_ticker={'items':[{'key':'dji','market':'US','secid':'100.DJIA'}]}
    await old_login(client)
    calls=transport.calls
    response=await client.post('/api/quotes',json=body({'id':'new','market':'US','code':'MSFT'}))
    assert response.status_code==200,response.text
    assert response.headers['x-alcor-quote-tracked']=='true'
    assert response.json()['quotes']=={}
    receipt=await client.get(response.headers['x-alcor-operation-receipt'])
    assert receipt.status_code==200 and receipt.json()['affectedStreams']==1
    index=await client.post('/api/fire/ticker/demand',json={'requestId':str(uuid4())})
    assert index.status_code==200,index.text
    assert index.json()['affectedStreams']==1 and index.json()['observation'] is True
    assert transport.calls==calls,'intent must not synchronously collect or borrow another security'
    rejected=await client.post('/api/quotes',json=body())
    assert rejected.status_code==403,'unconfirmed original source still cannot supply the old AAPL quote'


async def test_portfolio_asset_snapshot_and_detail_follow_the_same_configured_quote(quoted):
    from test_trading import setup as trading_setup
    client,app,authority,transport,revision,headers,source=quoted
    alternative=replace(authority.policies[0],id='alternate-price',source='controlled_alternate')
    authority.policies+=(alternative,)
    configured=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':alternative.id})
    assert configured.status_code==200,configured.text
    async def collect(policy,query,cursor):
        transport.calls+=1
        fact={**source,'price':'140' if policy.id==alternative.id else '120'}
        return canonical({'query':asdict(query),'licenseRevision':policy.license_revision,'facts':[fact],'nextCursor':None}).encode(),'controlled_http_response_body'
    transport.read=collect
    await demand(client,configured.json()['revision']);await schedule(authority)
    task=await claim(app.state.db,uuid4());assert task
    assert await execute(authority,task,transport)=='observed'
    _account,record=await trading_setup(client,name='Synthetic shared quote account',qty='2',cost='100')
    app.state.db.settings._legacy_quote_source='auto'
    app.state.db.settings._legacy_quote_order=['controlled_market','controlled_alternate']
    # Canonical source-specific reads must still report ambiguity. Business
    # projections follow the owner's configured order without extra collection.
    ambiguous=await client.post('/api/market/quotes/read',json=body(),headers=headers)
    assert ambiguous.json()['quoteStates']['known']['state']=='ambiguous_source'
    calls=transport.calls
    before=await hashes(app)
    async def projections(price):
        quoted=await client.post('/api/v2/quotes',json=body(),headers=headers)
        assert quoted.status_code==200,quoted.text
        assert quoted.json()['data']['quotes']['known']['price']==price
        overview=await client.get('/api/v2/overview',headers=headers)
        assert overview.status_code==200,overview.text
        assert overview.json()['data']['totalMarket']==price*2
        assert overview.json()['data']['totalPnl']==(price-100)*2
        snapshot=await client.get('/api/v2/account-assets?usPrice=regular',headers=headers)
        assert snapshot.status_code==200,snapshot.text
        value=snapshot.json()['data']['positions'][0]
        assert value['recordId']==record['id'] and value['price']==price
        assert value['nativeMarketValue']==price*2 and value['nativeHoldingPnl']==(price-100)*2
        detail=await client.get('/api/v2/stock-detail?market=US&code=AAPL&includeKline=0',headers=headers)
        assert detail.status_code==200,detail.text
        assert detail.json()['data']['quote']['price']==price
    await projections(120)
    app.state.db.settings._legacy_quote_order.reverse()
    await projections(140)
    explicit=await client.get('/api/v2/stock-detail?market=US&code=AAPL&includeKline=0',headers={**headers,'x-alcor-market-source':revision})
    assert explicit.status_code==200 and explicit.json()['data']['quote']['price']==120
    assert transport.calls==calls and await hashes(app)==before


async def test_ambiguous_request_ids_and_missing_securities_do_not_borrow_other_quotes(quoted):
    client,_app,_authority,transport,_revision,headers,_source=quoted
    requested=body({'id':'same','market':'US','code':'AAPL'},{'id':'same','market':'US','code':'MSFT'},{'id':'missing','market':'US','code':'MSFT'})
    response=await client.post('/api/market/quotes/read',json=requested,headers=headers)
    assert response.json()['quotes']=={}
    assert response.json()['quoteStates']['same']['state']=='ambiguous_request_id'
    assert response.json()['quoteStates']['missing']['state']=='missing'
    assert transport.calls==1


@pytest.fixture(scope='session')
def ios_decoder(tmp_path_factory):
    root=os.environ.get('ALCOR_MARKET_IOS_ROOT')
    if not root or not shutil.which('swiftc'):pytest.skip('Explicit old iOS source and Swift compiler required')
    source=Path(root)/'StockLog/Models/Models.swift'
    evidence=json.loads((HERE/'source-evidence.json').read_text())
    assert hashlib.sha256(source.read_bytes()).hexdigest()==evidence['ios_sha256']['StockLog/Models/Models.swift']
    text=source.read_text();start=text.index('struct QuoteDetailMetrics:');end=text.index('/// 分时走势：',start)
    directory=tmp_path_factory.mktemp('quote-swift-golden');model=directory/'Original.swift';model.write_text('import Foundation\n'+text[start:end])
    harness=directory/'Main.swift';harness.write_text('''import Foundation
@main struct Main {
static func main() throws {
 let data=FileHandle.standardInput.readDataToEndOfFile()
 let batch=try JSONDecoder().decode(QuoteBatch.self,from:data)
 let value=batch.quotes["known"]!
 let result:[String:Any]=["price":value.price,"openUnknown":value.open.isNaN,"highUnknown":value.high.isNaN,"lowUnknown":value.low.isNaN,"volumeUnknown":value.volume == nil,"changeUnknown":value.change.isNaN,"session":value.session ?? "","stale":value.displayStale == true]
 FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject:result))
}
}
''')
    binary=directory/'decode';subprocess.run(['swiftc','-module-cache-path',str(directory/'module-cache'),str(model),str(harness),'-o',str(binary)],check=True,capture_output=True,text=True)
    return binary


async def test_price_only_Futu_record_stays_unknown_for_OHLC_volume_and_actual_iOS_decoder(market,ios_decoder):
    client,app,authority,transport,_revision=market
    authority.clock=lambda:AT+timedelta(seconds=1)
    authority.policies=(replace(authority.policies[0],id='futu-record-fixture',source='futu',source_version='futu-sdk-records-v1'),)
    response=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'futu-record-fixture'})
    assert response.status_code==200,response.text
    revision=response.json()['revision'];await demand(client,revision)
    async def collect(_policy,_query,_cursor):
        transport.calls+=1
        return canonical({'records':[{'code':'US.AAPL','name':'Price only','last_price':'120','update_time':'2026-10-20 10:00:00','volume':'-1','high_price':'nan','low_price':'0'}]}).encode(),'controlled_SDK_records_representation'
    transport.read=collect;await schedule(authority);task=await claim(app.state.db,uuid4())
    assert await execute(authority,task,transport)=='observed'
    async with app.state.db.connection() as conn:
        user=await (await conn.execute("SELECT * FROM users WHERE username='MarketReader'")).fetchone()
        pair=await issue_grant(conn,user,'portfolio.read','Synthetic decoder')
    headers={'authorization':'Bearer '+pair['access_token']}
    before=await hashes(app)
    quoted=await client.post('/api/v2/quotes',json=body(),headers=headers)
    assert quoted.status_code==200,quoted.text
    value=quoted.json()['data']['quotes']['known']
    assert value['time']==AT.isoformat() and value['session']=='UNKNOWN' and value['displayStale'] is True
    assert all(field not in value for field in ['open','high','low','volume','amount','prevClose','change','changePct'])
    parsed=json.loads(await asyncio.to_thread(subprocess.check_output,[str(ios_decoder)],input=json.dumps(quoted.json()['data']),text=True))
    assert parsed=={'price':120,'openUnknown':True,'highUnknown':True,'lowUnknown':True,'volumeUnknown':True,'changeUnknown':True,'session':'UNKNOWN','stale':True}
    assert await hashes(app)==before and transport.calls==1


async def test_auto_source_priority_precedes_ambiguity_and_preserves_explicit_reads(quoted, monkeypatch):
    from alcor_api import market_quote_reads
    from alcor_api.market_contract import Query
    client,app,authority,transport,_revision,headers,_source=quoted
    original=authority.policies[0]
    authority.policies+=(replace(original,id='hk-backup',markets=('HK',)),
                         replace(original,id='hk-tencent',source='tencent',source_version='tencent-quotes-v1',markets=('HK',),timestamp_zones=(('HK','Asia/Hong_Kong'),)))
    async def collect(policy,query,cursor):
        transport.calls+=1
        if policy.source == 'tencent':
            fields=['']*68
            for index,value in {1:'Synthetic HK',3:'160',4:'150',5:'151',30:'20261020220000',31:'10',32:'6.6667',33:'162',34:'149'}.items():fields[index]=value
            return ('v_hk00700="'+'~'.join(fields)+'";').encode('gbk'),'http_response_body_gbk'
        return canonical({'query':asdict(query),'licenseRevision':policy.license_revision,
            'facts':[{**_source,'currency':'HKD','price':'140'}],'nextCursor':None}).encode(),'controlled_http_response_body'
    transport.read=collect
    revisions = {}
    for name in ('hk-backup','hk-tencent'):
        response=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':name})
        assert response.status_code==200,response.text
        revisions[name] = response.json()['revision']
        await demand(client,revisions[name],Query('latest','HK','00700'))
    await schedule(authority)
    for _ in range(2):
        task=await claim(app.state.db,uuid4());assert task is not None
        assert await execute(authority,task,transport)=='observed'
    await old_login(client)
    app.state.db.settings._legacy_quote_source='auto'
    response=await client.post('/api/quotes',json=body({'id':'42','market':'HK','code':'00700'}))
    assert response.status_code==200,response.text
    assert response.json()['quotes']['42']['price']==160
    explicit=await client.post('/api/market/quotes/read',json=body({'id':'42','market':'HK','code':'00700'}),headers=headers)
    assert explicit.json()['quoteStates']['42']['state']=='ambiguous_source','no preference must retain the ambiguity guard'

    app.state.db.settings._legacy_quote_order = ['tencent', original.source]
    monkeypatch.setattr('alcor_api.legacy_quote_api.requested_session', lambda: 'REGULAR')
    items = body({'id': 'hk', 'market': 'HK', 'code': '00700'},
                 {'id': 'us', 'market': 'US', 'code': 'AAPL'})
    async def recent_failures(*_args):
        return {('HK', '00700', UUID(revisions['hk-tencent']))}

    with monkeypatch.context() as scoped:
        scoped.setattr('alcor_api.market_source_failures.recent_failed_sources_by_pair', recent_failures)
        response = await client.post('/api/v2/quotes', json=items, headers=headers)
        assert response.status_code == 200, response.text
        quotes = response.json()['data']['quotes']
        assert (quotes['hk']['price'], quotes['us']['price']) == (140, 120)

    verified = market_quote_reads.with_snapshot_metrics

    async def verify(conn, who, query, policy, fact, pages):
        if policy.id == 'hk-tencent':
            raise market_quote_reads.SnapshotMetricMismatch()
        return await verified(conn, who, query, policy, fact, pages)

    monkeypatch.setattr(market_quote_reads, 'with_snapshot_metrics', verify)
    response = await client.post('/api/v2/quotes', json=items, headers=headers)
    assert response.status_code == 200, response.text
    quotes = response.json()['data']['quotes']
    assert (quotes['hk']['price'], quotes['us']['price']) == (140, 120)


async def test_private_ticker_binds_security_kind_owner_and_does_not_collect(quoted):
    from alcor_api.market_contract import Query
    client,app,authority,transport,revision,_headers,_source=quoted
    await demand(client,revision,Query('latest','US','DJI',instrument='index'))
    await schedule(authority)
    task=await claim(app.state.db,uuid4());assert await execute(authority,task,transport)=='observed'
    app.state.db.settings.public_ticker={'legacyPresentation':{'items':[
        {'key':'dji','market':'US','label':'Synthetic index','secid':'100.DJIA'},
        {'key':'equity','market':'US','label':'Must not borrow equity','secid':'200.AAPL'}],'interval':5}}
    await old_login(client)
    before=await hashes(app);calls=transport.calls
    response=await client.get('/api/fire/ticker');assert response.status_code==200,response.text
    items=response.json()['items'];assert items[0]['price']==120 and items[0]['secid']=='100.DJIA'
    assert items[1]['price'] is None and response.json()['collectionOnRead'] is False
    assert await hashes(app)==before and transport.calls==calls
    app.state.db.settings.public_ticker = {}
    fallback = await client.get('/api/fire/ticker')
    assert fallback.status_code == 200, fallback.text
    assert next(item for item in fallback.json()['items'] if item['secid'] == '100.DJIA')['price'] == 120
    assert transport.calls == calls
    client.cookies.clear()
    assert (await client.get('/api/fire/ticker')).status_code==401


async def test_native_account_hint_is_only_a_guard_never_an_identity(quoted):
    client,app,_authority,transport,_revision,headers,_source=quoted
    async with app.state.db.connection() as conn:
        owner=(await (await conn.execute("SELECT id FROM users WHERE username='MarketReader'")).fetchone())['id']
    same=await client.post('/api/v2/quotes',json=body(),headers={**headers,'x-alcor-expected-account':owner})
    assert same.status_code==200 and same.json()['data']['quotes']['known']['price']==120
    other=await client.post('/api/v2/quotes',json=body(),headers={**headers,'x-alcor-expected-account':'another-owner'})
    assert other.status_code==403 and other.headers['x-alcor-retire-context']=='true'
    assert transport.calls==1


async def test_auto_read_stays_on_fresh_backup_past_60s_until_primary_actually_recovers(quoted, monkeypatch):
    from datetime import timedelta
    from types import SimpleNamespace
    from alcor_api.market_contract import Query
    from alcor_api.market_subscription_writes import Subscriptions

    client, app, authority, transport, revision, headers, source = quoted
    original = authority.policies[0]
    backup_policy = replace(original, id='backup-live', source='controlled_backup', license_revision='backup-live-v1')
    authority.policies += (backup_policy,)
    configured = await client.post('/api/market/sources', json={'request_id': str(uuid4()), 'policy_id': backup_policy.id})
    assert configured.status_code == 200, configured.text
    backup_revision = configured.json()['revision']
    app.state.db.settings._legacy_quote_source = 'auto'
    app.state.db.settings._legacy_quote_order = [original.source, backup_policy.source]
    monkeypatch.setattr('alcor_api.legacy_quote_api.requested_session', lambda: 'REGULAR')

    now = datetime.now(UTC)
    authority.clock = lambda: now
    # Primary (futu-like) already has an older observation (120 from fixture), then fails 5 minutes ago (>60s).
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE market_streams SET next_due=clock_timestamp() WHERE source_revision=%s", (revision,))

    async def broken(*_):
        raise ValueError('synthetic_primary_outage')

    transport.read = broken
    failed_task = await claim(app.state.db, uuid4())
    assert failed_task and await execute(authority, failed_task, transport) == 'source_outcome_unknown'
    # Age the failure beyond 60 seconds (5 minutes ago): reads must NOT revert to stale primary.
    async with app.state.db.connection() as conn:
        await conn.execute(
            "UPDATE tasks SET finished_at=clock_timestamp()-interval '5 minutes' WHERE id=%s",
            (failed_task['id'],),
        )

    # Backup records a fresh live quote (135 at t-5s).
    async def backup_read(policy, query, _cursor):
        price = '135' if policy.id == backup_policy.id else '142'
        at = (now - timedelta(seconds=5 if policy.id == backup_policy.id else 2)).isoformat()
        fact = {**source, 'price': price, 'at': at, 'source': policy.source, 'sourceVersion': policy.source_version}
        return canonical({'query': asdict(query), 'licenseRevision': policy.license_revision, 'facts': [fact], 'nextCursor': None}).encode(), 'controlled_http_response_body'

    transport.read = backup_read
    await demand(client, backup_revision, Query('latest', 'US', 'AAPL'))
    assert await schedule(authority) == 1
    backup_task = await claim(app.state.db, uuid4(), kind='market.latest')
    assert backup_task and await execute(authority, backup_task, transport) == 'observed'

    # 1. Past 60s while primary is still failed -> must serve fresh backup (135), NOT stale primary (120).
    res1 = await client.post('/api/v2/quotes', json=body(), headers=headers)
    assert res1.status_code == 200, res1.text
    assert res1.json()['data']['quotes']['known']['price'] == 135
    assert res1.json()['data']['quotes']['known']['source'] == backup_policy.source

    # 2. Even after primary is re-scheduled (probing, status='queued') -> must stay on fresh backup (135).
    await demand(client, revision, expected=1)
    assert await schedule(authority) == 1
    res2 = await client.post('/api/v2/quotes', json=body(), headers=headers)
    assert res2.status_code == 200, res2.text
    assert res2.json()['data']['quotes']['known']['price'] == 135
    assert res2.json()['data']['quotes']['known']['source'] == backup_policy.source

    # 3. Once primary actually recovers with a fresh observation (142) -> immediately switch back to primary.
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE market_streams SET next_due=clock_timestamp() WHERE source_revision=%s", (revision,))
    probe_task = await claim(app.state.db, uuid4(), kind='market.latest')
    assert probe_task and await execute(authority, probe_task, transport) == 'observed'
    res3 = await client.post('/api/v2/quotes', json=body(), headers=headers)
    assert res3.status_code == 200, res3.text
    assert res3.json()['data']['quotes']['known']['price'] == 142
    assert res3.json()['data']['quotes']['known']['source'] == original.source

    # 4. retry_budget_exhausted must also trigger write-side 60s cooldown to backup.
    async with app.state.db.connection() as conn:
        owner = (await (await conn.execute("SELECT id FROM users WHERE username='MarketReader'")).fetchone())['id']
        await conn.execute(
            "UPDATE tasks SET status='failed', error_code='retry_budget_exhausted', finished_at=clock_timestamp() WHERE id=%s",
            (probe_task['id'],),
        )
        await conn.execute("UPDATE market_data_jobs SET state='running', last_source_error=NULL WHERE task_id=%s", (probe_task['id'],))
        selected = await Subscriptions(authority).source(conn, SimpleNamespace(id=owner), [{'market': 'US', 'code': 'AAPL'}], None, 'auto')
        assert str(selected) == backup_revision


async def test_fastest_visible_quotes_register_independent_approved_sources(market, monkeypatch):
    from alcor_api.market_tencent_latest import VERSION as tencent_version

    client, app, authority, _transport, _revision = market
    original = authority.policies[0]
    variants = [
        replace(original, id="fixture-eastmoney", source="eastmoney"),
        replace(original, id="fixture-tencent", source="tencent", source_version=tencent_version),
    ]
    authority.policies += tuple(variants)
    revisions = set()
    for policy in variants:
        registered = await client.post("/api/market/sources", json={"request_id": str(uuid4()), "policy_id": policy.id})
        assert registered.status_code == 200, registered.text
        revisions.add(registered.json()["revision"])
    async with app.state.db.connection() as conn:
        owner = await (await conn.execute("SELECT * FROM users WHERE username='MarketReader'")).fetchone()
        grant = await issue_grant(conn, owner, "portfolio.read portfolio.write", "Fastest quote fixture")
    monkeypatch.setattr("alcor_api.legacy_quote_api.requested_session", lambda: "REGULAR")
    query = {**body(), "preferFastSources": True}
    response = await client.post("/api/v2/quotes", json=query,
                                 headers={"authorization": "Bearer " + grant["access_token"], "x-alcor-register-demand": "true"})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["tracking"]["tracked"] is True
    async with app.state.db.connection() as conn:
        streams = await (await conn.execute("SELECT source_revision,query FROM market_streams")).fetchall()
        assert {str(row["source_revision"]) for row in streams} == revisions
        assert {row["query"]["session"] for row in streams} == {"REGULAR"}
    assert response.json()["data"]["quotes"] == {}
    authority.clock = lambda: AT + timedelta(seconds=1)

    async def collect_first(policy, requested, cursor):
        return canonical({
            "query": asdict(requested), "licenseRevision": policy.license_revision,
            "facts": [{"at": AT.isoformat(), "price": "124.25", "currency": "USD",
                       "session": "REGULAR", "cached": False, "name": "First provider"}],
            "nextCursor": None,
        }).encode(), "controlled_http_response_body"

    _transport.read = collect_first
    await schedule(authority)
    pending = [await claim(app.state.db, uuid4()) for _ in variants]
    assert all(pending)
    async with app.state.db.connection() as conn:
        receipt = await (await conn.execute(
            """SELECT s.id FROM market_streams s JOIN market_source_configs c
               ON c.owner_id=s.owner_id AND c.revision=s.source_revision WHERE c.policy_id='fixture-eastmoney'"""
        )).fetchone()
    first = next(task for task in pending if task["payload"]["streamId"] == str(receipt["id"]))
    assert await execute(authority, first, _transport) == "observed"
    arrived = await client.post("/api/v2/quotes", json=query, headers={"authorization": "Bearer " + grant["access_token"]})
    assert arrived.status_code == 200, arrived.text
    assert arrived.json()["data"]["quotes"]["known"]["source"] == "eastmoney"
    assert arrived.json()["data"]["quotes"]["known"]["price"] == 124.25

    header = {"authorization": "Bearer " + grant["access_token"]}
    orders = [
        ["tencent", "eastmoney", "futu", "yahoo"],
        ["eastmoney", "tencent", "futu", "yahoo"],
    ]
    # The only observation remains available while the preferred source is pending.
    manual = await client.post("/api/v2/quotes", json={**body(), "marketSourceOrder": orders[0]}, headers=header)
    assert manual.status_code == 200, manual.text
    assert manual.json()["data"]["marketSourceOrder"] == orders[0]
    assert manual.json()["data"]["quotes"]["known"]["source"] == "eastmoney"

    async def collect_tencent(policy, requested, cursor):
        from f31_settings_candidate.test_tencent_protocol import original

        return original(AT.isoformat()), "http_response_body_gbk"

    _transport.read = collect_tencent
    other = next(task for task in pending if task["id"] != first["id"])
    assert await execute(authority, other, _transport) == "observed"
    for order in orders:
        manual = await client.post("/api/v2/quotes", json={**body(), "marketSourceOrder": order}, headers=header)
        assert manual.status_code == 200, manual.text
        payload = manual.json()["data"]
        assert payload["marketSourceOrder"] == order
        assert payload["quotes"]["known"]["source"] == order[0]
    invalid = await client.post("/api/v2/quotes", json={**body(), "marketSourceOrder": ["tencent"] * 4}, headers=header)
    assert invalid.status_code == 400
