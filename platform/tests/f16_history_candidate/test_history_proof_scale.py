"""Two actual PG securities, each 45 overlapping 800-fact retained originals."""
import asyncio
from dataclasses import asdict, replace
from datetime import UTC, datetime, timedelta
from time import monotonic
from uuid import uuid4

import pytest_asyncio
from alcor_api.market_contract import Query, canonical
from alcor_api.market_worker import claim, execute, schedule
from alcor_api.native_app_auth import issue_grant
from market_latest_candidate.test_market_authority import demand, market, market_settings  # noqa: F401
from redis.asyncio import Redis
from source_pure_read_candidate.test_reads import snapshot
from test_connections import PASSWORD, private_redis  # noqa: F401


@pytest_asyncio.fixture
async def shared_read_cache(market, private_redis):  # noqa: F811 -- imported pytest fixtures
    cache=Redis(unix_socket_path=str(private_redis),password=PASSWORD)
    market[1].state.cache.client=cache
    try:
        yield
    finally:
        market[1].state.cache.client=None
        await cache.aclose()


async def test_overlapping_source_pages_remain_verified_and_warm_across_web_and_app(market, shared_read_cache, monkeypatch, record_property):  # noqa: F811 -- imported pytest fixtures
    client, app, authority, _, _ = market
    authority.policies=(replace(authority.policies[0], purposes=('bars.minute.ALL',)),)
    registered=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'fixture'})
    assert registered.status_code==200,registered.text
    revision=registered.json()['revision']
    authority.clock=lambda:datetime(2026,10,21,20,30,tzinfo=UTC)
    class Overlapping:
        fixture=True
        calls=0
        async def read(self, policy, query, cursor):
            self.calls+=1
            page=int(cursor or 0)
            facts=[{'at':(datetime(2026,10,20,8,tzinfo=UTC)+timedelta(minutes=800 if page==0 and i==799 else i)).isoformat(),
                'o':'100','h':'102','l':'99','c':'101' if i%45==page else '100',
                'currency':'USD','session':'ALL'}for i in range(800)]
            return canonical({'query':asdict(query),'licenseRevision':policy.license_revision,'facts':facts,
                'nextCursor':str(page+1) if page<44 else None}).encode(),'controlled_original'
    source=Overlapping()
    for symbol in ('SYNAAA','SYNBBB'):
        await demand(client,revision,Query('bars','US',symbol,'minute','none','ALL',start='2026-10-20',through='2026-10-21'))
    assert await schedule(authority)==2
    while task:=await claim(app.state.db,uuid4(),kind='market.history'):
        assert await execute(authority,task,source) in ('more','complete')
    assert source.calls==90
    async with app.state.db.connection() as conn:
        user=await(await conn.execute('SELECT * FROM users')).fetchone()
        grant=await issue_grant(conn,user,'portfolio.read','Synthetic history scale')
        pages=await(await conn.execute('SELECT count(*) AS pages,sum(octet_length(raw_bytes)) AS bytes FROM market_source_pages')).fetchone()
        assert pages['pages']==90
    headers={'authorization':'Bearer '+grant['access_token'],'x-alcor-market-source':revision}
    before=await snapshot(app.state.db)
    import alcor_api.market_history_evidence as evidence
    original=evidence.decode
    calls=[]
    def counted(*args,**kwargs):
        calls.append(1)
        return original(*args,**kwargs)
    monkeypatch.setattr(evidence,'decode',counted)
    async def read(symbol, version):
        url=f'/api/{version}/chart-series'
        response=await client.get(url+f'?market=US&code={symbol}&days=1',headers=headers)
        assert response.status_code==200,response.text
        value=response.json()['data']
        assert len(value['points'])>2
        return value
    began=monotonic()
    cold=await asyncio.gather(read('SYNAAA','v2'),read('SYNBBB','v2'))
    cold_ms=(monotonic()-began)*1000
    assert len(calls)==90
    began=monotonic()
    warm=await asyncio.gather(read('SYNAAA','v1'),read('SYNBBB','v1'))
    warm_ms=(monotonic()-began)*1000
    assert warm==cold
    web=await client.get('/api/kline/session-day?market=US&code=SYNBBB',
        headers={'x-alcor-market-source':revision})
    assert web.status_code==200,web.text
    assert [{k:p[k]for k in ('date','time','price')} for p in web.json()['points']]==cold[1]['points']
    assert len(calls)==90,'Unchanged originals were decoded again across Web/v1/v2'
    assert source.calls==90 and await snapshot(app.state.db)==before
    assert evidence._index_bytes<=32*1024*1024 and len(evidence._indexes)<=512
    record_property('overlapping_original_pages',90)
    record_property('raw_bytes',int(pages['bytes']))
    record_property('decoded_original_facts',72000)
    record_property('cold_http_pair_ms',round(cold_ms,2))
    record_property('warm_http_pair_ms',round(warm_ms,2))
