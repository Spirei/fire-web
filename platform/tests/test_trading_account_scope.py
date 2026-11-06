from datetime import UTC,datetime
from decimal import Decimal
from uuid import uuid4
import pytest
from legacy_fee_source_fixture import old_pg,old_rows_from_target
from actual_fee_test_support import actual_case,actual_operation
from test_registered_account_coverage import with_b,append_source_b
from test_cash_ledger import command as cash_command,submit as cash_submit
from test_trading import command as trade_command,submit as trade_submit
from test_native_actual_fees import confirmation as actual_data,complete as confirm_actual


async def new_account(client,when):
    response=await client.post('/api/broker-accounts',json={'request_id':str(uuid4()),'name':'Independent platform account','provider_id':'longbridge','account_kind':'real','currency':'USD','currencies':['USD']});assert response.status_code==201,response.text
    aid=response.json()['data']['id']
    await cash_submit(client,cash_command(aid,amount='1000',occurredAt=when))
    p=await client.post('/api/portfolio/records/preview',json={'kind':'create','data':{'name':'Independent platform security','code':'INDEPENDENT','market':'US','price':None,'qty':'0','cost':'0','group':'','note':'','brokerAccountId':aid}});assert p.status_code==200,p.text
    done=await client.post('/api/portfolio/records/confirm',json={'previewId':p.json()['previewId'],'requestId':str(uuid4())});assert done.status_code==200,done.text
    return aid,done.json()['record']


@pytest.mark.asyncio
async def test_unresolved_original_account_cannot_block_independent_native_calculated_fill_and_actual_confirmation(client,admin,app,old_pg,pg,tmp_path):
    async with actual_case(client,admin,app,old_pg,pg,tmp_path) as (approved,hosted,grant,exported,source_a,source_fill,source_confirmation):
        # Original A retains its registered zero / actual unknown and source
        # identity. New B has its own explicit external opening, not A wealth.
        aid,record=await new_account(approved,'2026-09-01T12:00:01Z')
        data=trade_command(record,quantity='10',price='10',amount='100',fees='1.03',occurredAt='2026-09-02T12:00:00Z')
        data['feeInput']={'source':'rule_calculated','brokerAccountId':aid,'providerId':'longbridge','confirmed':True,'ruleVersion':'2026-10-23.1','instrumentKind':'us_domestic_equity','plan':{'effectiveFrom':'2025-07-01','effectiveThrough':'2026-10-23','overrides':{}}}
        original_raw=(await approved.get('/api/legacy-financial/manifests/'+exported['manifestId']+'/raw')).content
        posted,_=await trade_submit(approved,data)
        assert posted['state']=='completed' and posted['cashBefore']=='1000' and posted['cashAfter'] is None and posted['ownerCashAfter'] is None,posted
        confirmed,preview=await confirm_actual(approved,await actual_data(approved,aid,posted['tradeId'],'1.11'))
        assert confirmed['state']=='completed' and Decimal(preview['cashEffect']['delta'])==Decimal('-0.08')
        b=(await approved.get('/api/cash/accounts/'+aid)).json()['currencies'][0]
        assert b['complete'] and Decimal(b['balance'])==Decimal('898.89') and not b['ownerCashComplete'],b
        a=(await approved.get('/api/cash/accounts/'+source_a)).json()['currencies'][0]
        assert not a['complete'] and a['balance'] is None and not a['ownerCashComplete'],a
        denied=await approved.post('/api/trading/preview',json=trade_command(source_fill['record'],occurredAt=datetime.now(UTC).isoformat()))
        assert denied.status_code==409,denied.text
        # Ordinary actual B can continue independently. Original A is untouched.
        fresh=(await approved.get('/api/portfolio/records/'+record['id'])).json()['record']
        next_b,_=await trade_submit(approved,trade_command(fresh,fees='0',occurredAt=datetime.now(UTC).isoformat()))
        assert next_b['cashAfter']=='878.89' and next_b['ownerCashAfter'] is None,next_b
        assert (await approved.get('/api/legacy-financial/manifests/'+exported['manifestId']+'/raw')).content==original_raw
        async with app.state.db.connection() as conn:
            original=await(await conn.execute('SELECT fees,cash_delta FROM trade_ledger WHERE id=%s',(source_fill['tradeId'],))).fetchone()
            assert original=={'fees':Decimal(0),'cash_delta':Decimal(-100)}


@pytest.mark.asyncio
async def test_same_source_account_unimported_history_revokes_trade_preview_but_new_independent_account_remains_usable(client,admin,app,old_pg,pg,tmp_path):
    async with actual_case(client,admin,app,old_pg,pg,tmp_path) as (approved,hosted,grant,exported,source_a,source_fill,source_confirmation):
        assert (await actual_operation(approved,source_confirmation))[0]['state']=='completed'
        source_record=(await approved.get('/api/portfolio/records/'+source_fill['recordId'])).json()['record']
        command=trade_command(source_record,fees='0',occurredAt=datetime.now(UTC).isoformat())
        proof=await approved.post('/api/trading/preview',json=command);assert proof.status_code==200,proof.text
        rows,_=await old_rows_from_target(approved,app.state.db,source_fill['tradeId'],old_pg.owners[0])
        await append_source_b(pg,old_pg,rows,with_b(rows,True))
        response=await approved.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':grant['grantRevision'],'predecessorHash':exported['manifestSha256']});assert response.status_code==200 and response.json()['headAdvanced'],response.text
        async with app.state.db.connection() as conn:before=(await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']
        refused=await approved.post('/api/trading/operations',json={'data':command,'preview':proof.json()['preview']})
        assert refused.status_code==409 and refused.headers.get('x-alcor-financial-scope')=='incomplete',refused.text
        assert (await approved.get('/api/trading/operations/'+command['requestId'])).status_code==404
        async with app.state.db.connection() as conn:assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==before
        account,record=await new_account(approved,datetime.now(UTC).isoformat())
        data=trade_command(record,fees='0',occurredAt=datetime.now(UTC).isoformat())
        good,_=await trade_submit(approved,data)
        assert good['cashAfter']=='980' and good['ownerCashAfter'] is None,good
        bad=trade_command(record,quantity='101',price='10',amount='1010',fees='0',recordRevision=good['record']['revision'],occurredAt=datetime.now(UTC).isoformat())
        assert (await approved.post('/api/trading/preview',json=bad)).status_code==409
        a=(await approved.get('/api/cash/accounts/'+source_a)).json()['currencies'][0]
        assert a['balance'] is None and not a['complete'] and not a['ownerCashComplete']
