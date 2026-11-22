"""Project an adopted App ledger through the published asset read contracts."""

from copy import deepcopy
from decimal import Decimal

from .broker_metadata import fingerprint
from .native_ledger import MAX_REVISION, cash_key
from .native_trade_sync import order_projection


def collection_revision(legacy, head):
    if not head:
        return legacy
    return min(MAX_REVISION, (1 << 52) + legacy + head['revision'])


def position_rows(rows, head):
    if not head:
        return rows
    existing = {row['id']: row for row in rows}
    changed = {order['recordId'] for order in head['snapshot']['orders']
               if order.get('deletedFrom', order['status']) == 'filled'}
    for item in head['snapshot']['positions']:
        identifier = item['recordId']
        if identifier not in changed:
            continue
        original = existing.get(identifier, {})
        existing[identifier] = {
            'group_name': '', 'watch_group_id': None, 'watch_group_sort': 0, 'note': '',
            'history_state': 'native', 'price': None, 'amendment_tip_id': None,
            **original, 'id': identifier, 'name': item['name'], 'code': item['code'],
            'market': item['market'], 'account_market': item['accountMarket'],
            'broker_account_id': item['brokerAccountId'], 'qty': Decimal(item['quantity']),
            'cost': Decimal(item['unitCost']) if item['unitCost'] is not None else None,
            'revision': collection_revision(original.get('revision', 0), head),
            'source': 'native_ledger', 'updated_at': head['updated_at'],
            'trade_tip_id': None, 'position_transfer_id': None,
            '_holding_source': 'manual' if item['brokerAccountId'] else None,
            'account_kind': 'real', '_native_ledger_position': True,
        }
    return list(existing.values())


def positions_with_brokers(rows, head, accounts):
    return [
        {**row, 'group_name': accounts.get(row['broker_account_id'], {}).get('name', row['group_name'])}
        if row.get('_native_ledger_position') else row
        for row in position_rows(rows, head)
    ]


def visible_orders(head):
    if not head:
        return []
    state = head['snapshot']
    history = state.get('orderHistory', {})
    numbers = state.get('orderNumbers', {})
    return [order_projection(order, history=history.get(order['tradeId']), order_number=numbers.get(order['tradeId']))
            for order in state['orders'] if order['status'] != 'deleted']


def financial_orders(head):
    """A presentation merge leaves each actual execution on its own trade date."""
    orders = {order['tradeId']: order for order in head['snapshot']['orders']}
    numbers = head['snapshot'].get('orderNumbers', {})
    candidates = [order for order in orders.values() if order['status'] == 'filled']
    results = []
    while candidates:
        order = candidates.pop()
        if order.get('mergedFromOrderIds'):
            candidates.extend(orders[identifier] for identifier in order['mergedFromOrderIds'])
        else:
            results.append(order_projection({**order, 'status': 'filled'}, order_number=numbers.get(order['tradeId'])))
    return results


def merge_orders(legacy, head):
    if not head:
        return legacy
    native_ids = {order['tradeId'] for order in head['snapshot']['orders']}
    return [order for order in legacy if order['id'] not in native_ids] + visible_orders(head)


def cash_overview(overview, head):
    if not head:
        return overview
    value = deepcopy(overview)
    cash = {cash_key(item): item['balance'] for item in head['snapshot']['cash']}
    real = next(book for book in value['books'] if book['accountKind'] == 'real')
    legacy = {row['currency']: row for row in real['currencies']}
    real['currencies'] = []
    for (broker, currency), balance in sorted(cash.items(), key=lambda entry: entry[0][1]):
        if broker is not None:
            continue
        relevant = [amount for (account, code), amount in cash.items() if account is not None and code == currency]
        attributed = sum(map(Decimal, relevant), Decimal(0)) if all(amount is not None for amount in relevant) else None
        unallocated = Decimal(balance) - attributed if balance is not None and attributed is not None else None
        real['currencies'].append({
            **legacy.get(currency, {}), 'currency': currency, 'ownerBalance': balance,
            'openingKnown': balance is not None, 'complete': balance is not None,
            'registeredOwnerBalance': balance, 'registeredAttributedBalance': str(attributed) if attributed is not None else None,
            'unallocatedBalance': str(unallocated) if unallocated is not None else None,
            'registeredUnallocatedBalance': str(unallocated) if unallocated is not None else None,
            'availableOwnerBalance': None, 'reservedBuyCash': None, 'reservationsComplete': False,
            'externalBuyingPowerKnown': False, 'authority': 'app_native_ledger',
        })
    value['snapshotRevision'] = fingerprint({'legacy': overview['snapshotRevision'], 'native': head['revision']})
    return value


def broker_cash_snapshot(value, head):
    if not head or (value['accountKind'], value['holdingSource']) != ('real', 'manual'):
        return value
    from .legacy_cash_read import money

    balances = {item['currency']: item['balance'] for item in head['snapshot']['cash']
                if item['brokerAccountId'] == value['brokerAccountId']}
    rows = []
    for row in value['currencies']:
        if row['currency'] in balances:
            balance = money(balances[row['currency']])
            row = {**row, 'balance': balance, 'registeredBalance': balance,
                   'state': 'ready' if balance is not None else row['state'],
                   'complete': balance is not None, 'activity': None,
                   'ledgerWithdrawalCapacity': {**row['ledgerWithdrawalCapacity'],
                       'amount': None, 'reservedBuyCash': None, 'complete': False}}
        rows.append(row)
    return {**value, 'currencies': rows, 'coverageScope': 'app_native_ledger',
            'globalCashRevision': fingerprint({'legacy': value['globalCashRevision'], 'native': head['revision']}),
            'snapshotRevision': fingerprint({'legacy': value['snapshotRevision'], 'native': head['revision']})}
