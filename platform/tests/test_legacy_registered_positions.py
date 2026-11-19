from datetime import datetime, timezone

import pytest

from alcor_api import legacy_registered_positions as positions


def original(*later):
    sale = {
        'id': 'sale', 'record_id': 'old', 'status': 'filled', 'side': 'sell', 'qty': '3',
        'position_qty_before': '3', 'position_qty_after': '0', 'market': 'US', 'code': 'WIRE',
        'created_at': '2026-11-05T15:00:00Z',
    }
    orders = [sale, *later]
    return {'source_sha256': 'synthetic-source', 'originals': {
        'timezone': 'America/New_York', 'orders': orders,
        'maps': {'records': {'old': 'current'}},
        'normalized_orders': {
            order['id']: {'occurredAt': order['created_at'], 'accountKind': 'real'} for order in orders
        },
    }}


def test_registered_sale_can_close_an_unknown_quantity_without_overwriting_current_state(monkeypatch):
    monkeypatch.setattr(positions, 'native_fields', lambda *_: {})
    monkeypatch.setattr(positions, '_closing_cache', positions.OrderedDict())
    source = original()
    row = {'id': 'current', 'market': 'US', 'code': 'WIRE', 'qty': None, 'trade_tip_id': None,
           'position_transfer_id': None, 'broker_account_id': 'manual'}
    accounts = {'manual': {'account_kind': 'real'}}
    now = datetime(2026, 11, 10, tzinfo=timezone.utc)
    assert positions.registered_closures(source, 'owner', [row], {'current': {}}, accounts, now) == {
        'current': datetime(2026, 11, 5, 15, tzinfo=timezone.utc),
    }
    assert row['qty'] is None
    for change in [{'qty': 1}, {'trade_tip_id': 'new'}, {'position_transfer_id': 'new'}, {'code': 'OTHER'}]:
        assert positions.registered_closures(source, 'owner', [row | change], {'current': {}}, accounts, now) == {}
    assert positions.registered_closures(source, 'owner', [row], {'current': {'officialObservation': True}}, accounts, now) == {}
    accounts['manual']['account_kind'] = 'simulated'
    assert positions.registered_closures(source, 'owner', [row], {'current': {}}, accounts, now) == {}


@pytest.mark.parametrize('stamp', ['2026-11-06T15:00:00Z', '2026-11-05T15:00:00Z', None])
def test_later_equal_or_undated_fill_prevents_a_migrated_sale_from_proving_close(monkeypatch, stamp):
    monkeypatch.setattr(positions, 'native_fields', lambda *_: {})
    buy = {'id': 'buy', 'record_id': 'old', 'status': 'filled', 'side': 'buy', 'created_at': stamp}
    assert positions.confirmed_last_sales(original(buy)) == {}


def test_unverified_archive_cannot_supply_closing_dates(monkeypatch):
    monkeypatch.setattr(positions, 'native_fields', lambda *_: None)
    assert positions.confirmed_last_sales(original()) == {}
