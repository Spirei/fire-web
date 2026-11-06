"""Read-only end-of-period comparison, never replay a statement as trade history."""
from decimal import Decimal

from fastapi import HTTPException

from .broker_metadata import fingerprint
from .portfolio_records import number, record_dto


def comparison(statement, records, account_id):
    bound, unassigned = {}, {}
    for row in records:
        key = row['market'] + ':' + row['code']
        if row['broker_account_id'] == account_id:
            if key in bound:
                raise HTTPException(409, '账户内有重复证券，请先核对')
            if row['market'] not in ('US', 'HK', 'CN') or row['qty'] is not None and row['qty'] < 0:
                raise HTTPException(422, '账户现有持仓范围或数量无法核对')
            bound[key] = row
        elif row['broker_account_id'] is None:
            unassigned.setdefault(key, []).append(row['id'])
    rows, missing, blockers = [], [], []
    source_keys = set()
    for position in statement['positions']:
        key = position['key']; source_keys.add(key)
        old = bound.get(key)
        for field in ('qty', 'price', 'cost'):
            try:
                number(position[field], negative=field == 'cost')
            except HTTPException:
                blockers.append({'security': key, 'reason': 'source_numeric_precision_not_supported', 'field': field})
        rows.append({**position, 'recordId': old['id'] if old else None,
                     'before': record_dto(old) if old else None,
                     'action': 'update' if old else 'create',
                     'unassignedMatches': sorted(unassigned.get(key, []))})
    for key, old in bound.items():
        if key in source_keys:
            continue
        if old['qty'] is None:
            missing.append({'recordId': old['id'], 'security': key, 'before': None, 'after': None, 'action': 'unresolved'})
            blockers.append({'security': key, 'reason': 'existing_quantity_unknown'})
        elif Decimal(old['qty']) > 0:
            missing.append({'recordId': old['id'], 'security': key, 'before': format(old['qty'], 'f'), 'after': '0', 'action': 'close_snapshot_position'})
    return {'rows': rows, 'missing': missing, 'blockers': blockers,
            'requiresUnassignedAcknowledgement': any(row['unassignedMatches'] for row in rows),
            'historicalEventsReplayed': False, 'financialEffect': 'none'}


async def prepare_comparison(conn, owner, account, statement):
    records = await (await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 10001', (owner,))).fetchall()
    if len(records) > 10000:
        raise HTTPException(409, '记录范围超过完整核对上限，未生成不完整差异')
    collection = await (await conn.execute('SELECT revision FROM portfolio_record_collections WHERE owner_id=%s', (owner,))).fetchone()
    plan = comparison(statement, records, account['id'])
    plan['recordCollectionRevision'] = collection['revision'] if collection else 0
    plan['accountRevision'] = account['revision']
    plan['accountKind'] = account['account_kind']
    # Include the exact owned record metadata, including source/history/revisions.
    plan['recordProof'] = fingerprint([record_dto(row) for row in records])
    return plan
