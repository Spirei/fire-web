"""Pure registered-book comparison and explicitly estimated projections.

None is never replaced by zero. A rate scenario does not establish actual fees,
actual cost, actual cash or actual P&L, and never mutates a financial ledger.
"""
from decimal import Decimal,localcontext,InvalidOperation
from alcor_api.fee_rules import VERSION,reconstruct
from alcor_api.trade_accounting import Position,FilledTrade,apply_filled_trade,replay_economic_trades


class BaselineError(ValueError):pass


def number(value):
    if value is None:raise BaselineError('registered_value_unknown')
    try:result=Decimal(str(value))
    except (ValueError,TypeError,InvalidOperation):raise BaselineError('registered_value_invalid') from None
    if not result.is_finite():raise BaselineError('registered_value_invalid')
    return result


def event(row,fee):
    return FilledTrade(row['side'],number(row['quantity']),number(row['price']),fee,number(row['amount']),row['currency'],row['settlement_currency'],None if row.get('settlement_amount') is None else number(row['settlement_amount']))


def verify_prefix(source,target):
    if not source or len(source)!=len(target):raise BaselineError('full_registered_prefix_required')
    with localcontext() as context:
        context.prec=80
        position=Position(number(source[0]['before_quantity']),number(source[0]['before_cost']))
        if position.quantity!=0 or target[0]['previous_trade_id'] is not None:raise BaselineError('independent_zero_opening_required')
        previous=None;times=set();cash=Decimal(0)
        for old,row in zip(source,target):
            if old['occurred_at'] in times:raise BaselineError('original_equal_time_order_unknown')
            times.add(old['occurred_at'])
            if row['previous_trade_id']!=previous:raise BaselineError('canonical_prefix_lineage_mismatch')
            for key in ('side','currency','settlement_currency','occurred_at'):
                if old[key]!=row[key]:raise BaselineError('source_canonical_identity_mismatch')
            for key in ('quantity','price','amount','before_quantity','before_cost','after_quantity','after_cost'):
                if number(old[key])!=number(row[key]):raise BaselineError('source_canonical_registered_value_mismatch')
            if (old.get('settlement_amount') is None)!=(row.get('settlement_amount') is None) or old.get('settlement_amount') is not None and number(old['settlement_amount'])!=number(row['settlement_amount']):raise BaselineError('source_settlement_amount_mismatch')
            fee=number(old['registered_fee'])
            if fee!=number(row['fees']):raise BaselineError('registered_fee_baseline_mismatch')
            if number(old['before_quantity'])!=position.quantity or number(old['before_cost'])!=position.cost:raise BaselineError('source_prefix_lineage_mismatch')
            applied=apply_filled_trade(position,event(row,fee))
            if applied.position.quantity!=number(old['after_quantity']) or applied.position.cost!=number(old['after_cost']):raise BaselineError('registered_projection_mismatch')
            if applied.cash!=number(old['registered_cash_delta']) or applied.cash!=number(row['cash_delta']):raise BaselineError('registered_cash_projection_mismatch')
            position=applied.position;cash+=applied.cash;previous=row['id']
        return {'quantity':str(position.quantity),'registeredCost':str(position.cost),'registeredTradeCashDelta':str(cash),'actualCost':None,'actualRealizedPnl':None}


def assess(provider,plan,kind,source,target,selected,*,registered_target_cash,unknown_outside_record=False):
    registered=verify_prefix(source,target)
    estimates={};excluded=[]
    with localcontext() as context:
        context.prec=80
        for old,row in zip(source,target):
            if old['id'] not in selected:continue
            if old['actual_fee_known'] is not False:raise BaselineError('explicit_actual_fee_is_protected')
            if number(old['registered_fee'])!=0 or row['source'] not in ('unverified_legacy','legacy_import_zero') or number(row['fees'])!=0:
                raise BaselineError('existing_registered_zero_required')
            when=old['occurred_at'].date().isoformat()
            try:value=reconstruct(provider,when,row['side'],row['quantity'],row['price'],kind,plan)
            except ValueError:
                excluded.append({'orderId':old['id'],'reason':'rule_evidence_unknown'});continue
            if value.get('fees') is None and not value.get('reason'):
                excluded.append({'orderId':old['id'],'reason':'rule_amount_unknown'});continue
            if value.get('reason'):
                excluded.append({'orderId':old['id'],'reason':value['reason']});continue
            estimates[old['id']]={'fee':value['fees'],'components':value['components'],'authority':'rule_calculated','actualFeeKnown':False}
        actual_events=[];estimated_events=[];fee_adjustment=Decimal(0);complete=True
        for old,row in zip(source,target):
            actual_fee=number(old['registered_fee']) if old['actual_fee_known'] else None
            proposed=estimates.get(old['id'])
            estimated_fee=number(proposed['fee']) if proposed else actual_fee
            if estimated_fee is None:complete=False
            actual_events.append(event(row,actual_fee));estimated_events.append(event(row,estimated_fee))
            if proposed:fee_adjustment+=number(proposed['fee'])-number(old['registered_fee'])
        initial=Position(number(source[0]['before_quantity']),number(source[0]['before_cost']))
        actual=replay_economic_trades(initial,actual_events)
        estimated=replay_economic_trades(initial,estimated_events)
        position=initial
        for value in estimated_events:position=apply_filled_trade(position,value).position
        unknown=any(not old['actual_fee_known'] for old in source)
        actual_values={'feesKnown':not unknown,'cost':None if unknown or actual.position.cost is None else str(actual.position.cost),'realizedPnl':None if unknown or actual.realized_pnl is None else str(actual.realized_pnl),'cashBalance':None}
        projected={'authority':'rule_calculated','complete':complete,'cost':None if not complete or position.cost is None else str(position.cost),'realizedPnl':None if not complete or estimated.realized_pnl is None else str(estimated.realized_pnl),'selectedFeeAdjustment':str(-fee_adjustment),'accountCashAfter':None if not complete or unknown_outside_record else str(number(registered_target_cash)-fee_adjustment)}
        return {'ruleVersion':VERSION,'financialApplied':False,'authority':'rule_calculated','actualFeeKnown':False,'registered':{**registered,'targetBookCash':str(number(registered_target_cash)),'basis':'existing_canonical_registered_book'},'actual':actual_values,'estimated':projected,'orders':estimates,'excluded':excluded}
