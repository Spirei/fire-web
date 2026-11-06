from datetime import datetime,UTC
from decimal import Decimal,localcontext
import pytest
from alcor_api.estimate_model import BaselineError,assess

PLAN={'effectiveFrom':'2025-05-14','effectiveThrough':'2026-10-20','confirmed':True}

def history():
    row={'id':'canonical','source':'unverified_legacy','side':'buy','quantity':Decimal(10),'price':Decimal(10),'amount':Decimal(100),'fees':Decimal(0),'currency':'USD','settlement_currency':'USD','settlement_amount':None,'cash_delta':Decimal(-100),'before_quantity':Decimal(0),'before_cost':Decimal(0),'after_quantity':Decimal(10),'after_cost':Decimal(10),'previous_trade_id':None,'occurred_at':datetime(2026,9,1,tzinfo=UTC)}
    old={**row,'id':'old-order','registered_fee':'0','registered_cash_delta':'-100','actual_fee_known':False}
    return [old],[row]


def test_estimate_is_named_and_never_makes_actual_fee_cost_cash_or_pnl_known():
    old,rows=history();value=assess('longbridge',PLAN,'us_domestic_equity',old,rows,{'old-order'},registered_target_cash='900')
    assert value['orders']['old-order']['fee']=='1.03'
    assert value['estimated']['cost']=='10.103' and value['estimated']['accountCashAfter']=='898.97'
    assert value['actual']=={'feesKnown':False,'cost':None,'realizedPnl':None,'cashBalance':None}
    assert not value['financialApplied'] and value['authority']=='rule_calculated'
    assert rows[0]['fees']==0 and rows[0]['after_cost']==10


@pytest.mark.parametrize('change',['missing_registered','actual_zero','cash_mismatch','position_mismatch'])
def test_estimated_lane_rejects_unknown_registration_actual_zero_and_unproved_prefix(change):
    old,rows=history()
    if change=='missing_registered':old[0]['registered_fee']=None
    elif change=='actual_zero':old[0]['actual_fee_known']=True
    elif change=='cash_mismatch':old[0]['registered_cash_delta']='-101'
    else:old[0]['after_cost']='11'
    with pytest.raises(BaselineError):assess('longbridge',PLAN,'us_domestic_equity',old,rows,{'old-order'},registered_target_cash='900')


def test_outside_unknown_scope_keeps_estimated_account_total_unknown():
    old,rows=history();value=assess('longbridge',PLAN,'us_domestic_equity',old,rows,{'old-order'},registered_target_cash='900',unknown_outside_record=True)
    assert value['estimated']['cost']=='10.103' and value['estimated']['accountCashAfter'] is None
    assert value['actual']['cashBalance'] is None


def test_projection_is_independent_of_process_decimal_precision():
    old,rows=history();values=[]
    for precision in (6,28,80):
        with localcontext() as context:
            context.prec=precision
            values.append(assess('longbridge',PLAN,'us_domestic_equity',old,rows,{'old-order'},registered_target_cash='900'))
    assert values[0]==values[1]==values[2]


def test_nonterminating_estimated_pnl_is_stable_and_actual_does_not_become_known():
    old,rows=history();rows[0].update(quantity=Decimal(3),price=Decimal(1),amount=Decimal(3),cash_delta=Decimal(-3),after_quantity=Decimal(3),after_cost=Decimal(1))
    old[0].update(quantity=Decimal(3),price=Decimal(1),amount=Decimal(3),registered_cash_delta=Decimal(-3),after_quantity=Decimal(3),after_cost=Decimal(1))
    sell={**rows[0],'id':'sell','source':'owner_recorded','previous_trade_id':'canonical','side':'sell','quantity':Decimal(1),'price':Decimal(2),'amount':Decimal(2),'cash_delta':Decimal(2),'before_quantity':Decimal(3),'before_cost':Decimal(1),'after_quantity':Decimal(2),'after_cost':Decimal('.5'),'occurred_at':datetime(2026,9,2,tzinfo=UTC)}
    source_sell={**sell,'id':'old-sell','registered_fee':'0','registered_cash_delta':'2','actual_fee_known':True}
    values=[]
    for precision in (6,28,80):
        with localcontext() as context:
            context.prec=precision
            values.append(assess('longbridge',PLAN,'us_domestic_equity',[old[0],source_sell],[rows[0],sell],{'old-order'},registered_target_cash='99'))
    assert values[0]==values[1]==values[2]
    assert values[0]['actual']['realizedPnl'] is None
    assert values[0]['estimated']['realizedPnl'].startswith('0.663333333333333333333333333333')
