from decimal import Decimal
from uuid import uuid4
import pytest
from test_fee_repairs import seed,operation
from test_trading import setup,command as trade_command


async def calculated_case(client,db):
    other,record=await setup(client,name='Independent actual zero account B',code='B')
    account,first=await seed(client,db,legacy=False,explicit_zero=True)
    # Same-account currencies are independent; zero here is explicitly entered.
    row=(await client.get('/api/broker-accounts/'+account)).json()
    changed=await client.put('/api/broker-accounts/'+account,json={'request_id':str(uuid4()),'revision':row['revision'],'name':row['name'],'currency':'USD','currencies':['USD','HKD']});assert changed.status_code==200,changed.text
    await operation(client,'/api/cash',{'requestId':str(uuid4()),'accountId':account,'accountKind':'real','currency':'HKD','action':'opening','amount':'0','occurredAt':'2026-01-01T00:00:00Z','openingBasis':'new_external_opening'})
    b=trade_command(record,quantity='1',price='10',amount='10',fees='0',occurredAt='2026-09-01T12:00:00Z')
    b['feeInput']={'source':'owner_recorded','brokerAccountId':other,'providerId':None,'confirmed':True}
    bdone=await operation(client,'/api/trading',b)
    data={'requestId':str(uuid4()),'recordId':first['recordId'],'recordRevision':first['record']['revision'],'side':'buy','quantity':'10','price':'10','amount':'100','fees':'1.03','currency':'USD','settlementCurrency':'USD','occurredAt':'2026-09-02T12:00:00Z','confirmedActualFill':True,'feeInput':{'source':'rule_calculated','brokerAccountId':account,'providerId':'longbridge','confirmed':True,'ruleVersion':'2026-10-23.1','instrumentKind':'us_domestic_equity','plan':{'effectiveFrom':'2025-07-01','effectiveThrough':'2026-10-23','overrides':{}}}}
    proof=await client.post('/api/trading/preview',json=data);assert proof.status_code==200,proof.text
    done=await client.post('/api/trading/operations',json={'data':data,'preview':proof.json()['preview']});assert done.status_code==200,done.text
    return account,first,data,done.json(),proof.json(),other,bdone


async def original_finance(db):
    async with db.connection() as conn:
        return {table:await(await conn.execute('SELECT * FROM '+table+' ORDER BY 1')).fetchall() for table in ('trade_ledger','cash_ledger_entries','trade_fee_details','trade_operations')}


@pytest.mark.asyncio
async def test_calculated_fee_is_registered_not_actual_cash_cost_or_profit_and_other_scope_zero_stays_real(client,admin,db):
    aid,first,data,done,proof,other,b=await calculated_case(client,db)
    before=await original_finance(db)
    cash=(await client.get('/api/cash/accounts/'+aid)).json()
    usd=next(row for row in cash['currencies'] if row['currency']=='USD')
    hkd=next(row for row in cash['currencies'] if row['currency']=='HKD')
    assert usd['balance'] is None and not usd['complete'],usd
    assert Decimal(usd['registeredBalance'])==Decimal('798.97')
    assert hkd['balance']=='0' and hkd['complete'],hkd
    independent=(await client.get('/api/cash/accounts/'+other)).json()['currencies'][0]
    assert independent['complete'] and independent['balance']=='990',independent
    own=(await client.get('/api/portfolio/records/'+first['recordId'])).json()['record']
    assert own['cost'] is None and Decimal(own['registeredCost'])==Decimal('10.052')
    listing=(await client.get('/api/trading/fills',params={'recordId':first['recordId']})).json()
    estimated=next(row for row in listing['items'] if row['id']==done['tradeId'])
    assert estimated['fees'] is None and not estimated['actualFeeKnown'] and estimated['estimatedFees']=='1.03'
    assert estimated['feeSource']=='rule_calculated' and estimated['cash_delta'] is None and Decimal(estimated['registeredCashDelta'])==Decimal('-101.03')
    assert estimated['after_cost'] is None and estimated['realized_pnl'] is None
    known=(await client.get('/api/trading/fills',params={'recordId':b['recordId']})).json()['items'][0]
    assert Decimal(known['fees'])==0 and known['feesKnown'] and known['feeDetail']['source']=='owner_recorded'
    assert Decimal((await client.get('/api/portfolio/records/'+b['recordId'])).json()['record']['cost'])==10
    # Registration and evidence stay byte-for-byte facts; reads do not fix history.
    assert await original_finance(db)==before


@pytest.mark.asyncio
async def test_future_writes_never_spend_estimated_actual_cash_and_independent_actual_zero_account_is_not_limited(client,admin,db):
    from test_cash_ledger import command as cash_command
    aid,first,data,done,proof,other,b=await calculated_case(client,db)
    assert proof['actualFeeKnown'] is False and done['actualFeeKnown'] is False
    assert proof['cashDelta'] is None and proof['cashAfter'] is None and proof['costAfter'] is None
    assert done['cashDelta'] is None and done['cashAfter'] is None and done['record']['cost'] is None
    assert proof['cashBefore']==done['cashBefore']=='900'
    for action in ('external_withdrawal','reconcile_balance'):
        denied=await client.post('/api/cash/preview',json=cash_command(aid,action,'1',occurredAt='2026-09-03T12:00:00Z'))
        assert denied.status_code==409 and denied.headers.get('x-alcor-financial-scope')=='incomplete',denied.text
    own=(await client.get('/api/portfolio/records/'+first['recordId'])).json()['record']
    new_trade=trade_command(own,quantity='1',price='10',amount='10',fees='0',occurredAt='2026-09-03T12:00:00Z')
    assert (await client.post('/api/trading/preview',json=new_trade)).status_code==409
    other_record=(await client.get('/api/portfolio/records/'+b['recordId'])).json()['record']
    independent=trade_command(other_record,quantity='1',price='10',amount='10',fees='0',occurredAt='2026-09-03T12:00:00Z')
    posted=await operation(client,'/api/trading',independent)
    assert posted['cashAfter']=='980' and posted['ownerCashAfter'] is None
    from test_internal_orders import command as order_command
    reserved=await client.post('/api/trading/orders/preview',json=order_command(posted['record']))
    assert reserved.status_code==200,reserved.text
    fees=(await client.get('/api/fees/repairs',params={'brokerAccountId':aid})).json()
    unverified=next(row for row in fees['items'] if row['orderId']==done['tradeId'])
    assert unverified['fees'] is None and not unverified['actualFeeKnown'] and unverified['estimatedFees']=='1.03'
    from test_fee_repairs import request as repair_request
    reviewed=await client.post('/api/fees/repairs/preview',json=await repair_request(client,admin,aid))
    assert reviewed.status_code==200,reviewed.text
    assert reviewed.json()['cashEffect']['before'] is None and reviewed.json()['cashEffect']['brokerBefore'] is None
    assert not reviewed.json()['canSubmit']
    history=(await client.get('/api/cash/accounts/'+aid+'/entries')).json()
    item=next(row for row in history['items'] if row['sourceTradeId']==done['tradeId'])
    assert item['feeAuthority']=='rule_calculated' and item['actualFeeKnown'] is False
    # Existing confirmation route only covers independently bound original zero;
    # the new native estimate is not silently enrolled or set to paid zero.
    snapshot=(await client.get('/api/fees/confirmations',params={'brokerAccountId':aid})).json()
    assert snapshot['items']==[]
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM actual_fee_confirmations')).fetchone()
        raw=await(await conn.execute('SELECT fees,cash_delta,source FROM trade_ledger WHERE id=%s',(done['tradeId'],))).fetchone()
        assert raw=={'fees':Decimal('1.03'),'cash_delta':Decimal('-101.03'),'source':'owner_recorded'}


@pytest.mark.asyncio
async def test_independent_real_dividend_credit_cannot_make_previous_estimated_cost_or_aggregate_actual_cash_known(client,admin,db):
    from test_notification_composition import statement
    aid,first,data,done,proof,other,b=await calculated_case(client,db)
    own=(await client.get('/api/portfolio/records/'+first['recordId'])).json()['record']
    income=statement(own,eventReference='real-independent-income-with-unverified-estimated-fee',occurredAt='2026-09-03T12:00:00Z')
    p=await client.post('/api/dividends/receipts/preview',json=income);assert p.status_code==200,p.text
    assert Decimal(p.json()['cashDelta'])==8 and p.json()['cashAfter'] is None and p.json()['costAfter'] is None
    body={'data':income,'preview':p.json()['preview']}
    receipt=await client.post('/api/dividends/receipts/operations',json=body);assert receipt.status_code==200,receipt.text
    assert Decimal(receipt.json()['cashDelta'])==8 and receipt.json()['cashAfter'] is None and receipt.json()['record']['cost'] is None
    assert (await client.get('/api/dividends/receipts/operations/'+income['requestId'])).json()==receipt.json()
    cash=(await client.get('/api/cash/accounts/'+aid)).json()['currencies'][0]
    assert not cash['complete'] and cash['balance'] is None and Decimal(cash['registeredBalance'])==Decimal('806.97')
    current=(await client.get('/api/portfolio/records/'+first['recordId'])).json()['record']
    assert current['cost'] is None and Decimal(current['registeredCost'])==Decimal('10.052')
    fills=(await client.get('/api/trading/fills',params={'recordId':first['recordId']})).json()['items']
    dividend=next(row for row in fills if row['side']=='dividend')
    assert dividend['after_cost'] is None and dividend['realized_pnl'] is None
    assert Decimal(dividend['fees'])==2 and Decimal(dividend['cash_delta'])==8


@pytest.mark.asyncio
async def test_existing_unverified_nonzero_fee_stays_unknown_instead_of_using_nonzero_as_actual_proof(client,admin,db):
    aid,record=await setup(client,name='Synthetic existing unverified nonzero fee')
    # The existing-old-row fixture uses only this verified disposable PG;
    # it is not an import/authority route and does not claim migration complete.
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT current_database() name')).fetchone())['name'].startswith('alcor_test_')
        await conn.execute("ALTER TABLE trade_ledger ALTER COLUMN source SET DEFAULT 'unverified_legacy'")
    try:
        data=trade_command(record,quantity='1',price='10',amount='10',fees='1',occurredAt='2026-09-01T12:00:00Z')
        recorded=await operation(client,'/api/trading',data)
    finally:
        async with db.connection() as conn:await conn.execute("ALTER TABLE trade_ledger ALTER COLUMN source SET DEFAULT 'owner_recorded'")
    before=await original_finance(db)
    cash=(await client.get('/api/cash/accounts/'+aid)).json()['currencies'][0]
    assert cash['balance'] is None and not cash['complete'] and cash['registeredBalance']=='989',cash
    row=(await client.get('/api/trading/fills',params={'recordId':record['id']})).json()['items'][0]
    assert row['fees'] is None and not row['actualFeeKnown'] and row['registeredCashDelta']=='-11'
    own=(await client.get('/api/portfolio/records/'+record['id'])).json()['record']
    assert own['cost'] is None and Decimal(own['registeredCost'])==11
    assert (await client.get('/api/fees/confirmations',params={'brokerAccountId':aid})).json()['items']==[]
    assert await original_finance(db)==before
