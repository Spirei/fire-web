"""Real private PG / old read projections. Neither GET renews, schedules nor fetches."""

import asyncio
import hashlib
import json
import os
import subprocess
from dataclasses import asdict, replace
from pathlib import Path
from uuid import uuid4

import httpx
import pytest
from request_telemetry_tables import REQUEST_TELEMETRY_TABLES
from alcor_api.backups import tables_and_hashes
from alcor_api.market_contract import Query
from alcor_api.market_worker import schedule
from alcor_api.native_app_auth import issue_grant
from market_latest_candidate.test_market_authority import demand

HERE=Path(__file__).parent


async def native(app):
    async with app.state.db.connection() as conn:
        user=await (await conn.execute("SELECT * FROM users WHERE username='MarketReader'")).fetchone()
        pair=await issue_grant(conn,user,"portfolio.read portfolio.write","Synthetic pool reader")
    return {"authorization":"Bearer "+pair["access_token"]},pair


async def old_web(client):
    result=await client.post('/api/auth/login',json={'username':'MarketReader','password':'Synthetic9Pass'})
    assert result.status_code==200,result.text


async def hashes(app):
    async with app.state.db.connection() as conn,conn.transaction():
        observed = await tables_and_hashes(conn)
    # Request quotas and the independent recorder are not collection, renewal or business writes.
    telemetry = REQUEST_TELEMETRY_TABLES | {"auth_rate_limits"}
    return {name:value for name,value in observed.items() if name not in telemetry}


async def test_actual_old_typescript_pool_and_subscription_DTOs_match_persistent_requests(market):
    root=os.environ.get('ALCOR_MARKET_LEGACY_ROOT')
    if not root:pytest.skip('Explicit read-only legacy source required')
    proof=json.loads((HERE/'source-evidence.json').read_text())
    for name,wanted in proof['source_sha256'].items():assert hashlib.sha256((Path(root)/name).read_bytes()).hexdigest()==wanted
    client,app,authority,transport,revision=market
    accepted=await demand(client,revision)
    await schedule(authority)
    headers,_=await native(app)
    listed=await client.get('/api/v2/quote-subscriptions',headers=headers)
    assert listed.status_code==200,listed.text
    await old_web(client)
    pool=await client.get('/api/quote-pool')
    assert pool.status_code==200,pool.text
    body=pool.json()['data'];subscription=listed.json()['data']['subscriptions'][0]
    async with app.state.db.connection() as conn:
        source=await (await conn.execute("SELECT o.created_at,d.expires_at,t.status FROM market_data_operations o "
            "JOIN market_demands d ON d.stream_id::text=o.result->>'streamId' "
            "JOIN market_streams s ON s.id=d.stream_id AND s.owner_id=d.owner_id "
            "JOIN tasks t ON t.id=s.current_task_id WHERE o.request_id=%s",(accepted['requestId'],))).fetchone()
    assert source['status']=='queued'
    requested=int(source['created_at'].timestamp()*1000);expires=int(source['expires_at'].timestamp()*1000)
    assert subscription['lastRequestedAt']==requested and subscription['expiresAt']==expires
    # Independent admitted-runtime fixture from PG facts, not the adapter's output.
    payload={'now':body['at'],'rows':[{'market':'US','code':'AAPL','last_requested_at':requested,'reads':2}],
        'runtime':[{'market':'US','code':'AAPL','lastRequestedAt':requested,'expiresAt':expires,'state':'hot','updating':False}],'scope':'mine'}
    result=json.loads(await asyncio.to_thread(subprocess.check_output,['node',str(HERE/'run_pool_golden.cjs'),root],input=json.dumps(payload),text=True))
    assert result['memoryOnly'] is True
    # Accepted PG receipt time and stored expiry are both original facts; the receipt
    # follows lease admission in the same transaction, so it is not used to invent TTL.
    expected=result['subscriptions'][0]
    assert {k:v for k,v in subscription.items() if k!='expiresAt'}=={**{k:v for k,v in expected.items() if k!='expiresAt'}, 'sourcePermission':'current'}
    assert 0<=expected['expiresAt']-subscription['expiresAt']<1000
    for actual,expected in zip(body['entries'],result['pool']['entries'],strict=True):
        assert {k:v for k,v in actual.items() if k!='expiresAt'}=={**{k:v for k,v in expected.items() if k!='expiresAt'},'metadataState':'missing','sourcePermission':'current'}
    assert transport.calls==0


async def test_reads_preserve_every_table_original_receipt_and_no_quote_or_volume_fabrication(market):
    client,app,_authority,transport,revision=market
    accepted=await demand(client,revision)
    headers,_=await native(app);await old_web(client)
    before=await hashes(app)
    for path in ['/api/quote-pool','/api/market/pool','/api/market/subscriptions']:
        assert (await client.get(path)).status_code==200
    native_response=await client.get('/api/v2/quote-subscriptions',headers=headers)
    assert native_response.status_code==200
    assert await hashes(app)==before
    assert transport.calls==0
    assert 'price' not in native_response.text and 'volume' not in native_response.text
    async with app.state.db.connection() as conn:
        stamp=await (await conn.execute('SELECT created_at FROM market_data_operations WHERE request_id=%s',(accepted['requestId'],))).fetchone()
    assert native_response.json()['data']['subscriptions'][0]['lastRequestedAt']==int(stamp['created_at'].timestamp()*1000)
    assert before['market_facts']['rows']==0


async def test_owner_scope_parameters_native_and_legacy_cookies_do_not_mix(market):
    client,app,_authority,_transport,revision=market
    await demand(client,revision)
    assert (await client.get('/api/quote-pool')).status_code==401
    assert (await client.get('/api/v2/quote-subscriptions')).status_code==401
    headers,_=await native(app)
    assert (await client.get('/api/v2/quote-subscriptions?market=HK',headers=headers)).json()['data']['subscriptions']==[]
    for suffix in ['?market=INVALID','?market=US&market=HK','?unknown=x']:
        assert (await client.get('/api/v2/quote-subscriptions'+suffix,headers=headers)).status_code==400
    await old_web(client)
    assert (await client.get('/api/quote-pool?scope=other')).status_code==400
    assert (await client.get('/api/quote-pool?scope=mine&scope=shared')).status_code==400
    assert (await client.get('/api/quote-pool',headers=headers)).status_code==401
    assert (await client.get('/api/market/pool?scope=shared',headers=headers)).status_code==403
    shared=await client.get('/api/quote-pool?scope=shared')
    assert shared.status_code==200
    assert 'owner_id' not in shared.text and 'sourceRevision' not in shared.text
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE users SET role='user' WHERE username='MarketReader'")
    denied=await client.get('/api/quote-pool?scope=shared')
    assert denied.status_code==403 and denied.headers['x-alcor-retire-context']=='true'


async def test_expiry_and_cancellation_are_filtered_without_pruning_or_renewing(market):
    client,app,_authority,transport,revision=market
    await demand(client,revision);headers,_=await native(app)
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE market_demands SET expires_at=clock_timestamp()-interval '1 second'")
    before=await hashes(app)
    response=await client.get('/api/v2/quote-subscriptions',headers=headers)
    assert response.json()['data']['subscriptions']==[]
    assert await hashes(app)==before and before['market_demands']['rows']==1
    assert transport.calls==0


async def test_revoked_source_and_changed_license_are_errors_not_empty_subscriptions(market):
    client,app,authority,transport,revision=market
    await demand(client,revision);headers,_=await native(app)
    original=authority.policies
    authority.policies=(replace(original[0],license_revision='changed-license'),)
    unavailable=await client.get('/api/v2/quote-subscriptions',headers=headers)
    assert unavailable.status_code==503 and 'subscriptions' not in unavailable.json()
    authority.policies=original
    response=await client.request('DELETE','/api/market/sources/'+revision,json={'request_id':str(uuid4())})
    assert response.status_code==200,response.text
    before=await hashes(app)
    read=await client.get('/api/v2/quote-subscriptions',headers=headers)
    assert read.status_code==409 and 'subscriptions' not in read.json()
    assert await hashes(app)==before and transport.calls==0


async def test_missing_original_request_time_is_unknown_not_current_time(market):
    client,app,_authority,transport,revision=market
    accepted=await demand(client,revision);headers,_=await native(app)
    query=asdict(Query('latest','US','MSFT'))
    async with app.state.db.connection() as conn:
        stream=uuid4()
        from alcor_api.market_contract import digest
        from psycopg.types.json import Jsonb
        owner=(await (await conn.execute("SELECT id FROM users WHERE username='MarketReader'")).fetchone())['id']
        await conn.execute('INSERT INTO market_streams(owner_id,source_revision,id,query_fingerprint,query) VALUES(%s,%s,%s,%s,%s)',(owner,revision,stream,digest(query),Jsonb(query)))
        await conn.execute("INSERT INTO market_demands(owner_id,stream_id,principal,session_version,expires_at,hot_until,origin) SELECT owner_id,%s,principal,session_version,expires_at,hot_until,origin FROM market_demands WHERE stream_id=%s",(stream,accepted['streamId']))
    before=await hashes(app)
    response=await client.get('/api/v2/quote-subscriptions',headers=headers)
    assert response.status_code==409 and '原请求时间未知' in response.json()['message']
    assert await hashes(app)==before and transport.calls==0


async def test_different_owner_cannot_read_another_private_subscription(market):
    client,app,_authority,_transport,revision=market
    await demand(client,revision)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as other:
        registered=await other.post('/api/session/register',json={'username':'SecondMarketOwner','password':'Synthetic9Pass'})
        assert registered.status_code==201,registered.text
        owner=registered.json()['user']['id']
        async with app.state.db.connection() as conn:
            user=await (await conn.execute('SELECT * FROM users WHERE id=%s',(owner,))).fetchone()
            pair=await issue_grant(conn,user,'portfolio.read','Synthetic separate reader')
        response=await other.get('/api/v2/quote-subscriptions',headers={'authorization':'Bearer '+pair['access_token']})
        assert response.status_code==200 and response.json()['data']=={'subscriptions':[]}
        assert 'AAPL' not in response.text
