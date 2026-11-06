import copy
import json
from uuid import UUID,uuid4
from decimal import Decimal

import psycopg
import pytest
from psycopg import sql

from .helpers import export
from .synthetic_legacy import rows,OWNER
from .test_financial_mapping import imported,mapping_command,preview


async def append_tail(pg,old_pg,*,fees='0.25',when='2026-01-04T10:00:00-05:00'):
    data=rows();oid='old-order-3'
    additions={}
    template=copy.deepcopy(data['trade_orders'][1]);template.update(id=oid,qty='1',price='13',fees=fees,amount='13',position_qty_before='8',position_cost_before='9.625',position_qty_after='7',position_cost_after='9.143',traded_at=when,created_at=when,order_no='source-no-3');additions['trade_orders']=template
    additions['app_asset_order_versions']={'order_id':oid,'revision':10}
    detail=copy.deepcopy(data['trade_fee_details'][1]);detail['order_id']=oid;value=json.loads(detail['detail_json']);value['total']=fees;detail['detail_json']=json.dumps(value);detail['created_at']=when;additions['trade_fee_details']=detail
    additions['broker_cash_order_links']={'order_id':oid,'user_id':OWNER,'account_id':'old-broker-1','currency':'USD'}
    receipt={'requestId':str(UUID(int=10)),'kind':'submit_trade','state':'completed','accountId':OWNER,'data':{'items':[{'id':oid}]}}
    additions['app_asset_operations']={'user_id':OWNER,'request_id':str(UUID(int=10)),'result_json':json.dumps(receipt)}
    additions['fund_transactions']={'id':'fund-order-'+oid,'user_id':OWNER,'currency':'USD','type':'adjustment','amount':'12.75','direction':1,'occurred_at':when,'created_at':when,'note':'old duplicate projected row'}
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database)) as conn:
        for table,item in additions.items():
            await conn.execute(sql.SQL('INSERT INTO {} ({}) VALUES ({})').format(sql.Identifier(table),sql.SQL(',').join(map(sql.Identifier,item)),sql.SQL(',').join(sql.Placeholder() for _ in item)),tuple(item.values()))
        await conn.execute("UPDATE records SET qty=7,cost=9.143,revision=4,updated_at=%s WHERE id='old-record-1'",(when,))
        await conn.execute('UPDATE record_revisions SET revision=4')
        await conn.execute('UPDATE broker_cash_accounts SET revision=4')


@pytest.mark.asyncio
async def test_same_snapshot_chain_existing_target_appends_one_tail_with_original_uuid_and_mapping(client,admin,old_pg,app,pg):
    grant,first,account,record,finance=await imported(client,admin,old_pg)
    firstmap=mapping_command(admin,first,finance);proof=await preview(client,firstmap)
    assert (await client.post('/api/legacy-financial/mappings/operations',json={'data':firstmap,'preview':proof})).json()['state']=='completed'
    await append_tail(pg,old_pg)
    second,*_=await export(client,grant,predecessor=first['manifestSha256']);assert second['financialReady'],second
    command={**finance,'requestId':str(uuid4()),'sourceId':second['sourceId'],'sourceHash':second['financialSha256']}
    response=await client.post('/api/financial-import/preview',json=command)
    assert response.status_code==200 and response.json()['ready'],response.text
    plan=response.json();assert plan['mode']=='verified_same_source_append_only_tail' and plan['newFilledOrders']==1 and plan['newCashPostings']==1 and plan['reusedSourceObjects']==6
    response=await client.post('/api/financial-import/operations',json={'data':command,'preview':plan['preview']})
    assert response.status_code==200 and response.json()['state']=='completed' and response.json()['financialApplied'],response.text
    async with app.state.db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==3
        assert (await(await conn.execute('SELECT count(*) n FROM cash_ledger_entries')).fetchone())['n']==4
        assert (await(await conn.execute('SELECT sum(amount) n FROM cash_ledger_entries')).fetchone())['n']==Decimal('935.25')
        target=await(await conn.execute('SELECT qty,cost FROM portfolio_records WHERE id=%s',(record,))).fetchone();assert target=={'qty':Decimal(7),'cost':Decimal('9.143')}
        link=await(await conn.execute("SELECT original_uuid FROM financial_import_links WHERE object_kind='order' AND original_id='old-order-3'")).fetchone();assert link['original_uuid']==UUID(int=10)
        assert (await(await conn.execute('SELECT count(*) n FROM trade_operations WHERE request_id=%s',(UUID(int=10),))).fetchone())['n']==1
    secondmap=mapping_command(admin,second,command,1);proof=await preview(client,secondmap)
    response=await client.post('/api/legacy-financial/mappings/operations',json={'data':secondmap,'preview':proof})
    assert response.json()['state']=='completed' and response.json()['mappingRevision']==2 and response.json()['mappedObjects']==8,response.text
    state=(await client.get('/api/fees/repairs',params={'brokerAccountId':account})).json()
    assert state['legacyCoverage']['status']=='complete' and len(state['items'])==3
    # A new UUID over the same frozen source only verifies reuse, it cannot post a second copy.
    duplicate={**command,'requestId':str(uuid4())}
    p=(await client.post('/api/financial-import/preview',json=duplicate)).json();assert p['ready'] and p['newCashPostings']==p['newFilledOrders']==0,p
    response=await client.post('/api/financial-import/operations',json={'data':duplicate,'preview':p['preview']});assert response.json()['state']=='completed',response.text
    async with app.state.db.connection() as conn:assert (await(await conn.execute('SELECT sum(amount) n FROM cash_ledger_entries')).fetchone())['n']==Decimal('935.25')


@pytest.mark.asyncio
async def test_unrelated_existing_target_financial_entry_blocks_only_the_affected_scope_without_overwrite(client,admin,old_pg,app,pg):
    grant,first,account,record,finance=await imported(client,admin,old_pg)
    data={'requestId':str(uuid4()),'accountId':account,'accountKind':'real','currency':'USD','action':'external_deposit','amount':'5','occurredAt':'2026-01-03T18:00:00Z'}
    response=await client.post('/api/cash/preview',json=data)
    # Use the canonical CashLedger service shape from the public route.
    assert response.status_code==200,response.text
    response=await client.post('/api/cash/operations',json={'data':data,'preview':response.json()['preview']});assert response.status_code==200,response.text
    await append_tail(pg,old_pg);second,*_=await export(client,grant,predecessor=first['manifestSha256'])
    command={**finance,'requestId':str(uuid4()),'sourceId':second['sourceId'],'sourceHash':second['financialSha256']}
    response=await client.post('/api/financial-import/preview',json=command)
    assert response.status_code==200 and not response.json()['ready'] and any(x['code']=='target_cash_scope_has_unrelated_or_missing_financial_history' for x in response.json()['blockers']),response.text
    async with app.state.db.connection() as conn:
        assert (await(await conn.execute('SELECT sum(amount) n FROM cash_ledger_entries')).fetchone())['n']==Decimal('927.5')
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==2


@pytest.mark.asyncio
@pytest.mark.parametrize('failure',['interrupt','deferred_database'])
async def test_tail_failure_retains_old_financial_prefix_and_original_failed_uuid(client,admin,old_pg,app,pg,failure):
    grant,first,_,_,finance=await imported(client,admin,old_pg)
    await append_tail(pg,old_pg);second,*_=await export(client,grant,predecessor=first['manifestSha256'])
    command={**finance,'requestId':str(uuid4()),'sourceId':second['sourceId'],'sourceHash':second['financialSha256']}
    response=await client.post('/api/financial-import/preview',json=command);assert response.json()['ready'],response.text
    async def fail(conn,index,item):
        if failure=='interrupt':raise RuntimeError('synthetic tail interruption')
        await conn.execute("INSERT INTO broker_account_references(owner_id,account_id,kind,reference_id,currency) VALUES(%s,'missing-target-account','order','synthetic-failure','USD')",(admin,))
    app.state.authorized_financial_import.after_step=fail
    response=await client.post('/api/financial-import/operations',json={'data':command,'preview':response.json()['preview']})
    assert response.status_code==200 and response.json()['state']=='failed' and not response.json()['financialApplied'],response.text
    assert (await client.get('/api/financial-import/operations/'+command['requestId'])).json()==response.json()
    async with app.state.db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==2
        assert (await(await conn.execute('SELECT count(*) n FROM financial_import_links')).fetchone())['n']==6
        assert (await(await conn.execute('SELECT sum(amount) n FROM cash_ledger_entries')).fetchone())['n']==Decimal('922.5')
    app.state.authorized_financial_import.after_step=None
    command['requestId']=str(uuid4())
    p=(await client.post('/api/financial-import/preview',json=command)).json();assert p['ready']
    response=await client.post('/api/financial-import/operations',json={'data':command,'preview':p['preview']});assert response.json()['state']=='completed',response.text


@pytest.mark.asyncio
async def test_tail_lost_response_restart_original_uuid_does_not_reread_or_double_post(client,admin,old_pg,app,settings,pg):
    import httpx
    from alcor_api.main import create_app
    grant,first,_,_,finance=await imported(client,admin,old_pg)
    await append_tail(pg,old_pg);second,*_=await export(client,grant,predecessor=first['manifestSha256'])
    command={**finance,'requestId':str(uuid4()),'sourceId':second['sourceId'],'sourceHash':second['financialSha256']}
    p=(await client.post('/api/financial-import/preview',json=command)).json();assert p['ready']
    async def lose(_):raise RuntimeError('synthetic lost tail response')
    app.state.authorized_financial_import.after_commit=lose
    response=await client.post('/api/financial-import/operations',json={'data':command,'preview':p['preview']});assert response.status_code==503
    restarted=create_app(settings)
    async with restarted.router.lifespan_context(restarted):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=restarted),base_url='http://testserver',cookies=client.cookies,headers=dict(client.headers)) as other:
            original=await other.get('/api/financial-import/operations/'+command['requestId']);assert original.status_code==200 and original.json()['financialApplied']
            same=await other.post('/api/financial-import/operations',json={'data':command,'preview':p['preview']});assert same.json()==original.json()
            async with restarted.state.db.connection() as conn:
                assert (await(await conn.execute('SELECT sum(amount) n FROM cash_ledger_entries')).fetchone())['n']==Decimal('935.25')
                assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==3
                assert (await(await conn.execute('SELECT count(*) n FROM legacy_source_manifests')).fetchone())['n']==2


@pytest.mark.asyncio
async def test_new_backdated_event_is_not_a_tail_and_unknown_fee_never_becomes_zero(client,admin,old_pg,app,pg):
    grant,first,_,_,finance=await imported(client,admin,old_pg)
    await append_tail(pg,old_pg,when='2026-01-02T18:00:00-05:00')
    second,*_=await export(client,grant,predecessor=first['manifestSha256'])
    # Snapshot retains original position-before evidence, so inserting an event
    # inside an already imported history fails before any target overwrite.
    command={**finance,'requestId':str(uuid4()),'sourceId':second['sourceId'],'sourceHash':second['financialSha256']}
    response=await client.post('/api/financial-import/preview',json=command)
    assert response.status_code==200 and not response.json()['ready'],response.text
    assert any(b['code'] in ('original_position_projection_differs_from_canonical_rules','source_position_closing_mismatch','source_new_events_are_not_a_contiguous_tail') for b in response.json()['blockers']),response.text
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database)) as conn:
        await conn.execute("UPDATE trade_orders SET fees=NULL WHERE id='old-order-3'")
    third,*_=await export(client,grant,predecessor=second['manifestSha256'])
    assert not third['financialReady'] and any(b['code'] in ('actual_fee_authority_unknown','fee_snapshot_authority_mismatch','original_input_missing') for b in third['normalizationBlockers'])
    async with app.state.db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==2
        assert (await(await conn.execute('SELECT sum(amount) n FROM cash_ledger_entries')).fetchone())['n']==Decimal('922.5')


@pytest.mark.asyncio
async def test_new_nonfilled_tail_remains_inactive_intent_with_no_new_cash_or_fill(client,admin,old_pg,app,pg):
    grant,first,account,record,finance=await imported(client,admin,old_pg)
    await append_tail(pg,old_pg)
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database)) as conn:
        await conn.execute("UPDATE trade_orders SET status='pending',position_qty_after=NULL,position_cost_after=NULL WHERE id='old-order-3'")
        await conn.execute("UPDATE records SET qty=8,cost=9.625 WHERE id='old-record-1'")
    second,*_=await export(client,grant,predecessor=first['manifestSha256']);assert second['financialReady'],second
    command={**finance,'requestId':str(uuid4()),'sourceId':second['sourceId'],'sourceHash':second['financialSha256']}
    p=(await client.post('/api/financial-import/preview',json=command)).json();assert p['ready'],p
    assert p['newFilledOrders']==p['newCashPostings']==0 and p['suspendedIntents']==1
    response=await client.post('/api/financial-import/operations',json={'data':command,'preview':p['preview']});assert response.json()['state']=='completed',response.text
    async with app.state.db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==2
        assert (await(await conn.execute('SELECT sum(amount) n FROM cash_ledger_entries')).fetchone())['n']==Decimal('922.5')
        intent=await(await conn.execute('SELECT order_type,status,import_original_status,reservation_cash FROM internal_orders')).fetchone()
        assert intent['order_type']=='imported' and intent['status']=='imported_suspended' and intent['import_original_status']=='pending'
    mapping=mapping_command(admin,second,command);proof=await preview(client,mapping)
    response=await client.post('/api/legacy-financial/mappings/operations',json={'data':mapping,'preview':proof});assert response.json()['state']=='completed',response.text
    async with app.state.db.connection() as conn:
        mapped=await(await conn.execute("SELECT canonical_snapshot FROM legacy_financial_mapping_items WHERE object_kind='order' AND original_id='old-order-3'")).fetchone()
        assert mapped['canonical_snapshot']['rowType']=='intent' and mapped['canonical_snapshot']['original_status']=='pending'
