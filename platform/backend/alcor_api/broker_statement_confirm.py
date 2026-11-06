"""Explicit official snapshot confirmation; registered fills and cash history stay intact."""
from uuid import uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .broker_accounts import broker_account
from .broker_metadata import fingerprint
from .broker_statement_archive import archive, source_date
from .broker_statement_plan import prepare_comparison
from .broker_statements import BrokerStatements, identifier
from .portfolio_records import number


class StatementConfirmation(BrokerStatements):
    async def confirm(self, who, raw):
        if not isinstance(raw, dict) or set(raw) != {'requestId', 'previewId', 'confirmExternalAccount', 'takeOverOfficial', 'acknowledgeUnassigned'}:
            raise HTTPException(422, '账单确认字段无效')
        request, preview_id = identifier(raw['requestId']), identifier(raw['previewId'])
        if raw['takeOverOfficial'] is not True or type(raw['acknowledgeUnassigned']) is not bool or not isinstance(raw['confirmExternalAccount'], str):
            raise HTTPException(422, '须明确确认账单账户和官方持仓接管')
        request_hash = fingerprint(raw)
        async with self.context(who) as conn:
            await self.serialize(conn, who.id, request)
            previous = await (await conn.execute('SELECT request_hash,result FROM broker_statement_import_operations WHERE owner_id=%s AND request_id=%s', (who.id, request))).fetchone()
            if previous:
                if previous['request_hash'] is not None and previous['request_hash'] != request_hash:
                    raise HTTPException(409, '原操作编号已用于其他导入')
                return previous['result']
            preview = await (await conn.execute('SELECT *,expires_at>clock_timestamp() AS valid FROM broker_statement_previews WHERE owner_id=%s AND id=%s', (who.id, preview_id))).fetchone()
            if not preview or not preview['valid'] or preview['authorization_binding'] != await self.binding(conn, who):
                raise HTTPException(409, '预览不属于当前会话、已过期或已撤回')
            if await (await conn.execute('SELECT 1 FROM broker_statement_imports WHERE owner_id=%s AND preview_id=%s', (who.id, preview_id))).fetchone():
                raise HTTPException(409, '此预览已确认导入，请核对原操作')
            account = await broker_account(conn, who.id, preview['account_id'])
            if account['revision'] != preview['account_revision'] or account['account_kind'] != preview['account_kind']:
                raise HTTPException(409, '账户类型或版本已变化，请重新预览')
            statement = preview['parsed']
            if raw['confirmExternalAccount'] != statement['externalAccount']:
                raise HTTPException(409, '确认的外部账户编号与原件不一致')
            plan = await prepare_comparison(conn, who.id, account, statement)
            if fingerprint(preview['comparison']) != preview['comparison_hash'] or fingerprint(plan) != preview['comparison_hash']:
                raise HTTPException(409, '记录或预览差异已变化，请重新预览')
            if plan['blockers'] or plan['requiresUnassignedAcknowledgement'] and not raw['acknowledgeUnassigned']:
                raise HTTPException(409, '存在未核对数量、精度或未绑定记录，请先处理')
            if await (await conn.execute("SELECT 1 FROM internal_orders WHERE owner_id=%s AND account_id=%s AND status='pending' LIMIT 1", (who.id, account['id']))).fetchone():
                raise HTTPException(409, '账户仍有未完成委托，不能导入期末快照')
            newer = await (await conn.execute("""SELECT 1 FROM trade_ledger t JOIN portfolio_records r ON r.owner_id=t.owner_id AND r.id=t.record_id
                WHERE t.owner_id=%s AND t.account_id=%s AND (t.occurred_at AT TIME ZONE CASE r.market WHEN 'US' THEN 'America/New_York' WHEN 'HK' THEN 'Asia/Hong_Kong' WHEN 'CN' THEN 'Asia/Shanghai' ELSE 'UTC' END)::date>%s LIMIT 1""", (who.id, account['id'], source_date(statement['toDate'])))).fetchone()
            if newer:
                raise HTTPException(409, '账户已有晚于账单的成交，请使用更新账单')
            imported, event_count = await archive(conn, who.id, account, preview, request, await self.binding(conn, who))
            observed = {}
            for item in plan['rows']:
                record_id = item['recordId']
                if record_id is None:
                    record_id = 'rec-' + uuid4().hex
                    # Official values live in their own immutable observation, never a fabricated fill.
                    await conn.execute("INSERT INTO portfolio_records(owner_id,id,name,code,market,broker_account_id,group_name,source,history_state) VALUES(%s,%s,%s,%s,%s,%s,%s,'ibkr-flex','unknown')", (who.id, record_id, item['name'], item['code'], item['market'], account['id'], account['name']))
                observed[record_id] = item
            records = await (await conn.execute('SELECT id FROM portfolio_records WHERE owner_id=%s AND broker_account_id=%s AND deleted_at IS NULL ORDER BY id', (who.id, account['id']))).fetchall()
            for record in records:
                item = observed.get(record['id'])
                await conn.execute('INSERT INTO broker_statement_positions(owner_id,import_id,account_id,record_id,quantity,cost,price,source_absent) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',
                                   (who.id, imported, account['id'], record['id'], number(item['qty']) if item else '0', number(item['cost'], negative=True) if item else None, number(item['price']) if item else None, item is None))
                await conn.execute('UPDATE portfolio_records SET updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s', (who.id, record['id']))
            references = [item['currency'] for item in statement['cash']] or [None]
            for currency in references:
                await conn.execute("INSERT INTO broker_account_references(owner_id,account_id,kind,reference_id,currency) VALUES(%s,%s,'statement',%s,%s)", (who.id, account['id'], str(imported) + ':' + (currency or 'unknown'), currency))
            changed_account = await (await conn.execute("UPDATE broker_accounts SET holding_source='official',revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s RETURNING revision", (who.id, account['id']))).fetchone()
            await conn.execute('INSERT INTO broker_account_collections(owner_id,revision) VALUES(%s,1) ON CONFLICT(owner_id) DO UPDATE SET revision=broker_account_collections.revision+1', (who.id,))
            collection = await (await conn.execute('SELECT revision FROM portfolio_record_collections WHERE owner_id=%s', (who.id,))).fetchone()
            result = {'requestId': str(request), 'previewId': str(preview_id), 'state': 'completed', 'importId': str(imported), 'accountId': account['id'], 'accountKind': account['account_kind'], 'asOfDate': statement['toDate'], 'sourceSha256': statement['sourceSha256'], 'positions': len(records), 'accountRevision': changed_account['revision'], 'recordCollectionRevision': collection['revision'] if collection else 0, 'created': sum(item['recordId'] is None for item in plan['rows']), 'updated': sum(item['recordId'] is not None for item in plan['rows']), 'closed': sum(item['action'] == 'close_snapshot_position' for item in plan['missing']), 'newArchivedEvents': event_count, 'historicalEventsReplayed': False, 'cashLedgerChanged': False, 'externalAccountAssociation': 'owner_confirmed_statement_account'}
            await conn.execute('INSERT INTO broker_statement_import_operations(owner_id,request_id,request_hash,result) VALUES(%s,%s,%s,%s)', (who.id, request, request_hash, Jsonb(result)))
            await conn.execute('INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)', (who.id, 'broker.statement.import', account['id'], request))
            return result

    async def import_receipt(self, who, request):
        async with self.context(who) as conn:
            row = await (await conn.execute('SELECT result FROM broker_statement_import_operations WHERE owner_id=%s AND request_id=%s', (who.id, identifier(request)))).fetchone()
            if not row:
                raise HTTPException(404, '本人导入回执不存在')
            return row['result']

    async def close_import(self, who, request):
        request = identifier(request)
        async with self.context(who) as conn:
            await self.serialize(conn, who.id, request)
            prior = await (await conn.execute('SELECT result FROM broker_statement_import_operations WHERE owner_id=%s AND request_id=%s', (who.id, request))).fetchone()
            if prior:
                return prior['result']
            result = {'requestId': str(request), 'state': 'closed', 'executed': False}
            await conn.execute('INSERT INTO broker_statement_import_operations(owner_id,request_id,request_hash,result) VALUES(%s,%s,NULL,%s)', (who.id, request, Jsonb(result)))
            return result
