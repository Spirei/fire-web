"""Owner-declared funding sources; immutable cash links, reversals and retirement receipts."""
from datetime import datetime
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .broker_metadata import BrokerMetadata, fingerprint
from .cash_ledger import CashLedger, normalize
from .security import digest


def request_id(value):
    try:
        return str(UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, '原操作编号无效') from None


def command(raw):
    if not isinstance(raw, dict):
        raise HTTPException(422, '资金来源请求无效')
    identifier = request_id(raw.get('requestId'))
    if raw.get('kind') == 'create' and {'kind', 'requestId', 'cash'} <= set(raw) and not set(raw) - {'kind', 'requestId', 'cash', 'sourceType'}:
        if not isinstance(raw['cash'], dict) or 'requestId' in raw['cash']:
            raise HTTPException(422, '资金来源现金参数无效')
        cash = normalize({**raw['cash'], 'requestId': identifier})
        if cash.get('allowNegativeBalance') or cash.get('openingBasis') == 'allocate_verified_unallocated_checkpoint':
            raise HTTPException(422, '资金来源不代替融资确认或内部现金归属分配')
        origin_type = raw.get('sourceType', {'opening': 'opening', 'external_deposit': 'deposit', 'external_withdrawal': 'withdrawal', 'reconcile_balance': 'adjustment'}[cash['action']])
        if origin_type not in ('opening', 'deposit', 'withdrawal', 'adjustment'):
            raise HTTPException(422, '资金来源类型无效')
        return {'kind': 'create', 'requestId': identifier, 'sourceType': origin_type, 'cash': {k: v for k, v in cash.items() if k != 'requestId'}}
    if (raw.get('kind') == 'delete' and set(raw) == {'kind', 'requestId', 'sourceId', 'sourceRevision', 'occurredAt', 'note'}
            and isinstance(raw['sourceId'], str) and 1 <= len(raw['sourceId']) <= 100 and type(raw['sourceRevision']) is int and raw['sourceRevision'] == 1
            and isinstance(raw['note'], str) and len(raw['note']) <= 500 and not any(ord(c) < 32 or ord(c) == 127 for c in raw['note'])):
        try:
            when = datetime.fromisoformat(raw['occurredAt'])
            if when.tzinfo is None:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, '撤销时间须包含时区') from None
        return {**raw, 'requestId': identifier}
    raise HTTPException(422, '资金来源字段或操作无效')


class FundSources(BrokerMetadata):
    def __init__(self, db):
        super().__init__(db)
        self.cash = CashLedger(db)

    async def source(self, conn, owner, identifier):
        row = await (await conn.execute('SELECT f.*,r.request_id AS retirement_request_id,r.reversal_entry_id AS reversal_cash_entry_id FROM fund_sources f LEFT JOIN fund_source_retirements r ON r.owner_id=f.owner_id AND r.source_id=f.id WHERE f.owner_id=%s AND f.id=%s', (owner, identifier))).fetchone()
        if row:
            return row
        if not identifier.startswith('fund-') or identifier.startswith('fund-order-'):
            raise HTTPException(404, '本人手工资金来源不存在；订单或卡联动记录须在原业务处理')
        originals = await (await conn.execute('''SELECT e.*,l.original,l.original_id FROM financial_import_links l
            JOIN financial_import_operations o ON o.owner_id=l.owner_id AND o.request_id=l.operation_id
            JOIN cash_ledger_entries e ON e.owner_id=l.owner_id AND e.id::text=l.target_id
            WHERE l.owner_id=%s AND l.object_kind='cash' AND l.original_id=%s AND o.result->>'financialApplied'='true' AND o.result->>'state'='completed'
            AND e.affects_owner AND e.source_trade_id IS NULL AND e.reversal_entry_id IS NULL AND l.original->>'orderId' IS NULL
            AND l.original->>'originalScope' IN ('unallocated','broker') AND l.original->>'accountKind'=e.account_kind
            AND l.original->>'currency'=e.currency AND (l.original->>'amount')::numeric=e.amount
            AND e.kind IN ('opening','external_deposit','external_withdrawal','reconcile_balance') LIMIT 2''', (owner, identifier))).fetchall()
        if len(originals) != 1:
            raise HTTPException(409 if originals else 404, '旧资金原编号的本人来源或唯一归属尚未核实')
        entry = originals[0]
        return {**entry, 'id': identifier, 'cash_entry_id': entry['id'], 'origin_type': {'opening':'opening','external_deposit':'deposit','external_withdrawal':'withdrawal'}.get(entry['kind'],'adjustment'),
                'revision': 1, 'action': entry['kind'], 'amount': abs(entry['amount']), 'amount_basis': 'legacy_signed_posting',
                'delta': entry['amount'], 'retirement_request_id': None, 'reversal_cash_entry_id': None, '_legacy_imported': True}


    def dto(self, row):
        return {'id': row['id'], 'requestId': str(row['request_id']), 'cashEntryId': str(row['cash_entry_id']),
                'accountId': row['account_id'], 'accountKind': row['account_kind'], 'currency': row['currency'],
                'revision': row['revision'], 'amountBasis': row.get('amount_basis','cash_command_amount'), 'type': row['origin_type'], 'action': row['action'], 'amount': str(row['amount']), 'delta': str(row['delta']),
                'note': row['note'], 'occurredAt': row['occurred_at'].isoformat(), 'createdAt': row['created_at'].isoformat(),
                'authority': 'owner_recorded', 'retired': row.get('retirement_request_id') is not None,
                'retirementRequestId': str(row['retirement_request_id']) if row.get('retirement_request_id') else None,
                'reversalCashEntryId': str(row['reversal_cash_entry_id']) if row.get('reversal_cash_entry_id') else None,
                'canRetire': row.get('retirement_request_id') is None, 'financialHistoryDeleted': False}

    async def state(self, who, *, limit=200, offset=0, revision=None, currency=None, query="", include_retired=True):
        async with self.context(who) as conn:
            head = await (await conn.execute('SELECT revision FROM cash_ledger_collections WHERE owner_id=%s', (who.id,))).fetchone()
            current = head['revision'] if head else 0
            if revision is not None and revision != current:
                raise HTTPException(409, '资金来源列表已变化，请从第一页重读')
            if offset and revision is None:
                raise HTTPException(409, '续页需要原现金修订号')
            if (type(limit) is not int or not 1 <= limit <= 200 or type(offset) is not int or not 0 <= offset <= 1000000
                    or revision is not None and (type(revision) is not int or revision < 0)
                    or not isinstance(query, str) or len(query) > 100 or type(include_retired) is not bool):
                raise HTTPException(422, '资金来源分页或筛选无效')
            where = 'f.owner_id=%s AND (%s OR NOT EXISTS(SELECT 1 FROM fund_source_retirements r WHERE r.owner_id=f.owner_id AND r.source_id=f.id)) AND (%s::text IS NULL OR f.currency=%s) AND (%s=\'\' OR f.note ILIKE %s OR f.action ILIKE %s OR f.currency ILIKE %s)'
            args = (who.id, include_retired, currency, currency, query, '%' + query + '%', '%' + query + '%', '%' + query + '%')
            total = (await (await conn.execute('SELECT count(*) AS n FROM fund_sources f WHERE ' + where, args)).fetchone())['n']
            rows = await (await conn.execute('SELECT f.*,r.request_id AS retirement_request_id,r.reversal_entry_id AS reversal_cash_entry_id FROM fund_sources f LEFT JOIN fund_source_retirements r ON r.owner_id=f.owner_id AND r.source_id=f.id WHERE ' + where + ' ORDER BY f.occurred_at DESC,f.id LIMIT %s OFFSET %s', (*args, limit, offset))).fetchall()
            return {'sources': [self.dto(row) for row in rows], 'revision': current, 'partial': offset + len(rows) < total,
                    'pagination': {'limit': limit, 'offset': offset, 'total': total},
                    'coverageScope': 'platform_registered_manual_funding_sources', 'legacyCoverageKnown': False,
                    'orderAndCardLinkedDeletionSupported': False}

    async def cash_command(self, conn, who, payload):
        if payload['kind'] == 'create':
            return normalize({**payload['cash'], 'requestId': payload['requestId']}), None
        source = await self.source(conn, who.id, payload['sourceId'])
        if source.get('retirement_request_id'):
            raise HTTPException(409, '该来源已撤销，请查询原墓碑回执')
        if source['revision'] != payload['sourceRevision']:
            raise HTTPException(409, '来源版本已变化')
        delta = Decimal(source['delta'])
        data = normalize({'requestId': payload['requestId'], 'accountId': source['account_id'], 'accountKind': source['account_kind'],
                          'currency': source['currency'], 'action': 'external_withdrawal' if delta > 0 else 'external_deposit',
                          'amount': str(delta.copy_abs()), 'occurredAt': payload['occurredAt'], 'note': payload['note']})
        return data, source

    async def preview(self, who, raw, *, connection=None):
        payload = command(raw)
        async with self.context(who, connection=connection) as conn:
            if await (await conn.execute('SELECT 1 FROM fund_source_operations WHERE owner_id=%s AND request_id=%s', (who.id, payload['requestId']))).fetchone():
                raise HTTPException(409, '原操作已有结果，请查询原编号')
            if await (await conn.execute('SELECT 1 FROM cash_ledger_operations WHERE owner_id=%s AND request_id=%s', (who.id, payload['requestId']))).fetchone():
                raise HTTPException(409, '原编号已归属现金操作，请查询原回执')
            data, source = await self.cash_command(conn, who, payload)
            view = await self.cash.preview(who, data, connection=conn)
            preview, identifier = uuid4(), source['id'] if source else 'fund-' + uuid4().hex
            await conn.execute('INSERT INTO fund_source_previews(owner_id,id,request_id,payload,payload_hash,source_id,cash_preview_hash,authorization_binding,expires_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)', (who.id, preview, payload['requestId'], Jsonb(payload), fingerprint(payload), identifier, digest(view['preview']), await self.binding(conn, who), view['expiresAt']))
            return {**view, 'previewId': str(preview), 'cashPreview': view['preview'], 'sourceId': identifier, 'kind': payload['kind'],
                    'originalSource': self.dto(source) if source else None, 'financialHistoryDeleted': False,
                    'retirementEffect': 'inverse_cash_posting_and_retained_tombstone' if source else None}

    async def submit(self, who, raw, *, connection=None, legacy_request_hash=None, project=None):
        if (not isinstance(raw, dict) or set(raw) != {'previewId', 'command', 'cashPreview', 'confirm'} or raw['confirm'] is not True
                or not isinstance(raw['cashPreview'], str) or len(raw['cashPreview']) > 128):
            raise HTTPException(422, '请核对资金差额后明确确认')
        payload = command(raw['command'])
        try:
            preview_id = UUID(raw['previewId'])
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, '资金来源预览编号无效') from None
        expected = fingerprint(payload)
        async with self.context(who, connection=connection) as conn:
            prior = await (await conn.execute('SELECT request_hash,result FROM fund_source_operations WHERE owner_id=%s AND request_id=%s', (who.id, payload['requestId']))).fetchone()
            if prior:
                if prior['request_hash'] is not None and prior['request_hash'] != expected:
                    raise HTTPException(409, '原编号已用于其他资金操作')
                return prior['result']
            preview = await (await conn.execute('SELECT *,expires_at>clock_timestamp() AS valid FROM fund_source_previews WHERE owner_id=%s AND id=%s', (who.id, preview_id))).fetchone()
            if (not preview or not preview['valid'] or str(preview['request_id']) != payload['requestId'] or preview['payload_hash'] != expected
                    or preview['cash_preview_hash'] != digest(raw['cashPreview']) or preview['authorization_binding'] != await self.binding(conn, who)):
                raise HTTPException(409, '资金来源预览已变化或不属于当前会话')
            if await (await conn.execute('SELECT 1 FROM cash_ledger_operations WHERE owner_id=%s AND request_id=%s', (who.id, payload['requestId']))).fetchone():
                raise HTTPException(409, '原编号已归属现金操作，请查询原回执')
            data, source = await self.cash_command(conn, who, payload)
            if source and source.get('_legacy_imported'):
                await conn.execute('INSERT INTO fund_sources(owner_id,id,request_id,cash_entry_id,account_id,account_kind,currency,origin_type,action,amount,amount_basis,delta,note,occurred_at,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                                   (who.id, source['id'], source['request_id'], source['cash_entry_id'], source['account_id'], source['account_kind'], source['currency'], source['origin_type'], source['action'], source['amount'], 'legacy_signed_posting', source['delta'], source['note'], source['occurred_at'], source['created_at']))
            # No nested client call: posting, source or tombstone, and receipts share this PG transaction.
            result = await self.cash._submit_ledger(who, data, raw['cashPreview'], connection=conn, reversal_entry_id=source['cash_entry_id'] if source else None)
            if result.get('state') == 'closed':
                raise HTTPException(409, '原现金编号已关闭，请查询原回执')
            if source:
                await conn.execute('INSERT INTO fund_source_retirements(owner_id,source_id,request_id,reversal_entry_id,evidence) VALUES(%s,%s,%s,%s,%s)', (who.id, source['id'], payload['requestId'], result['entryId'], Jsonb({'authority': 'owner_confirmed_retirement', 'note': payload['note'], 'originalRequestId': str(source['request_id'])})))
            else:
                await conn.execute('INSERT INTO fund_sources(owner_id,id,request_id,cash_entry_id,account_id,account_kind,currency,origin_type,action,amount,delta,note,occurred_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', (who.id, preview['source_id'], payload['requestId'], result['entryId'], data['accountId'], data['accountKind'], data['currency'], payload['sourceType'], data['action'], data['amount'], result['delta'], data['note'], data['occurredAt']))
            saved = await self.source(conn, who.id, preview['source_id'])
            outcome = {**result, 'kind': payload['kind'], 'source': self.dto(saved), 'financialHistoryDeleted': False,
                       'retired': source is not None, 'originalEntryRetained': True}
            if legacy_request_hash is not None:
                outcome['legacyRequestHash'] = legacy_request_hash
            if project is not None:
                outcome['legacySnapshot'] = await project(conn, outcome)
            await conn.execute('INSERT INTO fund_source_operations(owner_id,request_id,request_hash,result) VALUES(%s,%s,%s,%s)', (who.id, payload['requestId'], expected, Jsonb(outcome)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)", (who.id, 'fund.source.' + payload['kind'], saved['id'], payload['requestId']))
            return outcome

    async def legacy_apply(self, who, raw, *, expected_revision=None, legacy_request_hash=None, connection=None, project=None):
        payload = command(raw)
        async with self.context(who, connection=connection) as conn:
            prior = await (await conn.execute('SELECT request_hash,result FROM fund_source_operations WHERE owner_id=%s AND request_id=%s', (who.id, payload['requestId']))).fetchone()
            if prior:
                if prior['request_hash'] is not None and (prior['result'].get('legacyRequestHash') != legacy_request_hash if legacy_request_hash is not None else prior['request_hash'] != fingerprint(payload)):
                    raise HTTPException(409, '原操作编号已用于其他资金来源')
                return prior['result']
            if expected_revision is not None:
                current = await self.cash.lock(conn, who)
                if type(expected_revision) is not int or current != expected_revision:
                    raise HTTPException(409, '现金来源快照已变化')
            preview = await self.preview(who, payload, connection=conn)
            return await self.submit(who, {'previewId': preview['previewId'], 'command': payload, 'cashPreview': preview['cashPreview'], 'confirm': True}, connection=conn, legacy_request_hash=legacy_request_hash, project=project)

    async def legacy_noop(self, conn, who, identifier, request_hash, currency, kind, target, *, project=None):
        from .asset_request_domains import require_domain
        from .cash_overview import CashOverview
        await self.cash.lock(conn, who)
        await require_domain(conn, who.id, identifier, 'cash')
        if await (await conn.execute('SELECT 1 FROM cash_ledger_operations WHERE owner_id=%s AND request_id=%s', (who.id, identifier))).fetchone():
            raise HTTPException(409, '原编号已有现金结果，请查询原回执')
        overview = await CashOverview(self.db).on_connection(conn, who)
        rows = [(book['accountKind'], row) for book in overview['books'] for row in book['currencies'] if row['currency'] == currency]
        if (len(rows) != 1 or rows[0][0] != kind or not rows[0][1]['complete']
                or rows[0][1]['ownerBalance'] is None or Decimal(rows[0][1]['ownerBalance']) != target):
            raise HTTPException(409, '当前原币范围或实际余额已变化')
        result = {'requestId': identifier, 'state': 'completed', 'noop': True, 'executed': False,
                  'action': 'reconcile_balance', 'accountId': None, 'accountKind': kind, 'currency': currency,
                  'ownerCashAfter': str(target), 'delta': '0', 'legacyRequestHash': request_hash,
                  'source': None, 'financialHistoryDeleted': False}
        if project is not None:
            result['legacySnapshot'] = await project(conn, result)
        await conn.execute('INSERT INTO cash_ledger_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)', (who.id, identifier, fingerprint({'legacyNoop': request_hash}), Jsonb(result)))
        await conn.execute('INSERT INTO fund_source_operations(owner_id,request_id,request_hash,result) VALUES(%s,%s,%s,%s)', (who.id, identifier, request_hash, Jsonb(result)))
        await conn.execute("INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'fund.source.unchanged',%s)", (who.id, identifier))
        return result

    async def receipt(self, who, request):
        identifier = request_id(str(request))
        async with self.context(who) as conn:
            row = await (await conn.execute('SELECT result FROM fund_source_operations WHERE owner_id=%s AND request_id=%s', (who.id, identifier))).fetchone()
            if not row:
                raise HTTPException(404, '本人原资金来源回执不存在')
            return row['result']

    async def close(self, who, request):
        identifier = request_id(str(request))
        async with self.context(who) as conn:
            row = await (await conn.execute('SELECT result FROM fund_source_operations WHERE owner_id=%s AND request_id=%s', (who.id, identifier))).fetchone()
            if row:
                return row['result']
            cash = await self.cash.close(who, identifier, connection=conn)
            if cash.get('state') != 'closed':
                raise HTTPException(409, '原编号已有现金结果，不能声明来源未执行')
            result = {'requestId': identifier, 'state': 'closed', 'executed': False}
            await conn.execute('INSERT INTO fund_source_operations(owner_id,request_id,request_hash,result) VALUES(%s,%s,NULL,%s)', (who.id, identifier, Jsonb(result)))
            return result

    async def resolve_legacy_scope(self, who, currency):
        async with self.context(who) as conn:
            rows = await (await conn.execute("SELECT DISTINCT account_kind FROM cash_ledger_entries WHERE owner_id=%s AND currency=%s AND account_id IS NULL AND kind='opening' ORDER BY account_kind", (who.id, currency))).fetchall()
            if len(rows) != 1:
                raise HTTPException(409, '真实或模拟原币资金来源尚未唯一核实')
            return rows[0]['account_kind']


async def purge_fund_source_previews(conn, owner):
    marker = await (await conn.execute("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name='0103_fund_sources.sql') AS installed")).fetchone()
    if not marker['installed']:
        relation = await (await conn.execute("SELECT to_regclass('public.fund_source_previews') AS relation")).fetchone()
        if relation['relation'] is not None:
            raise HTTPException(503, '资金来源预览结构尚未完整核对')
        return
    await conn.execute('DELETE FROM fund_source_previews WHERE owner_id=%s', (owner,))
