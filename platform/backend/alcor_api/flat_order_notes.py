"""Append-only flat order display notes in their immutable parent operation.

No trade, cash entry or source note is changed. Readers share the caller's
owner transaction and only overlay the current effective trade projection.
"""
from uuid import UUID

from fastapi import HTTPException


async def root_trade(conn, owner, order_id):
    rows=await(await conn.execute('''SELECT t.id,t.record_id FROM trade_ledger t
        WHERE t.owner_id=%s AND (t.id=%s OR EXISTS(SELECT 1 FROM trade_amendments a
          WHERE a.owner_id=t.owner_id AND a.trade_id=t.id AND a.replacement_id=%s))''',
        (owner,UUID(order_id),UUID(order_id)))).fetchall()
    if not rows:
        raise HTTPException(404,'本人原成交来源不存在')
    if len(rows)!=1:
        raise HTTPException(409,'原成交来源不唯一，不能选择首个目标')
    return rows[0]


def valid_note(value):
    if not isinstance(value,str) or len(value)>500 or any(ord(c)<32 or ord(c)==127 for c in value):
        raise HTTPException(400,'订单备注须为500字以内的明确文字')
    try:value.encode('utf-8')
    except UnicodeError:raise HTTPException(400,'订单备注编码无效') from None
    return value


async def current_notes(conn, owner, trade_ids):
    if not trade_ids:
        return {}
    ids=[str(item) for item in trade_ids]
    rows=await(await conn.execute('''SELECT result->'noteDeclaration' AS declaration
        FROM legacy_flat_order_operations WHERE owner_id=%s
          AND result->'noteDeclaration'->>'rootTradeId'=ANY(%s::text[])
        ORDER BY created_at,request_id LIMIT 20001''',(owner,ids))).fetchall()
    if len(rows)>20000:
        raise HTTPException(503,'订单备注声明超过本次完整核对预算')
    declarations=[]
    for row in rows:
        value=row['declaration']
        if (not isinstance(value,dict) or value.get('rootTradeId') not in ids
                or type(value.get('noteRevision')) is not int or value['noteRevision']<1
                or type(value.get('priorNoteRevision')) is not int
                or value['priorNoteRevision']!=value['noteRevision']-1):
            raise HTTPException(409,'订单备注声明来源无法核对')
        valid_note(value.get('note'))
        declarations.append(value)
    result={}
    for value in sorted(declarations,key=lambda value:(value['rootTradeId'],value['noteRevision'])):
        key=value['rootTradeId'];before=result.get(key)
        if before and value['noteRevision']!=before['noteRevision']+1 or not before and value['noteRevision']!=1:
            raise HTTPException(409,'订单备注声明修订链无法核对')
        result[key]=value
    return result


def note_projection(order, declaration=None):
    if declaration and declaration.get('recordId')!=order.get('recordId'):
        raise HTTPException(409,'订单备注与实际证券来源不一致')
    original=order.get('originalNote',order.get('note',''))
    return {**order,'originalNote':original,'note':declaration['note'] if declaration else original,
        'noteRevision':declaration['noteRevision'] if declaration else 0,
        'noteAuthority':'owner_append_only_declaration' if declaration else 'original_trade_note'}
