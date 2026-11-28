"""Evidence for reversing migrated registrations already in the opening book."""

from collections import defaultdict
from decimal import Decimal, localcontext

from .database_migration_history import cells
from .ledger_events import latest_checkpoint
from .legacy_registered_cash import book_from_original, registered_book_source
from .native_ledger import ITEM_LIMIT, cash_key, conflict, decimal_text, legacy_baseline, position_identity, settlement, text
from .native_ledger_repair import active_leaf_fills
from .native_trade_sync import CURRENCIES, order_time
from .portfolio_records import symbol


def selected_ids(value):
    if not isinstance(value, list) or not 1 <= len(value) <= ITEM_LIMIT:
        raise ValueError
    ids = [text(item, 200) for item in value]
    if len(set(ids)) != len(ids):
        raise ValueError
    return ids


async def voided_references(conn, owner):
    head = await (await conn.execute(
        "SELECT snapshot->'registeredOrderVoids' AS voids FROM native_ledger_heads WHERE owner_id=%s",
        (owner,),
    )).fetchone()
    return {(item['sourceFingerprint'], item['id'])
            for item in (head['voids'] or {}).values()} if head else set()


def imported_fill(row, normalized, packet):
    record = packet['maps']['records'][row['record_id']]
    broker = packet['maps']['accounts'][normalized['sourceAccountId']]
    return {
        'id': row['id'], 'recordId': record, 'brokerAccountId': broker,
        'market': row['market'], 'accountMarket': row['market'], 'code': symbol(row['code'], row['market']),
        'currency': normalized['currency'], 'side': row['side'],
        'quantity': row['qty'], 'price': row['price'], 'fees': row['fees'],
        'orderNo': row['order_no'], 'tradedAt': normalized['occurredAt'],
    }


async def evidence(conn, db, who, head, ids):
    if not head:
        conflict('请先完成原生账本接管')
    snapshot = head['snapshot']
    prior_voids = snapshot.get('registeredOrderVoids', {})
    if set(ids) & prior_voids.keys():
        conflict('所选订单已有核销回执，请刷新订单')
    source = await registered_book_source(conn, who.id)
    checkpoint = await latest_checkpoint(conn, who.id)
    if (not source or not checkpoint or checkpoint['source_sha256'] != source['source_sha256']
            or checkpoint['source_authority'] != 'sealed_legacy_registered_book_checkpoint'):
        conflict('该订单缺少已固化的原始账本依据')

    with localcontext() as context:
        context.prec = 80
        try:
            book = book_from_original(source)
            packet = source['originals']
            raw = packet['raw_snapshot']
            proof_tables = ('records', 'broker_cash_order_links', 'trade_correction_originals',
                            'trade_correction_replacements', 'app_trade_metadata')
            if book['accountKind'] != 'real' or any(raw['tables'][name]['present'] is not True for name in proof_tables):
                conflict('历史现金归属或订单关系缺少已封存依据')
            linked = {row['order_id'] for name in proof_tables[1:-1] for row in cells(raw, name)}
            for row in cells(raw, 'app_trade_metadata'):
                if row['parent_id']:
                    linked.update((row['order_id'], row['parent_id']))
            if set(ids) & linked:
                conflict('所选历史成交有关联资金或订单，须先核对关联')
            proof = await prepare_evidence(conn, db, who, head, ids, packet, prior_voids)
            for item in proof['cash']:
                currency = item['currency']
                if Decimal(checkpoint['cash_balances'][currency]) != book['balances'][currency]:
                    conflict('固化现金与原始登记口径不同，须先核对入账依据')
            return {**proof, 'sourceFingerprint': source['source_sha256']}
        except (ValueError, TypeError, KeyError, ArithmeticError):
            conflict('原始成交、持仓或现金依据不齐，无法提交核销')


async def prepare_evidence(conn, db, who, head, ids, packet, prior_voids):
    duplicate = await (await conn.execute('''
        SELECT 1 FROM financial_import_links WHERE owner_id=%s AND source_instance=%s
          AND source_owner=%s AND object_kind IN ('cash','order') LIMIT 1
        ''', (who.id, packet['source_instance'], packet['source_owner']))).fetchone()
    if duplicate:
        conflict('历史成交另有金融入账，须先核对重复归属')
    archive_orders = {row['id']: row for row in packet['orders']}
    snapshot = head['snapshot']
    if any(identifier not in archive_orders for identifier in ids) or set(ids) & {row['tradeId'] for row in snapshot['orders']}:
        conflict('本人原始订单已变化，请刷新订单')
    case_groups = defaultdict(list)
    archived = {}
    for identifier in ids:
        row = archive_orders[identifier]
        normalized = packet['normalized_orders'][identifier]
        fill = imported_fill(row, normalized, packet)
        if (row['status'] != 'filled' or row['side'] not in ('buy', 'sell')
                or normalized['accountKind'] != 'real' or normalized['settlementCurrency'] != fill['currency']
                or CURRENCIES.get(fill['market']) != fill['currency']
                or row['settlement_amount'] is not None):
            conflict('这笔历史成交须先核对实际结算与持仓归属')
        case_groups[row['record_id']].append(row)
        archived[identifier] = fill

    archived_positions = {row['id']: row for row in cells(packet['raw_snapshot'], 'records')}
    current = {row['recordId']: row for row in snapshot['positions']}
    baseline, _ = await legacy_baseline(conn, db, who)
    baseline_positions = {row['recordId']: row for row in baseline['positions']}
    baseline_cash = {cash_key(row): row['balance'] for row in baseline['cash']}
    current_cash = {cash_key(row): row['balance'] for row in snapshot['cash']}
    native_fills = active_leaf_fills(snapshot)
    positions, cash_deltas = [], defaultdict(Decimal)
    for source_record, selected in case_groups.items():
        ordered = sorted((row for row in archive_orders.values()
                          if row['record_id'] == source_record and row['status'] == 'filled'
                          and row['side'] in ('buy', 'sell')),
                         key=lambda row: order_time(packet['normalized_orders'][row['id']]['occurredAt']))
        effective = [row for row in ordered if row['id'] not in prior_voids]
        suffix = effective[-len(selected):]
        if {row['id'] for row in suffix} != {row['id'] for row in selected}:
            conflict('所选历史成交后还有迁入成交，须由最近一笔开始核对')
        last = ordered[-1]
        original = archived_positions[source_record]
        record_id = packet['maps']['records'][source_record]
        base, now = baseline_positions[record_id], current[record_id]
        original_qty = Decimal(original['qty'])
        original_cost = Decimal(original['cost'])
        if (Decimal(last['position_qty_after']) != original_qty
                or Decimal(last['position_cost_after']) != original_cost
                or Decimal(base['quantity']) != original_qty
                or position_identity(base) != position_identity(now)):
            conflict('旧持仓与接管基线不一致，须先核对持仓数量和成本')
        if any(Decimal(a['position_qty_after']) != Decimal(b['position_qty_before'])
               or Decimal(a['position_cost_after']) != Decimal(b['position_cost_before'])
               for a, b in zip(suffix, suffix[1:])):
            conflict('所选历史成交的前后持仓记录不连续')
        before = Decimal(suffix[-1]['position_qty_after'])
        corrected = Decimal(suffix[0]['position_qty_before'])
        restored_cost = Decimal(suffix[0]['position_cost_before']) if corrected else None
        for row in suffix:
            fill = archived[row['id']]
            quantity, gross, fee = Decimal(row['qty']), Decimal(row['amount']), Decimal(row['fees'])
            quantity_delta = quantity if row['side'] == 'buy' else -quantity
            if (position_identity(fill) != position_identity(now) or quantity <= 0
                    or gross != quantity * Decimal(row['price']) or not 0 <= fee <= gross
                    or Decimal(row['position_qty_after']) - Decimal(row['position_qty_before']) != quantity_delta):
                conflict('原始成交金额或数量与持仓记录不一致')
            cash_deltas[fill['currency']] += gross + fee if row['side'] == 'buy' else fee - gross
        for fill in native_fills:
            if fill['recordId'] != record_id:
                continue
            if fill['side'] != 'sell' or position_identity(fill) != position_identity(now):
                conflict('原生账本中还有买入或不同归属的成交，须核对成本后核销')
            _, movement, _ = settlement(fill)
            before += movement
            corrected += movement
            if min(before, corrected) < 0:
                conflict('历史成交核销会使持仓数量为负')
        if before != Decimal(now['quantity']):
            conflict('原始持仓和后续成交与当前数量不一致')
        if corrected < before and any(
            item['recordId'] == record_id and item['side'] == 'sell' and item['status'] == 'pending'
            for item in snapshot['orders']
        ):
            conflict('核销会减少可卖数量，须先核对在途卖单')
        if restored_cost is None and corrected > 0:
            conflict('剩余持仓缺少历史成本依据')
        current_cost = now['unitCost']
        prior_cost = suffix[-1]['position_cost_after']
        if before and current_cost is not None and Decimal(current_cost) != Decimal(prior_cost):
            conflict('当前成本已经单独核准，须先核对后再核销历史成交')
        positions.append({
            **{key: now[key] for key in ('recordId', 'market', 'accountMarket', 'brokerAccountId', 'name', 'code')},
            'quantityBefore': decimal_text(before), 'quantityDelta': decimal_text(corrected - before),
            'unitCostBefore': current_cost, 'unitCostAfter': decimal_text(restored_cost if corrected else None),
        })

    cash = []
    for currency, delta in sorted(cash_deltas.items()):
        key = (None, currency)
        baseline_amount = Decimal(baseline_cash[key])
        expected = baseline_amount + sum(settlement(fill)[2] for fill in native_fills if settlement(fill)[0][1] == currency)
        expected += sum(Decimal(item['cashDelta']) for item in prior_voids.values() if item['currency'] == currency)
        if expected != Decimal(current_cash[key]):
            conflict('当前原币现金与期初及后续入账不一致，须先核对')
        cash.append({'currency': currency, 'balanceBefore': current_cash[key], 'delta': decimal_text(delta)})
    return {'ownerId': who.id, 'sourceRevision': head['revision'],
            'orders': [archived[identifier] for identifier in ids], 'positions': positions, 'cash': cash}


def apply_void(state, proof, positions, cash, request_id, now):
    expected_positions = {row['recordId']: row for row in proof['positions']}
    expected_cash = {(None, row['currency']): row for row in proof['cash']}
    if positions.keys() != expected_positions.keys() or cash.keys() != expected_cash.keys():
        conflict('核销须一并确认全部持仓及原币现金变更')
    for key, row in positions.items():
        expected = expected_positions[key]
        if (position_identity(row) != position_identity(expected) or row['name'] != expected['name']
                or Decimal(row['quantityBefore']) != Decimal(expected['quantityBefore'])
                or Decimal(row['quantityAfter']) != Decimal(expected['quantityBefore']) + Decimal(expected['quantityDelta'])
                or row['unitCostAfter'] != expected['unitCostAfter']):
            conflict('提交的持仓与原始成交核对结果不一致')
    for key, row in cash.items():
        expected = expected_cash[key]
        if (Decimal(row['balanceBefore']) != Decimal(expected['balanceBefore'])
                or Decimal(row['balanceAfter']) != Decimal(expected['balanceBefore']) + Decimal(expected['delta'])):
            conflict('提交的原币现金与原始成交核对结果不一致')
    voids = dict(state.get('registeredOrderVoids', {}))
    for fill in proof['orders']:
        quantity, price, fee = Decimal(fill['quantity']), Decimal(fill['price']), Decimal(fill['fees'])
        delta = quantity * price + fee if fill['side'] == 'buy' else fee - quantity * price
        voids[fill['id']] = {**fill, 'cashDelta': decimal_text(delta), 'sourceFingerprint': proof['sourceFingerprint'],
                             'requestId': str(request_id), 'voidedAt': now.isoformat()}
    return {
        **state, 'registeredOrderVoids': voids,
        'positions': [{**row, 'quantity': positions[row['recordId']]['quantityAfter'],
                       'unitCost': positions[row['recordId']]['unitCostAfter']}
                      if row['recordId'] in positions else row for row in state['positions']],
        'cash': [{**row, 'balance': cash[cash_key(row)]['balanceAfter']}
                 if cash_key(row) in cash else row for row in state['cash']],
    }
