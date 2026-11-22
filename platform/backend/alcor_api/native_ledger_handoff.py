"""Capture faithfully representable pending orders at the owner-lane handoff."""

from fastapi import HTTPException

from .native_trade_sync import CURRENCIES

THRESHOLDS = {'trigger_buy': False, 'rebound_sell': False, 'trigger_sell': True, 'rebound_buy': True}

async def require_legacy_order(conn, owner, order_id):
    if await (await conn.execute(
        'SELECT 1 FROM native_ledger_transferred_orders WHERE owner_id=%s AND order_id=%s',
        (owner, order_id),
    )).fetchone():
        raise HTTPException(409, '委托已移交 App 原生账本，请重新读取')


async def pending(conn, owner, positions, *, lock):
    from .native_ledger import decimal_text, validate_ledger_order

    native = {}
    histories = {}
    transfers = {}
    numbers = {}
    blockers = []
    by_record = {position['recordId']: position for position in positions}
    rows = await (await conn.execute("""
        SELECT o.*,r.name,b.name AS broker,d.draft,d.confirmed_at,p.number AS order_number,
               f.order_id IS NOT NULL AS attached
        FROM internal_orders o
        LEFT JOIN portfolio_records r ON r.owner_id=o.owner_id AND r.id=o.record_id AND r.deleted_at IS NULL
        LEFT JOIN broker_accounts b ON b.owner_id=o.owner_id AND b.id=o.account_id AND b.deleted_at IS NULL
        LEFT JOIN internal_order_contexts d ON d.owner_id=o.owner_id AND d.order_id=o.id AND d.order_revision=o.revision
        LEFT JOIN trade_presentation_ids p ON p.owner_id=o.owner_id AND p.target_id=o.id AND p.target_kind='internal_order'
        LEFT JOIN internal_order_family_legs f ON f.owner_id=o.owner_id AND f.order_id=o.id
        WHERE o.owner_id=%s AND o.account_kind='real' AND o.status='pending' ORDER BY o.id
    """ + (" FOR UPDATE OF o" if lock else ""), (owner,))).fetchall()
    for row in rows:
        identifier = str(row['id'])
        record = by_record.get(row['record_id'])
        intent = row['draft'] or {}
        # A family cannot be rewritten as a set of independent orders.
        if (not record or not row['broker'] or not row['name'] or row['attached']
                or intent.get('attachments') or intent.get('familyId') or intent.get('parentOrderId')
                or intent.get('orderType') not in ({'limit', 'market'} | THRESHOLDS.keys())
                or record['brokerAccountId'] != row['account_id']
                or (record['market'], record['code'], record['accountMarket']) != (
                    row['record_market'], row['record_code'], row['record_account_market'] or row['record_market'])
                or row['currency'] != CURRENCIES.get(record['accountMarket'])):
            blockers.append({'tradeId': identifier, 'reason': 'legacy_order_intent_unverified'})
            continue
        price = decimal_text(row['limit_price'])
        order_type = intent['orderType']
        item = {
            'tradeId': identifier, 'recordId': row['record_id'], 'brokerAccountId': row['account_id'],
            'market': record['market'], 'accountMarket': record['accountMarket'], 'code': record['code'],
            'name': row['name'], 'broker': row['broker'], 'side': row['side'], 'status': 'pending',
            'execution': 'conditional', 'orderType': 'limit' if order_type in THRESHOLDS else order_type, 'orderPrice': price,
            'price': price, 'quantity': decimal_text(row['quantity']), 'fees': decimal_text(row['fees']),
            'priceCurrency': CURRENCIES[record['market']], 'createdAt': row['created_at'].isoformat(),
            **{key: intent[key] for key in ('tif', 'session', 'expiresAt') if intent.get(key) is not None},
        }
        if order_type in THRESHOLDS:
            item.update(triggerPrice=str(intent.get('triggerPrice') or price), triggerAbove=THRESHOLDS[order_type])
        try:
            validate_ledger_order(item)
        except (HTTPException, ValueError, TypeError):
            blockers.append({'tradeId': identifier, 'reason': 'legacy_order_precision_or_intent_unsupported'})
            continue
        revisions = await (await conn.execute("""
            SELECT before_revision,before_snapshot->>'quantity' AS qty,
                   before_snapshot->>'limit_price' AS price,before_snapshot->>'fees' AS fees
            FROM internal_order_actions WHERE owner_id=%s AND order_id=%s ORDER BY before_revision
        """, (owner, row['id']))).fetchall()
        old_contexts = await (await conn.execute("""
            SELECT order_revision,confirmed_at FROM internal_order_contexts
            WHERE owner_id=%s AND order_id=%s ORDER BY order_revision
        """, (owner, row['id']))).fetchall()
        dates = {entry['order_revision']: entry['confirmed_at'].isoformat() for entry in old_contexts}
        if [revision['before_revision'] for revision in revisions] != list(range(1, row['revision'])):
            blockers.append({'tradeId': identifier, 'reason': 'legacy_order_revision_chain_unverified'})
            continue
        histories[identifier] = [{
            'revision': rev['before_revision'], 'occurredAt': dates.get(rev['before_revision'], item['createdAt']),
            'status': 'pending',
            'quantity': rev['qty'], 'price': rev['price'], 'orderPrice': rev['price'], 'fees': rev['fees'],
        } for rev in revisions]
        histories[identifier].append({
            'revision': row['revision'], 'occurredAt': dates[row['revision']], 'status': 'pending',
            **{key: item[key] for key in ('quantity', 'price', 'orderPrice', 'fees')},
        })
        native[identifier] = item
        transfers[identifier] = row['revision']
        if row['order_number'] is not None:
            numbers[identifier] = str(row['order_number'])

    mirrors = await (await conn.execute("""
        SELECT order_id,item FROM native_synced_orders WHERE owner_id=%s AND status='pending' ORDER BY order_id
    """, (owner,))).fetchall()
    for row in mirrors:
        identifier = str(row['order_id'])
        item = row['item']
        record = by_record.get(item.get('recordId'))
        if (identifier in native or not record or not record['brokerAccountId'] or item.get('parentOrderId')
                or (record['market'], record['code'], record['accountMarket']) != (
                    item['market'], item['code'], item.get('accountMarket', item['market']))):
            blockers.append({'tradeId': identifier, 'reason': 'mirrored_order_identity_unverified'})
            continue
        native[identifier] = {**item, 'brokerAccountId': record['brokerAccountId']}
        histories[identifier] = [{
            'revision': 1, 'occurredAt': item['createdAt'], 'status': 'pending',
            **{key: item[key] for key in ('quantity', 'price', 'orderPrice', 'fees')},
        }]
    return list(native.values()), histories, transfers, blockers, numbers
