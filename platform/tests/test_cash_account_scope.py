from decimal import Decimal
from uuid import uuid4
import pytest
from legacy_fee_source_fixture import old_pg,old_rows_from_target
from actual_fee_test_support import actual_case,actual_operation
from test_registered_account_coverage import with_b,append_source_b
from test_cash_ledger import account as new_account


@pytest.mark.asyncio
@pytest.mark.parametrize('same_account,actual_known',[(False,True),(True,True),(False,False)])
async def test_account_only_spending_requires_its_own_actual_source_closure_and_never_uses_other_unknown_wealth(client,admin,app,old_pg,pg,tmp_path,same_account,actual_known):
    async with actual_case(client,admin,app,old_pg,pg,tmp_path) as (approved,hosted,grant,exported,account,fill,data):
        rows,_=await old_rows_from_target(approved,app.state.db,fill['tradeId'],old_pg.owners[0])
        if actual_known:assert (await actual_operation(approved,data))[0]['state']=='completed'
        extended=with_b(rows,same_account)
        await append_source_b(pg,old_pg,rows,extended)
        response=await approved.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':grant['grantRevision'],'predecessorHash':exported['manifestSha256']})
        assert response.status_code==200 and response.json()['headAdvanced'],response.text
        raw=(await approved.get('/api/legacy-financial/manifests/'+response.json()['manifestId']+'/raw')).content
        other=await new_account(approved,'Separate unknown pending-reference account')
        async with app.state.db.connection() as conn:
            await conn.execute("INSERT INTO broker_account_references VALUES(%s,%s,'order','unknown-original-pending','USD')",(admin,other))
        cash=(await approved.get('/api/cash/accounts/'+account)).json()['currencies'][0]
        assert not cash['ownerCashComplete']
        permitted=not same_account and actual_known
        assert cash['complete']==permitted
        async with app.state.db.connection() as conn:
            occurred=(await(await conn.execute('SELECT clock_timestamp() value')).fetchone())['value'].isoformat()
        base={'requestId':str(uuid4()),'accountId':account,'accountKind':'real','currency':'USD','action':'external_withdrawal','amount':'1','occurredAt':occurred}
        before=(await approved.get('/api/cash/accounts/'+account+'/entries')).json()
        preview=await approved.post('/api/cash/preview',json=base)
        if not permitted:
            assert preview.status_code==409 and preview.headers.get('x-alcor-financial-scope')=='incomplete',preview.text
            reconcile=await approved.post('/api/cash/preview',json={**base,'requestId':str(uuid4()),'action':'reconcile_balance','amount':'1000'})
            assert reconcile.status_code==409
            assert (await approved.get('/api/cash/accounts/'+account+'/entries')).json()==before
            return
        assert preview.status_code==200 and Decimal(preview.json()['balanceAfter'])==Decimal('897.89') and preview.json()['ownerCashAfter'] is None,preview.text
        assert (await approved.post('/api/cash/preview',json={**base,'requestId':str(uuid4()),'amount':'900'})).status_code==409
        body={'data':base,'preview':preview.json()['preview']}
        done=await approved.post('/api/cash/operations',json=body);assert done.status_code==200 and done.json()['state']=='completed',done.text
        assert Decimal(done.json()['balanceAfter'])==Decimal('897.89') and done.json()['ownerCashAfter'] is None
        assert (await approved.get('/api/cash/operations/'+base['requestId'])).json()==done.json()
        assert (await approved.post('/api/cash/operations',json=body)).json()==done.json()
        current=(await approved.get('/api/cash/accounts/'+account)).json()['currencies'][0]
        assert current['complete'] and Decimal(current['balance'])==Decimal('897.89') and not current['ownerCashComplete'],current
        reconcile={**base,'requestId':str(uuid4()),'action':'reconcile_balance','amount':'897.88'}
        p=await approved.post('/api/cash/preview',json=reconcile);assert p.status_code==200,p.text
        completed=await approved.post('/api/cash/operations',json={'data':reconcile,'preview':p.json()['preview']});assert completed.status_code==200,completed.text
        current=(await approved.get('/api/cash/accounts/'+account)).json()['currencies'][0]
        assert current['complete'] and Decimal(current['balance'])==Decimal('897.88') and not current['ownerCashComplete'],current
        allocation={**base,'requestId':str(uuid4()),'accountId':other,'action':'opening','openingBasis':'allocate_verified_unallocated_checkpoint','amount':'1'}
        assert (await approved.post('/api/cash/preview',json=allocation)).status_code==409
        assert (await approved.get('/api/legacy-financial/manifests/'+response.json()['manifestId']+'/raw')).content==raw
        async with app.state.db.connection() as conn:
            original=await(await conn.execute('SELECT fees,cash_delta FROM trade_ledger WHERE id=%s',(fill['tradeId'],))).fetchone()
            assert original=={'fees':Decimal(0),'cash_delta':Decimal(-100)}


@pytest.mark.asyncio
async def test_new_source_head_unknown_inside_a_revokes_old_cash_preview_even_without_cash_revision_change(client,admin,app,old_pg,pg,tmp_path):
    async with actual_case(client,admin,app,old_pg,pg,tmp_path) as (approved,hosted,grant,exported,account,fill,data):
        rows,_=await old_rows_from_target(approved,app.state.db,fill['tradeId'],old_pg.owners[0])
        assert (await actual_operation(approved,data))[0]['state']=='completed'
        async with app.state.db.connection() as conn:
            occurred=(await(await conn.execute('SELECT clock_timestamp() value')).fetchone())['value'].isoformat()
        command={'requestId':str(uuid4()),'accountId':account,'accountKind':'real','currency':'USD','action':'external_withdrawal','amount':'1','occurredAt':occurred}
        p=await approved.post('/api/cash/preview',json=command);assert p.status_code==200,p.text
        before=(await approved.get('/api/cash/accounts/'+account+'/entries')).json()
        await append_source_b(pg,old_pg,rows,with_b(rows,True))
        current=await approved.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':grant['grantRevision'],'predecessorHash':exported['manifestSha256']});assert current.status_code==200
        denied=await approved.post('/api/cash/operations',json={'data':command,'preview':p.json()['preview']})
        assert denied.status_code==409 and denied.headers.get('x-alcor-financial-scope')=='incomplete',denied.text
        assert (await approved.get('/api/cash/accounts/'+account+'/entries')).json()==before
        assert (await approved.get('/api/cash/operations/'+command['requestId'])).status_code==404
