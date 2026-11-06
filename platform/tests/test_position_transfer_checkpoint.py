"""Pure checkpoint vectors; transferred openings never become synthetic fills."""
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from alcor_api.fee_repair_model import effective_projection, eligibility, replay
from alcor_api.position_transfer_checkpoint import assert_after_opening, economic_initial
from alcor_api.trade_accounting import Position
from alcor_api.trade_amendment_model import replay_events, verify_physical
from fastapi import HTTPException

AT = datetime(2026, 1, 1, tzinfo=UTC)


def transfer_record(*, direction='in'):
    pointer = uuid4()
    return {'id': 'synthetic-record', 'position_transfer_id': pointer, 'revision': 3,
            'trade_tip_id': None, 'qty': Decimal(10), 'cost': Decimal(20),
            '_position_opening': {'id': pointer, 'transferId': uuid4(), 'direction': direction,
                                  'revision': 1, 'at': AT, 'quantity': Decimal(10), 'cost': Decimal(20),
                                  'previousTradeId': None, 'economicCost': None}}


def sale():
    return {'id': uuid4(), 'record_id': 'synthetic-record', 'before_record_revision': 2,
            'before_quantity': Decimal(10), 'before_cost': Decimal(20), 'previous_trade_id': None,
            'side': 'sell', 'quantity': Decimal(4), 'price': Decimal(25), 'amount': Decimal(100),
            'fees': Decimal(1), 'currency': 'USD', 'settlement_currency': 'USD', 'settlement_amount': None,
            'occurred_at': AT+timedelta(days=1), 'created_at': AT+timedelta(days=1, seconds=1),
            'after_quantity': Decimal(6), 'after_cost': Decimal('16.667'), 'realized_pnl': None,
            'source': 'owner_recorded'}


def test_first_sale_uses_verified_registered_cost_without_inventing_economic_opening():
    record, row = transfer_record(), sale()
    record.update(qty=Decimal(6), cost=Decimal('16.667'), trade_tip_id=row['id'])
    initial, events = replay([row], record, {}, [])
    assert initial == Position(Decimal(10), Decimal(20)) and len(events) == 1
    projection = effective_projection([row], record, {}, [])
    assert projection[row['id']]['after_quantity'] == Decimal(6)
    assert projection[row['id']]['after_cost'] == Decimal('16.667')
    assert projection[row['id']]['realized_pnl'] is None
    from alcor_api.trade_amendment_model import event
    changed = replay_events([event(row)], initial, verified_opening=True, economic_initial=economic_initial(record, initial))
    assert changed.position.quantity == Decimal(6) and changed.realized is None and changed.cash == Decimal(99)


def test_out_checkpoint_preserves_original_fill_without_replaying_it_as_a_sale():
    record, old = transfer_record(direction='out'), sale()
    old.update(side='buy', quantity=Decimal(10), price=Decimal(20), amount=Decimal(200), fees=Decimal(0),
               before_record_revision=1, before_quantity=Decimal(0), before_cost=Decimal(0),
               after_quantity=Decimal(10), after_cost=Decimal(20))
    record.update(qty=Decimal(0), cost=Decimal(0), trade_tip_id=old['id'], revision=5)
    record['_position_opening'].update(revision=3, quantity=Decimal(0), cost=Decimal(0), previousTradeId=old['id'],
                                        economicCost=Decimal(0), at=AT+timedelta(days=2))
    initial, events = replay([old], record, {}, [])
    assert initial == Position(Decimal(0), Decimal(0)) and events == []
    projection = effective_projection([old], record, {}, [])
    assert projection[old['id']]['projectionScope'] == 'pre_transfer_original_registration'
    assert projection[old['id']]['after_quantity'] == Decimal(10)
    with pytest.raises(HTTPException) as error:
        assert_after_opening(record, old)
    assert error.value.status_code == 409
    assert eligibility(old, record, {}, {}, None, False, None) == 'immutable_position_transfer_boundary'


def test_missing_checkpoint_or_backdated_new_fill_is_never_derived_from_holdings():
    record, row = transfer_record(), sale()
    record.update(qty=row['after_quantity'], cost=row['after_cost'], trade_tip_id=row['id'])
    del record['_position_opening']
    with pytest.raises(ValueError):
        verify_physical([row], record)
    record = transfer_record()
    row['occurred_at'] = AT-timedelta(seconds=1)
    with pytest.raises(ValueError):
        verify_physical([row], record)
