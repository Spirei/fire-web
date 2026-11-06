"""Exact paired full-position transfers; original records and trading history stay owned."""
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from psycopg.types.json import Jsonb

from .actual_projection import first_unknown_revision
from .broker_accounts import broker_account
from .broker_metadata import BrokerMetadata, fingerprint
from .portfolio_records import number, record_dto
from .scope_coverage import record_status


def packed(value):
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, UUID)):
        return str(value)
    if isinstance(value, dict):
        return {k: packed(v) for k, v in value.items()}
    if isinstance(value, list):
        return [packed(v) for v in value]
    return value


def command(raw):
    fields = {'requestId', 'sourceRecordId', 'sourceRecordRevision', 'sourceAccountId', 'sourceAccountRevision',
              'targetAccountId', 'targetAccountRevision', 'accountKind', 'quantity', 'expectedRecordCollectionRevision', 'evidence'}
    if not isinstance(raw, dict) or set(raw) != fields:
        raise HTTPException(422, '转仓请求字段无效')
    try:
        request = str(UUID(raw['requestId']))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, '原操作编号无效') from None
    if (any(not isinstance(raw[k], str) or not 1 <= len(raw[k]) <= 100 for k in ('sourceRecordId', 'sourceAccountId', 'targetAccountId'))
            or raw['sourceAccountId'] == raw['targetAccountId'] or raw['accountKind'] not in ('real', 'simulated')
            or any(type(raw[k]) is not int or raw[k] < 1 for k in ('sourceRecordRevision', 'sourceAccountRevision', 'targetAccountRevision'))
            or type(raw['expectedRecordCollectionRevision']) is not int or raw['expectedRecordCollectionRevision'] < 0
            or not isinstance(raw['quantity'], str) or number(raw['quantity']) is None or Decimal(raw['quantity']) <= 0):
        raise HTTPException(422, '转仓数量、账户或版本无效')
    evidence = raw['evidence']
    if (not isinstance(evidence, dict) or set(evidence) != {'kind', 'reference', 'occurredAt'}
            or evidence['kind'] != 'owner_recorded_transfer' or not isinstance(evidence['reference'], str)
            or not 1 <= len(evidence['reference'].strip()) <= 300
            or any(ord(c) < 32 or ord(c) == 127 for c in evidence['reference'])):
        raise HTTPException(422, '请提供本人确认的转仓凭证，不得冒充券商成交')
    try:
        when = datetime.fromisoformat(evidence['occurredAt'])
        if when.tzinfo is None:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, '转仓时间须包含时区') from None
    return {**raw, 'requestId': request, 'quantity': number(raw['quantity']),
            'evidence': {**evidence, 'reference': evidence['reference'].strip(), 'occurredAt': when.astimezone(UTC).isoformat()}}


class BrokerPositionTransfers(BrokerMetadata):
    async def eligible(self, conn, who, row):
        if not row or row['deleted_at'] is not None or not row['broker_account_id']:
            raise HTTPException(409, '原记录尚未核实账户归属')
        if row['qty'] is None or row['cost'] is None or row['qty'] <= 0:
            raise HTTPException(409, '实际数量或成本未知，或没有可转出持仓')
        if row['history_state'] == 'unknown' and not row.get('position_transfer_id'):
            raise HTTPException(409, '原记录历史尚未核实')
        if not await record_status(conn, who.id, row['id']) or await first_unknown_revision(conn, who.id, row['id']) is not None:
            raise HTTPException(409, '原始来源或实际费用尚未完整核实')
        if await (await conn.execute("SELECT 1 FROM internal_orders WHERE owner_id=%s AND record_id=%s AND status='pending' LIMIT 1", (who.id, row['id']))).fetchone():
            raise HTTPException(409, '原记录仍有未完成委托')
        if row.get('position_transfer_id'):
            from .position_transfer_checkpoint import verify_current
            await verify_current(conn, who.id, row)
        elif row['history_state'] == 'has_trades':
            if row.get('trade_tip_id') is None:
                raise HTTPException(409, '原成交链尚未迁入，不能据登记持仓转出')
            history = await (await conn.execute('SELECT * FROM trade_ledger WHERE owner_id=%s AND record_id=%s ORDER BY before_record_revision LIMIT 10001', (who.id, row['id']))).fetchall()
            if len(history) > 10000:
                raise HTTPException(409, '完整成交核对范围超限')
            from .trade_amendment_history import attach_amendments
            from .trade_amendment_model import verify_physical
            await attach_amendments(conn, who.id, history)
            projections = await (await conn.execute('SELECT * FROM trade_fee_projections WHERE owner_id=%s AND record_id=%s', (who.id, row['id']))).fetchall()
            try:
                verify_physical(history, row, projections, history[0].get('_record_amendments', ()) if history else ())
            except ValueError:
                raise HTTPException(409, '实际持仓与完整原成交证据无法核对') from None
        source = await broker_account(conn, who.id, row['broker_account_id'])
        if source['account_kind'] not in ('real', 'simulated') or source['holding_source'] != 'manual':
            raise HTTPException(409, '请先核对账本类型及官方与手工来源差异')
        return source

    async def state(self, who):
        async with self.context(who) as conn:
            rows = await (await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 201', (who.id,))).fetchall()
            accounts = await (await conn.execute('SELECT id FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 101', (who.id,))).fetchall()
            records = []
            for row in rows[:200]:
                reason = None
                try:
                    await self.eligible(conn, who, row)
                except HTTPException as exc:
                    reason = str(exc.detail)
                records.append({**record_dto(row), 'blockedReason': reason, 'historyState': row['history_state'], 'actualKnown': reason is None})
            return {'accounts': jsonable_encoder([await broker_account(conn, who.id, a['id']) for a in accounts[:100]]),
                    'records': records, 'recordCollectionRevision': (await self.versions(conn, who.id))[1],
                    'partial': len(rows) > 200 or len(accounts) > 100, 'fullPositionOnly': True, 'cashEffect': 'none'}

    async def plan(self, conn, who, payload, target_record_id):
        row = await (await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s AND deleted_at IS NULL FOR UPDATE', (who.id, payload['sourceRecordId']))).fetchone()
        source = await self.eligible(conn, who, row)
        target = await broker_account(conn, who.id, payload['targetAccountId'])
        if (row['revision'], source['id'], source['revision'], target['revision']) != (payload['sourceRecordRevision'], payload['sourceAccountId'], payload['sourceAccountRevision'], payload['targetAccountRevision']):
            raise HTTPException(409, '原持仓或账户版本已变化')
        if source['account_kind'] != payload['accountKind'] or target['account_kind'] != payload['accountKind'] or target['holding_source'] != 'manual':
            raise HTTPException(409, '仅允许本人同类手工账本间明确转移')
        if Decimal(payload['quantity']) != row['qty']:
            raise HTTPException(409, '当前仅支持完整持仓转移，请核对实际全量数量')
        if (await self.versions(conn, who.id))[1] != payload['expectedRecordCollectionRevision']:
            raise HTTPException(409, '记录集合已变化')
        duplicate = await (await conn.execute("SELECT 1 FROM portfolio_records WHERE owner_id=%s AND broker_account_id=%s AND market=%s AND code=%s AND COALESCE(NULLIF(account_market,''),market)=%s AND deleted_at IS NULL LIMIT 1", (who.id, target['id'], row['market'], row['code'], row['account_market'] or row['market']))).fetchone()
        if duplicate:
            raise HTTPException(409, '目标账户已有同证券记录，不能自动合并历史')
        when = datetime.fromisoformat(payload['evidence']['occurredAt'])
        latest = await (await conn.execute("SELECT greatest((SELECT max(greatest(occurred_at,(current_effective_trade_event(owner_id,id)->>'occurred_at')::timestamptz)) FROM trade_ledger WHERE owner_id=%s AND record_id=%s),(SELECT max(h.occurred_at) FROM broker_position_transfer_events e JOIN broker_position_transfers h ON h.owner_id=e.owner_id AND h.id=e.transfer_id WHERE e.owner_id=%s AND e.record_id=%s)) AS latest,clock_timestamp() AS now", (who.id, row['id'], who.id, row['id']))).fetchone()
        if when > latest['now'] or latest['latest'] is not None and when < latest['latest']:
            raise HTTPException(409, '转仓时间不得早于现有成交或转仓，也不得在未来')
        before = record_dto(row)
        after = {**before, 'qty': '0', 'cost': '0', 'revision': row['revision'] + 1, 'updatedAt': None}
        destination = {**before, 'id': target_record_id, 'brokerAccountId': target['id'], 'group': target['name'], 'source': 'owner_transfer', 'historyState': 'empty', 'watchGroupId': '', 'watchGroupSort': 0, 'note': '', 'revision': 2, 'updatedAt': None}
        return {'sourceRecordId': row['id'], 'targetRecordId': target_record_id, 'sourceAccountId': source['id'], 'targetAccountId': target['id'],
                'accountKind': payload['accountKind'], 'sourceBefore': before, 'sourceAfter': after, 'targetBefore': None, 'targetAfter': destination,
                'transferQuantity': str(row['qty']), 'unitCost': str(row['cost']), 'cashEffect': 'none',
                'sourceSnapshotHash': fingerprint(packed({k: v for k, v in row.items() if not k.startswith('_')})), 'evidenceAuthority': 'owner_recorded_transfer', 'originalHistoryRetained': True}

    async def preview(self, who, raw):
        payload = command(raw)
        async with self.context(who) as conn:
            prior = await (await conn.execute('SELECT 1 FROM broker_position_transfer_operations WHERE owner_id=%s AND request_id=%s', (who.id, payload['requestId']))).fetchone()
            if prior:
                raise HTTPException(409, '原操作已有结果，请查询原编号')
            plan = await self.plan(conn, who, payload, 'pr-' + uuid4().hex)
            preview = uuid4()
            expiry = await (await conn.execute('INSERT INTO broker_position_transfer_previews(owner_id,id,request_id,payload,plan,payload_hash,plan_hash,authorization_binding,record_collection_revision) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING expires_at',
                                               (who.id, preview, payload['requestId'], Jsonb(payload), Jsonb(plan), fingerprint(payload), fingerprint(plan), await self.binding(conn, who), payload['expectedRecordCollectionRevision']))).fetchone()
            return {**plan, 'requestId': payload['requestId'], 'previewId': str(preview), 'expiresAt': expiry['expires_at'].isoformat()}

    async def submit(self, who, raw):
        if not isinstance(raw, dict) or set(raw) != {'previewId', 'command', 'confirmTransfer'} or raw['confirmTransfer'] is not True:
            raise HTTPException(422, '请明确确认转出及转入，不会创建买卖成交')
        payload = command(raw['command'])
        try:
            preview_id = UUID(raw['previewId'])
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, '转仓预览编号无效') from None
        request, request_hash = payload['requestId'], fingerprint(payload)
        async with self.context(who) as conn:
            prior = await (await conn.execute('SELECT request_hash,result FROM broker_position_transfer_operations WHERE owner_id=%s AND request_id=%s', (who.id, request))).fetchone()
            if prior:
                if prior['request_hash'] is not None and prior['request_hash'] != request_hash:
                    raise HTTPException(409, '原操作编号已用于其他转仓')
                return prior['result']
            preview = await (await conn.execute('SELECT *,expires_at>clock_timestamp() AS valid FROM broker_position_transfer_previews WHERE owner_id=%s AND id=%s', (who.id, preview_id))).fetchone()
            if (not preview or not preview['valid'] or str(preview['request_id']) != request or preview['payload_hash'] != request_hash
                    or preview['authorization_binding'] != await self.binding(conn, who)):
                raise HTTPException(409, '转仓预览失效或不属于当前会话')
            plan = await self.plan(conn, who, payload, preview['plan']['targetRecordId'])
            if fingerprint(plan) != preview['plan_hash']:
                raise HTTPException(409, '转仓依赖已变化，请重新预览')
            source_id, target_id, transfer_id = payload['sourceRecordId'], plan['targetRecordId'], uuid4()
            await conn.execute("INSERT INTO portfolio_records(owner_id,id,name,code,market,account_market,price,cost,qty,group_name,broker_account_id,note,source,history_state) SELECT owner_id,%s,name,code,market,account_market,price,0,0,%s,%s,'','owner_transfer','empty' FROM portfolio_records WHERE owner_id=%s AND id=%s", (target_id, plan['targetAfter']['group'], payload['targetAccountId'], who.id, source_id))
            await conn.execute('INSERT INTO broker_position_transfers(owner_id,id,request_id,source_record_id,target_record_id,source_account_id,target_account_id,account_kind,quantity,unit_cost,source_account_revision,target_account_revision,source_snapshot,evidence,evidence_sha256,authorization_binding,occurred_at) SELECT owner_id,%s,%s,id,%s,broker_account_id,%s,%s,qty,cost,%s,%s,to_jsonb(portfolio_records),%s,%s,%s,%s FROM portfolio_records WHERE owner_id=%s AND id=%s',
                               (transfer_id, request, target_id, payload['targetAccountId'], payload['accountKind'], payload['sourceAccountRevision'], payload['targetAccountRevision'], Jsonb(payload['evidence']), fingerprint(payload['evidence']), await self.binding(conn, who), payload['evidence']['occurredAt'], who.id, source_id))
            events = []
            for record_id, account_id, direction, after_qty, after_cost in ((source_id, payload['sourceAccountId'], 'out', '0', '0'), (target_id, payload['targetAccountId'], 'in', plan['transferQuantity'], plan['unitCost'])):
                event = uuid4(); events.append(str(event))
                await conn.execute('INSERT INTO broker_position_transfer_events(owner_id,id,transfer_id,record_id,account_id,direction,before_record_revision,before_quantity,before_cost,after_quantity,after_cost,previous_transfer_id,before_snapshot) SELECT owner_id,%s,%s,id,broker_account_id,%s,revision,qty,cost,%s,%s,position_transfer_id,to_jsonb(portfolio_records) FROM portfolio_records WHERE owner_id=%s AND id=%s', (event, transfer_id, direction, after_qty, after_cost, who.id, record_id))
                await conn.execute('UPDATE portfolio_records SET qty=%s,cost=%s,position_transfer_id=%s,revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s', (after_qty, after_cost, event, who.id, record_id))
            for account_id in sorted((payload['sourceAccountId'], payload['targetAccountId'])):
                await conn.execute('UPDATE broker_accounts SET revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s', (who.id, account_id))
            await conn.execute('INSERT INTO broker_account_collections(owner_id,revision) VALUES(%s,1) ON CONFLICT(owner_id) DO UPDATE SET revision=broker_account_collections.revision+1', (who.id,))
            result = {'requestId': request, 'state': 'completed', 'transferId': str(transfer_id), 'sourceRecordId': source_id, 'targetRecordId': target_id,
                      'sourceAccountId': payload['sourceAccountId'], 'targetAccountId': payload['targetAccountId'], 'accountKind': payload['accountKind'],
                      'quantity': plan['transferQuantity'], 'unitCost': plan['unitCost'], 'cashEffect': 'none', 'tradeHistoryMoved': False,
                      'events': events, 'recordCollectionRevision': (await self.versions(conn, who.id))[1], 'evidenceAuthority': 'owner_recorded_transfer'}
            await conn.execute('INSERT INTO broker_position_transfer_operations(owner_id,request_id,request_hash,result) VALUES(%s,%s,%s,%s)', (who.id, request, request_hash, Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'broker.position.transfer',%s,%s)", (who.id, str(transfer_id), request))
            return result

    async def receipt(self, who, request):
        try:
            request = UUID(str(request))
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, '原操作编号无效') from None
        async with self.context(who) as conn:
            prior = await (await conn.execute('SELECT result FROM broker_position_transfer_operations WHERE owner_id=%s AND request_id=%s', (who.id, request))).fetchone()
            if not prior:
                raise HTTPException(404, '本人原转仓回执不存在')
            return prior['result']

    async def close(self, who, request):
        try:
            request = UUID(str(request))
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, '原操作编号无效') from None
        async with self.context(who) as conn:
            prior = await (await conn.execute('SELECT result FROM broker_position_transfer_operations WHERE owner_id=%s AND request_id=%s', (who.id, request))).fetchone()
            if prior:
                return prior['result']
            result = {'requestId': str(request), 'state': 'closed', 'executed': False}
            await conn.execute('INSERT INTO broker_position_transfer_operations(owner_id,request_id,request_hash,result) VALUES(%s,%s,NULL,%s)', (who.id, request, Jsonb(result)))
            return result


async def purge_broker_position_transfer_previews(conn, owner):
    marker = await (await conn.execute("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name='0100_broker_position_transfers.sql') AS installed")).fetchone()
    if not marker['installed']:
        relation = await (await conn.execute("SELECT to_regclass('public.broker_position_transfer_previews') AS relation")).fetchone()
        if relation['relation'] is not None:
            raise HTTPException(503, '转仓预览结构尚未完整核对')
        return
    await conn.execute('DELETE FROM broker_position_transfer_previews WHERE owner_id=%s', (owner,))
