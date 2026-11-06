"""Verified immutable transfer openings, never holdings-derived or synthetic fills."""

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException

from .trade_accounting import Position


def uuid_or_none(value):
    return UUID(str(value)) if value is not None else None


async def attach_openings(conn, owner, records):
    selected = [record for record in records if record.get('position_transfer_id')]
    if not selected:
        return records
    ids = [record['position_transfer_id'] for record in selected]
    found = await (await conn.execute('''SELECT e.*,h.occurred_at,h.account_kind,
        h.quantity AS transfer_quantity,h.unit_cost AS transfer_cost,h.source_record_id,h.target_record_id,
        h.source_account_id,h.target_account_id,e.before_snapshot->>'qty' AS snapshot_quantity,
        e.before_snapshot->>'cost' AS snapshot_cost FROM broker_position_transfer_events e
        JOIN broker_position_transfers h ON h.owner_id=e.owner_id AND h.id=e.transfer_id
        WHERE e.owner_id=%s AND e.id=ANY(%s)''', (owner, ids))).fetchall()
    by_id = {row['id']: row for row in found}
    for record in selected:
        row = by_id.get(uuid_or_none(record['position_transfer_id']))
        if not row or row['record_id'] != record['id'] or row['account_id'] != record['broker_account_id'] or row['account_kind'] not in ('real', 'simulated'):
            raise HTTPException(409, '转仓期初与本人账户身份无法核对')
        q, cost = Decimal(row['transfer_quantity']), Decimal(row['transfer_cost'])
        before = row['before_snapshot']
        when = row['occurred_at']
        if (q <= 0 or not q.is_finite() or not cost.is_finite() or not isinstance(before, dict)
                or row['before_record_revision'] >= record['revision']
                or before.get('id') != record['id'] or before.get('broker_account_id') != row['account_id']
                or when.tzinfo is None):
            raise HTTPException(409, '转仓期初证据不完整')
        expected_record = row['source_record_id'] if row['direction'] == 'out' else row['target_record_id']
        expected_account = row['source_account_id'] if row['direction'] == 'out' else row['target_account_id']
        expected_after = (Decimal(0), Decimal(0)) if row['direction'] == 'out' else (q, cost)
        expected_before = (q, cost) if row['direction'] == 'out' else (Decimal(0), Decimal(0))
        if (row['direction'] not in ('out', 'in') or expected_record != record['id'] or expected_account != row['account_id']
                or (row['after_quantity'], row['after_cost']) != expected_after
                or (row['before_quantity'], row['before_cost']) != expected_before
                or Decimal(row['snapshot_quantity']) != row['before_quantity'] or Decimal(row['snapshot_cost']) != row['before_cost']):
            raise HTTPException(409, '转仓数量或原始成本无法核对')
        record['_position_opening'] = {
            'id': row['id'], 'transferId': row['transfer_id'], 'direction': row['direction'],
            'revision': row['before_record_revision'], 'at': when,
            'quantity': row['after_quantity'], 'cost': row['after_cost'],
            'previousTradeId': uuid_or_none(before.get('trade_tip_id')),
            # Displayed cost is not an economic moving-average opening.
            'economicCost': Decimal(0) if row['direction'] == 'out' else None, 'historicalRealizedPnlKnown': False,
        }
    return records


def opening(record):
    value = record.get('_position_opening')
    if record.get('position_transfer_id'):
        if not value or str(value.get('id')) != str(record['position_transfer_id']):
            raise ValueError('verified_transfer_opening_missing')
        return value
    return None


def current_rows(rows, record):
    boundary = opening(record)
    if boundary is None:
        return list(rows)
    result = [row for row in rows if row['before_record_revision'] > boundary['revision']]
    if result and rows:
        originals = min(rows, key=lambda row: row['before_record_revision'])
        if originals.get('_record_amendments'):
            result[0]['_record_amendments'] = originals['_record_amendments']
    for row in result:
        event = row.get('_effective_event') or row
        when = event['occurred_at']
        when = datetime.fromisoformat(when) if isinstance(when, str) else when
        if when < boundary['at']:
            raise ValueError('trade_precedes_verified_transfer_opening')
    return result


def initial_position(record):
    value = opening(record)
    return Position(Decimal(value['quantity']), Decimal(value['cost'])) if value else None


def assert_after_opening(record, row, when=None):
    boundary = opening(record)
    if boundary is not None and (row['before_record_revision'] <= boundary['revision'] or when is not None and when < boundary['at']):
        raise HTTPException(409, '旧成交或更正不能穿越已确认转仓；请独立核对转仓关联证据')


async def verify_current(conn, owner, record):
    """Validate only the causal suffix after the independently stored checkpoint."""
    await attach_openings(conn, owner, [record])
    if opening(record) is None:
        return None
    rows = await (await conn.execute('SELECT * FROM trade_ledger WHERE owner_id=%s AND record_id=%s ORDER BY before_record_revision LIMIT 10001', (owner, record['id']))).fetchall()
    if len(rows) > 10000:
        raise HTTPException(409, '转仓后成交核对范围超限')
    from .trade_amendment_history import attach_amendments
    from .trade_amendment_model import verify_physical
    await attach_amendments(conn, owner, rows)
    projections = await (await conn.execute('SELECT * FROM trade_fee_projections WHERE owner_id=%s AND record_id=%s', (owner, record['id']))).fetchall()
    amendments = rows[0].get('_record_amendments', ()) if rows else ()
    try:
        verify_physical(rows, record, projections, amendments)
    except ValueError:
        raise HTTPException(409, '转仓期初与当前成交接续无法核对') from None
    return opening(record)


def economic_initial(record, physical):
    boundary = opening(record)
    return Position(physical.quantity, boundary['economicCost']) if boundary else physical
