"""Idempotent, replay-verified baseline repair for already-adopted native ledgers."""

from collections import defaultdict
from copy import deepcopy
from decimal import ROUND_HALF_UP, Decimal, localcontext
from types import SimpleNamespace
from uuid import uuid4

from psycopg.types.json import Jsonb

from .broker_accounts import serialize_brokers
from .broker_metadata import fingerprint
from .native_ledger import cash_key, decimal_text, ledger_head, legacy_baseline, settlement
from .native_trade_sync import order_time

COST_QUANT = Decimal('0.00000001')


def _active_leaf_fills(snapshot):
    orders = {item['tradeId']: item for item in snapshot['orders']}
    candidates = [item for item in orders.values() if item['status'] == 'filled']
    leaves = []
    while candidates:
        item = candidates.pop()
        if item.get('mergedFromOrderIds'):
            candidates.extend(orders[identifier] for identifier in item['mergedFromOrderIds'])
        else:
            leaves.append({**item, 'status': 'filled'})
    leaves.sort(key=lambda item: (
        order_time(item.get('filledAt') or item['createdAt']),
        order_time(item['createdAt']),
        item['tradeId'],
    ))
    return leaves


async def repair_native_ledger_baseline(db, owner_id: str, *, apply: bool = False):
    """Backfill missing legacy unitCost and registered global cash into native_ledger_heads."""
    who = SimpleNamespace(id=owner_id)
    async with db.connection() as conn, conn.transaction():
        await serialize_brokers(conn, owner_id, shared_read=not apply)
        lock = 'FOR UPDATE' if apply else 'FOR SHARE'
        user = await (await conn.execute(f'SELECT active FROM users WHERE id=%s {lock}', (owner_id,))).fetchone()
        if not user:
            raise ValueError('账户不存在')
        head = await ledger_head(conn, owner_id)
        if not head:
            raise ValueError('账户尚未接入原生账本')
        baseline, _ = await legacy_baseline(conn, db, who, lock_orders=False)
        repaired = deepcopy(head['snapshot'])
        leaves = _active_leaf_fills(repaired)
        fills_by_record = defaultdict(list)
        cash_deltas = defaultdict(Decimal)
        position_updates = []
        cash_updates = []

        with localcontext() as context:
            context.prec = 80
            for fill in leaves:
                fills_by_record[fill['recordId']].append(fill)
                (_, currency), _, money_delta = settlement(fill)
                cash_deltas[currency] += money_delta

            base_positions = {item['recordId']: item for item in baseline['positions']}
            for pos in repaired['positions']:
                if pos.get('unitCost') is not None:
                    continue
                base = base_positions.get(pos['recordId'])
                if base is None or base.get('unitCost') is None:
                    continue
                fills = fills_by_record.get(pos['recordId'], [])
                if not fills:
                    if pos.get('quantity') != base.get('quantity'):
                        raise ValueError(f"无原生交易持仓数量与基线不一致: {pos['recordId']}")
                    new_cost = base['unitCost']
                else:
                    if base.get('quantity') is None:
                        raise ValueError(f"基线持仓数量未知: {pos['recordId']}")
                    qty = Decimal(base['quantity'])
                    unit_cost = Decimal(base['unitCost'])
                    for fill in fills:
                        fill_qty = Decimal(fill['quantity'])
                        fill_price = Decimal(fill['price'])
                        fill_fees = Decimal(fill['fees'])
                        gross = Decimal(fill['grossAmount']) if fill.get('mergedFromOrderIds') else fill_qty * fill_price
                        if fill['side'] == 'buy':
                            next_qty = qty + fill_qty
                            unit_cost = (qty * unit_cost + gross + fill_fees) / next_qty
                            qty = next_qty
                        elif fill['side'] == 'sell':
                            next_qty = qty - fill_qty
                            if next_qty < 0:
                                raise ValueError(f"成交重放出现负持仓: {pos['recordId']}")
                            if next_qty > 0:
                                raise ValueError(f"含卖出减仓的缺失成本持仓需人工核对口径: {pos['recordId']}")
                            qty = next_qty
                            unit_cost = None
                        else:
                            raise ValueError(f"不支持的成交方向: {fill['side']}")
                    if Decimal(pos['quantity']) != qty:
                        raise ValueError(f"重放后持仓数量与账本不一致: {pos['recordId']}")
                    new_cost = (
                        decimal_text(unit_cost.quantize(COST_QUANT, rounding=ROUND_HALF_UP))
                        if unit_cost is not None else None
                    )
                if new_cost is not None:
                    pos['unitCost'] = new_cost
                    position_updates.append({
                        'recordId': pos['recordId'], 'market': pos['market'], 'code': pos['code'],
                        'unitCostBefore': None, 'unitCostAfter': new_cost,
                    })

            cash_map = {cash_key(item): item for item in repaired['cash']}
            for base_cash in baseline['cash']:
                if base_cash.get('brokerAccountId') is not None or base_cash.get('balance') is None:
                    continue
                currency = base_cash['currency']
                key = (None, currency)
                existing = cash_map.get(key)
                if existing is not None and existing.get('balance') is not None:
                    continue
                repaired_balance = decimal_text(Decimal(base_cash['balance']) + cash_deltas[currency])
                cash_map[key] = {'currency': currency, 'brokerAccountId': None, 'balance': repaired_balance}
                cash_updates.append({
                    'currency': currency, 'balanceBefore': None, 'balanceAfter': repaired_balance,
                })
            repaired['cash'] = sorted(
                cash_map.values(),
                key=lambda row: (row.get('brokerAccountId') or '', row['currency']),
            )

        changed = bool(position_updates or cash_updates)
        if not changed or not apply:
            return {
                'ownerId': owner_id, 'changed': changed, 'applied': False,
                'revision': head['revision'],
                'nextRevision': head['revision'] + 1 if changed else head['revision'],
                'positionUpdates': position_updates, 'cashUpdates': cash_updates,
            }

        request_id = uuid4()
        next_revision = head['revision'] + 1
        event = {
            'requestId': str(request_id), 'kind': 'repair_baseline',
            'baseRevision': head['revision'],
            'positionUpdates': position_updates, 'cashUpdates': cash_updates,
        }
        receipt = {
            'ownerId': owner_id, 'requestId': str(request_id),
            'kind': 'repair_baseline', 'sourceRevision': next_revision,
        }
        await conn.execute('''
            UPDATE native_ledger_heads
            SET revision=%s, snapshot=%s, updated_at=clock_timestamp()
            WHERE owner_id=%s
        ''', (next_revision, Jsonb(repaired), owner_id))
        await conn.execute(
            "INSERT INTO asset_request_domains(owner_id,request_id,domain) VALUES(%s,%s,'native_ledger')",
            (owner_id, request_id),
        )
        await conn.execute('''
            INSERT INTO native_ledger_transactions(owner_id,request_id,revision,fingerprint,event,receipt)
            VALUES(%s,%s,%s,%s,%s,%s)
        ''', (owner_id, request_id, next_revision, fingerprint(event), Jsonb(event), Jsonb(receipt)))
        return {
            'ownerId': owner_id, 'changed': True, 'applied': True,
            'requestId': str(request_id), 'previousRevision': head['revision'],
            'revision': next_revision,
            'positionUpdates': position_updates, 'cashUpdates': cash_updates,
        }
