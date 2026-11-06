import httpx
import pytest
from alcor_api.cli import create_user
from legacy_fee_source_fixture import old_pg
from actual_fee_test_support import actual_case
from test_fee_plans import account


async def financial(db):
    async with db.connection() as conn:
        return {name:await(await conn.execute('SELECT * FROM '+name+' ORDER BY 1')).fetchall() for name in ('cash_ledger_collections','cash_ledger_entries','portfolio_record_collections','portfolio_records','legacy_fee_estimation_heads','legacy_fee_estimates','legacy_fee_baseline_bindings','audit_events')}


@pytest.mark.asyncio
async def test_absent_head_is_real_absence_and_get_never_initializes_financial_collections(client,admin,db):
    aid=await account(client);before=await financial(db)
    assert before['cash_ledger_collections']==[] and before['legacy_fee_estimation_heads']==[]
    response=await client.get('/api/fees/estimates',params={'brokerAccountId':aid})
    assert response.status_code==200 and response.json()=={'brokerAccountId':aid,'revision':0,'requestId':None},response.text
    assert response.headers['cache-control']=='no-store' and await financial(db)==before


@pytest.mark.asyncio
async def test_head_reopens_from_actual_authority_and_foreign_owner_cannot_enumerate_or_create_it(client,admin,db,app,old_pg,pg,tmp_path,settings):
    async with actual_case(client,admin,app,old_pg,pg,tmp_path) as (approved,source_app,grant,exported,aid,fill,data):
        before=await financial(db)
        response=await approved.get('/api/fees/estimates',params={'brokerAccountId':aid})
        assert response.status_code==200 and response.json()['revision']==1 and response.json()['requestId'],response.text
        saved=await approved.get('/api/fees/estimates/operations/'+response.json()['requestId'])
        assert saved.status_code==200 and saved.json()['revision']==1 and not saved.json()['financialApplied']
        assert await financial(db)==before
        await create_user(settings,'OtherHeadOwner','Synthetic9Pass')
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=source_app),base_url='http://testserver',headers={'origin':'http://testserver'}) as other:
            login=await other.post('/api/session/login',json={'login':'OtherHeadOwner','password':'Synthetic9Pass'});assert login.status_code==200
            other.headers['x-csrf-token']=login.json()['csrf']
            before=await financial(db)
            denied=await other.get('/api/fees/estimates',params={'brokerAccountId':aid})
            assert denied.status_code==404 and await financial(db)==before,denied.text
