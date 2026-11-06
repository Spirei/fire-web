from decimal import Decimal
from uuid import uuid4
import copy
import pytest
from legacy_fee_source_fixture import old_pg
from actual_fee_test_support import actual_case,actual_operation


@pytest.mark.asyncio
@pytest.mark.parametrize('paid,expected_cost,expected_cash',[('1.11','10.111','898.89'),('0','10','900')])
async def test_explicit_actual_payment_is_independent_of_estimate_and_uses_one_atomic_original_uuid(client,admin,app,old_pg,pg,tmp_path,paid,expected_cost,expected_cash):
    async with actual_case(client,admin,app,old_pg,pg,tmp_path,fee=paid) as (approved,hosted,grant,exported,account,fill,data):
        spoofed=copy.deepcopy(data);spoofed['confirmations'][0]['authority']='broker_reported'
        assert (await approved.post('/api/fees/confirmations/preview',json=spoofed)).status_code==422
        result,preview=await actual_operation(approved,data)
        assert result['state']=='completed' and result['financialApplied'] and result['actualFeeKnown'] and result['authority']=='owner_recorded',result
        assert preview['candidates'][0]['newFees']==paid and Decimal(preview['positionEffects'][0]['afterCost'])==Decimal(expected_cost)
        assert Decimal(preview['cashEffect']['brokerAfter'])==Decimal(expected_cash) and preview['cashEffect']['after'] is None
        row=(await approved.get('/api/trading/fills',params={'recordId':fill['recordId']})).json()['items'][0]
        assert row['fees']==paid and row['feeSource']=='owner_recorded' and row['actualFeeKnown'] and Decimal(row['cash_delta'])==-(Decimal(100)+Decimal(paid)),row
        assert Decimal(row['registeredCashDelta'])==Decimal('-100') and row['feeDetail']['source']=='owner_recorded' and row['feeDetail']['ruleVersion'] is None
        record=(await approved.get('/api/portfolio/records/'+fill['recordId'])).json()['record']
        assert Decimal(record['cost'])==Decimal(expected_cost),record
        cash=(await approved.get('/api/cash/accounts/'+account)).json()['currencies'][0]
        assert cash['complete'] and Decimal(cash['balance'])==Decimal(expected_cash) and not cash['ownerCashComplete'],cash
        assert (await approved.get('/api/fees/confirmations/operations/'+data['requestId'])).json()==result
        assert (await approved.post('/api/fees/confirmations/operations',json={'data':data,'preview':preview['previewRevision']})).json()==result
        changed=copy.deepcopy(data);changed['confirmations'][0]['actualFee']='1.12'
        assert (await approved.post('/api/fees/confirmations/operations',json={'data':changed,'preview':preview['previewRevision']})).status_code==409
        async with app.state.db.connection() as conn:
            original=await(await conn.execute('SELECT fees,cash_delta FROM trade_ledger WHERE id=%s',(fill['tradeId'],))).fetchone()
            assert original=={'fees':Decimal(0),'cash_delta':Decimal(-100)}
            assert (await(await conn.execute('SELECT count(*) n FROM actual_fee_confirmations')).fetchone())['n']==1
            assert (await(await conn.execute("SELECT sum(amount) amount FROM cash_ledger_entries WHERE kind='fee_correction'")).fetchone())['amount']==-Decimal(paid)
