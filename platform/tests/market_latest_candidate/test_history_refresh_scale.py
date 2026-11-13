"""19 current securities x 3200 daily observations, private PG and bounded pages."""

import asyncio
from dataclasses import asdict
from datetime import UTC, date, datetime, timedelta
from time import monotonic
from uuid import uuid4

from alcor_api.market_authority import Authority
from alcor_api.market_contract import Query, canonical
from alcor_api.market_runtime import history_cycle
from alcor_api.market_worker import claim, claim_batch, execute, schedule

from .test_market_authority import demand, market, market_settings  # noqa: F401


async def test_current_19_history_pages_resume_without_replay_or_financial_changes(market,record_property,monkeypatch):
    client,app,authority,_,revision=market
    start=date(2018,1,1)
    through=start+timedelta(days=3199)
    queries=[Query('bars','US',f'SYN{i:03}','day','qfq',start=start.isoformat(),through=through.isoformat()) for i in range(19)]
    for query in queries:await demand(client,revision,query)
    assert await schedule(authority)==19
    # Finite startup 45s + source read 12s needs a history lease longer than the
    # unchanged 30s latest lease, with original version/owner expiry guards.
    leased=await claim(authority.db,uuid4(),kind='market.history')
    async with app.state.db.connection() as conn,conn.transaction():
        duration=(await(await conn.execute('SELECT extract(epoch FROM (%s::timestamptz-clock_timestamp())) AS seconds',(leased['lease_until'],))).fetchone())['seconds']
        assert 80<duration<=90
        await conn.execute("UPDATE tasks SET status='queued',lease_until=NULL WHERE id=%s",(leased['id'],))

    class History:
        fixture=True
        calls=set()
        running=maximum=raw_bytes=0
        async def read(self,policy,query,cursor):
            offset=int(cursor or 0)
            key=(query.code,offset)
            assert key not in self.calls,'A committed original provider page was replayed'
            self.calls.add(key)
            self.running+=1;self.maximum=max(self.maximum,self.running)
            try:
                facts=[{'at':datetime.combine(start+timedelta(days=i),datetime.min.time(),UTC).replace(hour=14).isoformat(),
                        'o':'100','h':'102','l':'99','c':'101','currency':'USD','session':query.session} for i in range(offset,offset+100)]
                raw=canonical({'query':asdict(query),'licenseRevision':policy.license_revision,'facts':facts,
                               'nextCursor':str(offset+100) if offset+100<3200 else None}).encode()
                self.raw_bytes+=len(raw)
                return raw,'controlled_source_body'
            finally:self.running-=1

    source=History()
    began=monotonic()
    async with asyncio.timeout(240):
        # Leave a real durable checkpoint, discard the submitting client-local
        # authority/worker identity and resume from PG with a new worker.
        for _ in range(37):assert await history_cycle(authority,source,uuid4())
        async with app.state.db.connection() as conn:
            checkpoint=await(await conn.execute('SELECT task_id,cursor,page_count FROM market_data_jobs ORDER BY task_id')).fetchall()
            assert sum(row['page_count'] for row in checkpoint)==37
        restored=Authority(app.state.db,authority.policies)
        while await history_cycle(restored,source,uuid4()):pass
    elapsed=monotonic()-began
    assert len(source.calls)==608 and source.maximum==1 and source.running==0
    read_began=monotonic()
    response=await client.get('/api/kline/full?market=US&code=SYN000&limit=3200')
    read_elapsed=monotonic()-read_began
    assert response.status_code==200,response.text
    assert len(response.json()['items'])==3200
    assert response.json()['items'][0]['d']==start.isoformat() and response.json()['items'][-1]['d']==through.isoformat()
    assert len(source.calls)==608,'Reading history must never invoke a provider'
    async with app.state.db.connection() as conn:
        counts=await(await conn.execute('SELECT stream_id,count(*) AS n FROM market_facts GROUP BY stream_id')).fetchall()
        assert len(counts)==19 and all(row['n']==3200 for row in counts)
        receipts=await(await conn.execute('SELECT point_count,assurance FROM market_coverage_receipts')).fetchall()
        assert len(receipts)==19 and all(row['point_count']==3200 and row['assurance']=='controlled_terminal_pages' for row in receipts)
        assert (await(await conn.execute("SELECT count(*) AS n FROM tasks WHERE kind='market.history' AND status='succeeded'")).fetchone())['n']==19
        assert (await(await conn.execute('SELECT count(*) AS n FROM market_source_pages')).fetchone())['n']==608
        # Observation collection must never become financial/position history.
        for table in ('portfolio_records','trade_ledger','cash_ledger_entries','broker_accounts'):
            assert (await(await conn.execute(f'SELECT count(*) AS n FROM {table}')).fetchone())['n']==0
    record_property('history_observations',60800)
    record_property('retained_source_pages',608)
    record_property('raw_bytes',source.raw_bytes)
    record_property('seconds',round(elapsed,3))
    record_property('isolated_http_read_3200_seconds',round(read_elapsed,3))

    # The production directory currently retains about 60k historical facts.
    # Latest reads must use their own index instead of rescanning that history
    # once for each stream; collect every latest value from an actual source page.
    class Latest:
        fixture=True
        calls=0
        async def read(self,policy,query,cursor):
            self.calls+=1
            price=100+int(query.code[3:])
            raw=canonical({'query':asdict(query),'licenseRevision':policy.license_revision,
                'facts':[{'at':datetime.now(UTC).isoformat(),'price':str(price),'currency':'USD',
                          'session':'REGULAR','cached':False,'prevClose':str(price-1)}],'nextCursor':None}).encode()
            return raw,'controlled_source_body'
    latest=Latest()
    for i in range(19):await demand(client,revision,Query('latest','US',f'SYN{i:03}'))
    assert await schedule(authority)==19
    tasks=await claim_batch(app.state.db,uuid4(),maximum=20)
    assert len(tasks)==19
    for task in tasks:assert await execute(authority,task,latest)=='observed'
    from alcor_api.request_timing import TimedConnection
    statements=[];original_execute=TimedConnection.execute
    async def recorded(conn,query,params=None,**options):
        if isinstance(query,str) and ('JOIN unnest' in query and 'market_streams' in query or 'CROSS JOIN LATERAL' in query and 'market_facts' in query):
            statements.append(query)
        return await original_execute(conn,query,params,**options)
    monkeypatch.setattr(TimedConnection,'execute',recorded)
    began=monotonic()
    current=await client.post('/api/market/quotes/read',json={'items':[
        {'id':str(i),'market':'US','code':f'SYN{i:03}'} for i in range(19)],'includeMarketCap':False})
    latest_elapsed=monotonic()-began
    assert current.status_code==200,current.text
    assert {int(k):v['price'] for k,v in current.json()['quotes'].items()}=={i:100+i for i in range(19)}
    assert len(statements)==2 and latest.calls==19 and len(source.calls)==608
    async with app.state.db.connection() as conn:
        await conn.execute('ANALYZE market_facts')
        selected=await(await conn.execute("SELECT owner_id,stream_id,source_revision FROM market_facts WHERE contents ? 'price' LIMIT 1")).fetchone()
        plan=await(await conn.execute('''EXPLAIN (FORMAT JSON) SELECT * FROM market_facts
            WHERE owner_id=%s AND stream_id=%s AND source_revision=%s
            ORDER BY source_time DESC,sequence DESC LIMIT 1''',tuple(selected.values()))).fetchone()
        assert 'market_fact_stream_window' in str(plan)
        assert (await(await conn.execute('SELECT count(*) AS n FROM market_facts')).fetchone())['n']==60819
    record_property('latest_http_read_19_seconds',round(latest_elapsed,3))
    record_property('latest_lookup_statements',len(statements))
