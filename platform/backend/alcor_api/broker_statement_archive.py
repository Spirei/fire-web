"""Transactional original-source archive used by confirmed official snapshot imports."""
from datetime import datetime
from uuid import uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .broker_metadata import fingerprint


def source_date(value):
    return datetime.strptime(value, '%Y%m%d').date()


async def check_source_history(conn, owner, account, statement):
    previous = await (await conn.execute(
        'SELECT source_sha256,external_account,to_date FROM broker_statement_imports WHERE owner_id=%s AND account_id=%s ORDER BY to_date DESC,created_at DESC LIMIT 1',
        (owner, account['id']))).fetchone()
    if previous:
        if previous['external_account'] != statement['externalAccount']:
            raise HTTPException(409, '账单外部账户与已确认的历史关联不一致')
        if previous['to_date'] >= source_date(statement['toDate']):
            raise HTTPException(409, '账单日期不晚于已确认快照，请核对最新账单')
    for event in statement['events']:
        prior = await (await conn.execute(
            'SELECT payload_hash FROM broker_statement_events WHERE owner_id=%s AND account_id=%s AND external_id=%s',
            (owner, account['id'], event['id']))).fetchone()
        if prior and prior['payload_hash'] != fingerprint(event):
            raise HTTPException(409, '官方流水已更正，须保留原流水并单独核对')


async def archive(conn, owner, account, preview, request_id, authorization_binding):
    """Caller owns account/identity/UUID locks and must validate every confirmation proof."""
    statement = preview['parsed']
    await check_source_history(conn, owner, account, statement)
    original = await (await conn.execute(
        'SELECT source_sha256,source_bytes,account_id,account_kind,external_account FROM broker_statement_originals WHERE owner_id=%s AND id=%s',
        (owner, preview['original_id']))).fetchone()
    import hashlib
    if (not original or original['account_id'] != account['id']
            or original['account_kind'] != account['account_kind']
            or original['external_account'] != statement['externalAccount']
            or original['source_sha256'] != statement['sourceSha256']
            or hashlib.sha256(bytes(original['source_bytes'])).hexdigest() != statement['sourceSha256']):
        raise HTTPException(409, '原件身份或内容校验不一致，未导入')
    identifier = uuid4()
    await conn.execute('INSERT INTO broker_statement_imports(owner_id,id,request_id,account_id,account_kind,original_id,preview_id,source_sha256,external_account,from_date,to_date,statement,comparison,authorization_binding) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                       (owner, identifier, request_id, account['id'], account['account_kind'], preview['original_id'], preview['id'], statement['sourceSha256'], statement['externalAccount'], source_date(statement['fromDate']), source_date(statement['toDate']), Jsonb(statement), Jsonb(preview['comparison']), authorization_binding))
    inserted = 0
    for event in statement['events']:
        row = await (await conn.execute('INSERT INTO broker_statement_events(owner_id,account_id,account_kind,external_id,first_import_id,payload,payload_hash) VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(owner_id,account_id,external_id) DO NOTHING RETURNING external_id',
                                        (owner, account['id'], account['account_kind'], event['id'], identifier, Jsonb(event), fingerprint(event)))).fetchone()
        inserted += int(row is not None)
    return identifier, inserted
