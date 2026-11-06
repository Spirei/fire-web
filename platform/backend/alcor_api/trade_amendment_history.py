"""Attach immutable amendment evidence while retaining every original physical field."""
from fastapi import HTTPException

from .trade_amendment_model import HistoryError, event, replay_events, verify_physical


async def attach_amendments(conn,owner,rows):
    if not rows:return rows
    records=sorted({row['record_id'] for row in rows})
    amendments=await(await conn.execute('SELECT * FROM trade_amendments WHERE owner_id=%s AND record_id=ANY(%s) ORDER BY before_record_revision LIMIT 10001',(owner,records))).fetchall()
    if len(amendments)>10000:raise HTTPException(409,'更正链超出本次核对范围')
    ids=[row['id'] for row in amendments]
    members=await(await conn.execute('SELECT * FROM trade_correction_members WHERE owner_id=%s AND amendment_id=ANY(%s) ORDER BY amendment_id,trade_id',(owner,ids))).fetchall() if ids else []
    by_amendment={}
    for member in members:by_amendment.setdefault(member['amendment_id'],[]).append(member)
    by_record={};latest={}
    for amendment in amendments:
        by_record.setdefault(amendment['record_id'],[]).append(amendment)
        amendment['_members']=by_amendment.get(amendment['id'],[])
        for member in amendment['_members']:latest[member['trade_id']]=(amendment,member)
    first_by_record={}
    for row in rows:
        first=first_by_record.get(row['record_id'])
        if first is None or row['before_record_revision']<first['before_record_revision']:first_by_record[row['record_id']]=row
    for record,first in first_by_record.items():
        if record in by_record:first['_record_amendments']=by_record[record]
    for row in rows:
        if row['id'] in latest:
            amendment,member=latest[row['id']];row['_latest_amendment']=amendment;row['_effective_inactive']=member['disposition']!='retained'
            if not row['_effective_inactive']:row['_effective_event']=amendment['replacement']
    return rows


def amended_replay(rows,record,corrections,projections):
    amendments=rows[0].get('_record_amendments',()) if rows else ()
    initial=verify_physical(rows,record,projections,amendments)
    from .position_transfer_checkpoint import current_rows, economic_initial, opening
    rows=current_rows(rows,record)
    changed=effective_events(rows,corrections)
    result=replay_events(changed,initial,verified_opening=opening(record) is not None,economic_initial=economic_initial(record,initial))
    if result.position.quantity!=record['qty'] or result.position.cost!=record['cost']:raise HistoryError('amended_current_economics_mismatch')
    from .fee_repair_model import UNSET, trade
    active=effective_rows(rows)
    return initial,[trade(row,corrections.get(row['id'],UNSET)) for row in active]


def effective_rows(rows):
    """One active event per retained root, sorted by proved event/creation time."""
    active=[row for row in rows if not row.get('_effective_inactive')]
    def key(row):
        from datetime import datetime
        value=row.get('_effective_event') or row
        return tuple(datetime.fromisoformat(value[k]) if isinstance(value[k],str) else value[k] for k in ('occurred_at','created_at'))
    return sorted(active,key=key)


def effective_events(rows,corrections):
    return [event({**row,**row['_effective_event']}) if row.get('_effective_event') else event(row,corrections.get(row['id'],row['fees'])) for row in effective_rows(rows)]


def transfer_replay(rows,record,corrections,projections):
    from .fee_repair_model import UNSET, trade
    from .position_transfer_checkpoint import current_rows
    amendments=rows[0].get('_record_amendments',()) if rows else ()
    initial=verify_physical(rows,record,projections,amendments)
    active=effective_rows(current_rows(rows,record))
    # Actual-paid evidence can differ from the immutable registered book. The
    # physical lineage is checked above; retain the separate actual projection.
    return initial,[trade(row,corrections.get(row['id'],UNSET)) for row in active]
