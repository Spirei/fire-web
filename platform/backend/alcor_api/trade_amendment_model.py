"""One exact effective trade history for amendments and ordinary trading reads/writes.

Raw fills, original cash and original receipts remain immutable. An amendment
changes an effective event through append-only owner evidence, not a broker fill.
"""
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, localcontext
from uuid import UUID

from .trade_accounting import (
    AccountingError,
    FilledTrade,
    Position,
    apply_filled_trade,
    number,
    replay_economic_trades,
)


class HistoryError(ValueError):pass


def packed(value):
    if isinstance(value,Decimal):return str(value)
    if isinstance(value,datetime):return value.isoformat()
    if isinstance(value,UUID):return str(value)
    if isinstance(value,dict):return {key:packed(item) for key,item in value.items()}
    if isinstance(value,(list,tuple)):return [packed(item) for item in value]
    return value


def event(row,fees=None):
    if fees is None:fees=row['fees']
    if fees is None:raise HistoryError('actual_fee_unknown')
    when=row['occurred_at']
    if isinstance(when,str):when=datetime.fromisoformat(when)
    if when.tzinfo is None:raise HistoryError('source_timezone_unknown')
    created=row['created_at']
    if isinstance(created,str):created=datetime.fromisoformat(created)
    if created.tzinfo is None:raise HistoryError('source_creation_timezone_unknown')
    return {'id':str(row['id']),'side':row['side'],'quantity':number(row['quantity']),'price':number(row['price']),'amount':number(row['amount']),'fees':number(fees),'currency':row['currency'],'settlement_currency':row['settlement_currency'],'settlement_amount':None if row['settlement_amount'] is None else number(row['settlement_amount']),'occurred_at':when,'created_at':created}


def filled(item):
    return FilledTrade(item['side'],item['quantity'],item['price'],item['fees'],item['amount'],item['currency'],item['settlement_currency'],item['settlement_amount'])


@dataclass
class Replay:
    position:Position
    realized:Decimal | None
    rows:list
    cash:Decimal


def replay_events(events,initial=None,*,verified_opening=False,economic_initial=None):
    """No holdings-derived opening, ambiguous time sort or ambient precision."""
    with localcontext() as precision:
        precision.prec=80
        return _replay(events,initial or Position(Decimal(0),Decimal(0)),verified_opening=verified_opening,economic_initial=economic_initial)


def _replay(events,initial,*,verified_opening=False,economic_initial=None):
    if not verified_opening and (initial.quantity!=0 or initial.cost not in (0,None)):raise HistoryError('independently_verified_position_opening_required')
    events=sorted(events,key=lambda item:(item['occurred_at'],item['created_at']))
    keys=[(row['occurred_at'],row['created_at']) for row in events]
    if len(set(keys))!=len(keys):raise HistoryError('historical_causal_order_unproved')
    if len({row['id'] for row in events})!=len(events):raise HistoryError('effective_trade_identity_reused')
    position=initial;result=[];cash=Decimal(0);economic=[]
    try:
        economic_initial=initial if economic_initial is None else economic_initial
        replay_economic_trades(economic_initial,[filled(item) for item in events],on_step=economic.append)
        previous_pnl=None if economic_initial.quantity and economic_initial.cost is None else Decimal(0)
        for item,pnl in zip(events,economic):
            before=position;effect=apply_filled_trade(position,filled(item));position=effect.position
            if effect.cash is None or position.cost is None or (pnl.realized_pnl is None and not verified_opening):raise HistoryError('effective_economics_unknown')
            number(position.quantity);number(position.cost,negative=True)
            cash+=effect.cash
            result.append({**item,'before_quantity':before.quantity,'before_cost':before.cost,'after_quantity':position.quantity,'after_cost':position.cost,'realized_pnl':None if item['side']=='buy' or pnl.realized_pnl is None or previous_pnl is None else pnl.realized_pnl-previous_pnl,'cash_delta':effect.cash})
            previous_pnl=pnl.realized_pnl
    except AccountingError as error:raise HistoryError(str(error)) from None
    return Replay(position,previous_pnl,result,cash)


def verify_physical(rows,record,fee_projections=(),amendments=()):
    """Validate each original row plus every recorded projection boundary.

    Projection evidence permits later original fills to begin from corrected
    quantities/costs, while never changing an earlier physical row.
    """
    with localcontext() as precision:
        precision.prec=80
        from .position_transfer_checkpoint import current_rows, initial_position, opening
        boundary=opening(record)
        rows=sorted(current_rows(rows,record),key=lambda row:row['before_record_revision'])
        if boundary is None:
            if not rows:raise HistoryError('original_filled_history_missing')
            if rows[0]['before_quantity']!=0 or rows[0]['previous_trade_id'] is not None:raise HistoryError('independent_position_opening_missing')
            initial=Position(rows[0]['before_quantity'],rows[0]['before_cost']);tip=None;revision=0
        else:
            initial=initial_position(record);tip=boundary['previousTradeId'];revision=boundary['revision']
            fee_projections=[row for row in fee_projections if row['before_record_revision']>revision]
            amendments=[row for row in amendments if row['before_record_revision']>revision]
        position=initial
        projections=sorted([({**row,'_amendment':False}) for row in fee_projections]+[({**row,'_amendment':True}) for row in amendments],key=lambda row:row['before_record_revision']);index=0
        def apply_projection(projection):
            nonlocal position,revision
            quantity=projection['before_quantity'] if projection['_amendment'] else projection['quantity']
            if projection['trade_tip_id']!=tip or projection['before_record_revision']<=revision or quantity!=position.quantity or projection['before_cost']!=position.cost:raise HistoryError('projection_original_lineage_mismatch')
            position=Position(projection['after_quantity'] if projection['_amendment'] else projection['quantity'],projection['after_cost']);revision=projection['before_record_revision']
        for row in rows:
            while index<len(projections) and projections[index]['before_record_revision']<row['before_record_revision']:
                apply_projection(projections[index]);index+=1
            if row['previous_trade_id']!=tip or row['before_record_revision']<=revision or row['before_quantity']!=position.quantity or row['before_cost']!=position.cost:raise HistoryError('raw_fill_lineage_mismatch')
            position=apply_filled_trade(position,filled(event(row))).position
            if position.quantity!=row['after_quantity'] or position.cost!=row['after_cost']:raise HistoryError('original_fill_projection_mismatch')
            tip=row['id'];revision=row['before_record_revision']
        while index<len(projections):apply_projection(projections[index]);index+=1
        if record['trade_tip_id']!=tip or record['qty']!=position.quantity or record['cost']!=position.cost:raise HistoryError('current_record_projection_mismatch')
        return initial
