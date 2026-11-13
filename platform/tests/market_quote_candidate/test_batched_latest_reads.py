"""Actual PG batch retrieval preserves each security and existing read boundaries."""
from dataclasses import asdict
from uuid import uuid4

from alcor_api.market_contract import Query,canonical
from alcor_api.market_worker import claim_batch,execute,schedule
from alcor_api.request_timing import TimedConnection
from market_latest_candidate.test_market_authority import demand
from market_quote_candidate.test_quote_reads import quoted,AT,body,hashes  # noqa: F401 -- shared isolated observed fixture


async def test_nineteen_securities_use_one_stream_and_fact_read_without_crossing_symbols(quoted,monkeypatch):
    client,app,authority,transport,revision,headers,original=quoted
    async def collect(policy,query,cursor):
        transport.calls+=1
        price=1000+int(query.code[3:])
        value={**original,'price':str(price),'prevClose':'1000','open':str(price),
               'high':str(price+1),'low':str(price-1),'name':query.code}
        return canonical({'query':asdict(query),'licenseRevision':policy.license_revision,
                          'facts':[value],'nextCursor':None}).encode(),'controlled_http_response_body'
    transport.read=collect
    for number in range(1,19):
        await demand(client,revision,query=Query('latest','US',f'SYN{number:02}'))
    await schedule(authority)
    tasks=await claim_batch(app.state.db,uuid4(),maximum=20)
    assert len(tasks)==18
    for task in tasks:assert await execute(authority,task,transport)=='observed'
    statements=[];original_execute=TimedConnection.execute
    async def recorded(conn,query,params=None,**options):
        if isinstance(query,str) and ('JOIN unnest' in query and 'market_streams' in query or 'CROSS JOIN LATERAL' in query and 'market_facts' in query):
            statements.append(query)
        return await original_execute(conn,query,params,**options)
    monkeypatch.setattr(TimedConnection,'execute',recorded)
    requested=[{'id':'apple','market':'US','code':'AAPL'},
               *[{'id':str(n),'market':'US','code':f'SYN{n:02}'} for n in range(1,19)],
               {'id':'alias','market':'US','code':'AAPL'},
               {'id':'ambiguous','market':'US','code':'AAPL'},
               {'id':'ambiguous','market':'US','code':'SYN01'}]
    before=await hashes(app);calls=transport.calls
    response=await client.post('/api/market/quotes/read',json=body(*requested),headers=headers)
    assert response.status_code==200,response.text
    values=response.json()['quotes'];states=response.json()['quoteStates']
    assert len(values)==20 and values['apple']==values['alias']
    assert values['apple']['price']==120
    assert {n:values[str(n)]['price'] for n in range(1,19)}=={n:1000+n for n in range(1,19)}
    assert 'ambiguous' not in values and states['ambiguous']['state']=='ambiguous_request_id'
    assert len(statements)==2 and sum('JOIN unnest' in q for q in statements)==1
    assert await hashes(app)==before and transport.calls==calls
