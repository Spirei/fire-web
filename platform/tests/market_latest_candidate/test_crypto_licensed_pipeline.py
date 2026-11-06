"""Real fixed-provider parser/transport path and PG provenance, with no network."""
import hashlib
import json
from dataclasses import replace
from datetime import UTC,datetime
from uuid import uuid4

import httpx
import pytest
from alcor_api.backups import tables_and_hashes
from alcor_api.cli import create_user
from alcor_api.dividend_sources import Target
from alcor_api.market_authority import Policy
from alcor_api.market_contract import Query
from alcor_api.market_transport import Transport
from alcor_api.market_worker import claim,execute,schedule

from .test_market_authority import market,market_settings,demand,read  # noqa: F401


async def install(market):
    client,app,authority,_,_=market
    async with app.state.db.connection() as conn:
        owner=(await(await conn.execute('SELECT id FROM users')).fetchone())['id']
    target=Target('synthetic-crypto','coingecko','api.coingecko.com',443,('8.8.8.8',),approved_access=True)
    policy=Policy('synthetic-crypto','coingecko','coingecko-latest-v1',target.id,target.fingerprint,owner,'synthetic-license-1',('latest',),('ASSET',))
    authority.policies=(policy,)
    configured=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':policy.id})
    assert configured.status_code==200,configured.text
    return configured.json()['revision'],Query('latest','ASSET','BTC',instrument='asset'),Transport(authority.db,[target]),policy,owner


def original():
    # Numeric JSON token intentionally exceeds IEEE-754 precision.
    return ('[{"id":"bitcoin","symbol":"btc","name":"Bitcoin","current_price":0.00000001234567890123,"last_updated":'+json.dumps(datetime.now(UTC).isoformat())+',"total_volume":123456789.123456789,"price_change_24h":null}]').encode()


async def business_hash(db):
    async with db.connection() as conn,conn.transaction():
        values=await tables_and_hashes(conn)
    return {key:value for key,value in values.items() if key.startswith('market_') or key in ('tasks','task_events','audit_events','portfolio_records','broker_accounts')}


async def test_crypto_real_protocol_decimal_original_owner_and_revoked_read_are_pure(market,monkeypatch):  # noqa: F811
    client,app,authority,_,_=market
    revision,q,transport,policy,owner=await install(market)
    raw=original();calls=[]
    async def fetch(url,approval):
        calls.append(url)
        assert url.startswith('https://api.coingecko.com/api/v3/coins/markets?') and 'ids=bitcoin' in url
        return raw
    monkeypatch.setattr('alcor_api.market_crypto_latest.fetch_page',fetch)
    await demand(client,revision,q)
    assert await schedule(authority)==1
    task=await claim(authority.db,uuid4(),kind='market.latest');assert task
    assert await execute(authority,task,transport)=='observed'
    before=await business_hash(app.state.db)
    observed=await read(client,revision,q)
    assert observed.status_code==200,observed.text
    fact=observed.json()['facts'][0]
    assert fact['price']=='1.234567890123E-8' and fact['cached'] is None and fact['session']=='UNKNOWN'
    batch=await client.post('/api/market/quotes/read',headers={'x-alcor-market-source':revision},json={'items':[{'id':'btc','market':'ASSET','code':'BTC'}]})
    assert batch.status_code==200,batch.text
    value=batch.json();assert value['quoteStates']['btc']['priceExact']=='1.234567890123E-8'
    assert value['quotes']['btc']['cached'] is None and value['quotes']['btc']['amountRolling24hCurrency']=='USD'
    assert 'volume' not in value['quotes']['btc']
    assert await business_hash(app.state.db)==before and len(calls)==1
    await create_user(app.state.db.settings,'CryptoPeer','Synthetic9Pass',role='user')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as peer:
        login=await peer.post('/api/session/login',json={'login':'CryptoPeer','password':'Synthetic9Pass'})
        assert login.status_code==200,login.text
        denied=await read(peer,revision,q)
        assert denied.status_code in (403,409),denied.text
        assert '1.234567890123' not in denied.text
    authority.policies=(replace(policy,license_revision='replacement-not-original-license'),)
    before=await business_hash(app.state.db)
    revoked=await read(client,revision,q)
    assert revoked.status_code==503 and '许可或目标已变化' in revoked.text,revoked.text
    assert await business_hash(app.state.db)==before and len(calls)==1
    async with app.state.db.connection() as conn:
        page=await(await conn.execute('SELECT raw_bytes,raw_sha256 FROM market_source_pages WHERE task_id=%s',(task['id'],))).fetchone()
    assert bytes(page['raw_bytes'])==raw and page['raw_sha256']==hashlib.sha256(raw).hexdigest()


@pytest.mark.parametrize('case',['license_changed_after_issue','malformed_response'])
async def test_received_original_survives_revoke_or_decode_failure_without_fact_or_repeat(market,monkeypatch,case):  # noqa: F811
    client,app,authority,_,_=market
    revision,q,transport,policy,_=await install(market)
    raw=original() if case=='license_changed_after_issue' else b'{"provider_error":"synthetic malformed protocol"}'
    calls=[]
    async def fetch(url,approval):
        calls.append(url)
        if case=='license_changed_after_issue':authority.policies=(replace(policy,license_revision='changed-in-flight'),)
        return raw
    monkeypatch.setattr('alcor_api.market_crypto_latest.fetch_page',fetch)
    await demand(client,revision,q);assert await schedule(authority)==1
    task=await claim(authority.db,uuid4(),kind='market.latest');assert task
    result=await execute(authority,task,transport)
    assert result in ('source_authorization_unavailable','source_outcome_unknown'),result
    async with app.state.db.connection() as conn:
        pages=await(await conn.execute('SELECT raw_bytes,raw_sha256,issues FROM market_source_pages WHERE task_id=%s',(task['id'],))).fetchall()
        facts=await(await conn.execute('SELECT count(*) n FROM market_facts')).fetchone()
    assert len(pages)==1 and bytes(pages[0]['raw_bytes'])==raw
    assert pages[0]['raw_sha256']==hashlib.sha256(raw).hexdigest() and facts['n']==0
    if case=='malformed_response':assert pages[0]['issues']==[{'reason':'source_decode_failed'}]
    await execute(authority,task,transport)
    assert len(calls)==1


@pytest.mark.parametrize('status,oversized,empty',[(429,False,False),(503,False,False),(200,True,False),(200,False,True)])
async def test_actual_http_failure_carrier_archives_bounded_body_without_publishing_or_replay(market,monkeypatch,status,oversized,empty):  # noqa: F811
    from contextlib import asynccontextmanager
    import alcor_api.dividend_source_transport as http
    from alcor_api.dividend_sources import LIMIT
    client,app,authority,_,_=market
    revision,q,transport,_,_=await install(market)
    body=b'' if empty else b'x'*(LIMIT+1) if oversized else b'{"error":"synthetic provider rejection"}'
    calls=[]
    class Reply:
        async def aiter_stream(self):
            yield body
    class Pool:
        def __init__(self,**kwargs):
            assert kwargs['retries']==0
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        @asynccontextmanager
        async def stream(self,method,url,**kwargs):
            calls.append(url)
            assert method=='GET' and url.startswith('https://api.coingecko.com/api/v3/coins/markets?')
            reply=Reply();reply.status=status
            yield reply
    async def fixed_dns(host,port):
        assert host=='api.coingecko.com' and port==443
        return ('8.8.8.8',)
    monkeypatch.setattr(http,'resolve',fixed_dns)
    monkeypatch.setattr(http.httpcore,'AsyncConnectionPool',Pool)
    await demand(client,revision,q);assert await schedule(authority)==1
    task=await claim(authority.db,uuid4(),kind='market.latest');assert task
    assert await execute(authority,task,transport)=='source_outcome_unknown'
    async with app.state.db.connection() as conn:
        pages=await(await conn.execute('SELECT raw_bytes,raw_sha256,issues,representation FROM market_source_pages WHERE task_id=%s',(task['id'],))).fetchall()
        facts=await(await conn.execute('SELECT count(*) n FROM market_facts')).fetchone()
    kept=body[:LIMIT] if oversized else body
    assert len(pages)==1 and bytes(pages[0]['raw_bytes'])==kept
    assert pages[0]['raw_sha256']==hashlib.sha256(kept).hexdigest() and facts['n']==0
    assert pages[0]['representation']=='http_response_body'
    assert pages[0]['issues']==([{'reason':'source_decode_failed'}] if empty else [{'reason':'source_http_or_size_error','httpStatus':status,'complete':not oversized}])
    await execute(authority,task,transport)
    assert len(calls)==1
