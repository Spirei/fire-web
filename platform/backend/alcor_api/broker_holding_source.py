"""Explicit display-authority changes; never convert official snapshots into ledger facts."""
from uuid import UUID, uuid4

from fastapi import HTTPException
from fastapi.encoders import jsonable_encoder
from psycopg.types.json import Jsonb

from .broker_accounts import broker_account
from .broker_metadata import BrokerMetadata, fingerprint
from .broker_statement_projection import official_record
from .portfolio_records import record_dto


def command(raw):
    fields = {'kind', 'accountId', 'data', 'expectedCollectionRevision', 'expectedRecordCollectionRevision'}
    if not isinstance(raw, dict) or set(raw) != fields or raw['kind'] != 'holding-source':
        raise HTTPException(422, '持仓来源请求字段无效')
    data = raw['data']
    if (not isinstance(raw['accountId'], str) or not 1 <= len(raw['accountId']) <= 100
            or not isinstance(data, dict) or set(data) != {'requestId', 'revision', 'accountKind', 'source'}
            or data['source'] != 'manual' or data['accountKind'] not in ('real', 'simulated', 'unknown')
            or type(data['revision']) is not int or data['revision'] < 1
            or any(type(raw[k]) is not int or raw[k] < 0 for k in ('expectedCollectionRevision', 'expectedRecordCollectionRevision'))):
        raise HTTPException(422, '持仓来源或版本无效')
    try:
        request = str(UUID(data['requestId']))
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, '原操作编号无效') from None
    return {**raw, 'data': {**data, 'requestId': request}}


class BrokerHoldingSource(BrokerMetadata):
    async def plan(self, conn, who, payload):
        account = await broker_account(conn, who.id, payload['accountId'])
        data = payload['data']
        if (account['revision'], account['account_kind']) != (data['revision'], data['accountKind']):
            raise HTTPException(409, '账户版本或账本类型已变化')
        rows = await (await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND broker_account_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 10001', (who.id, account['id']))).fetchall()
        if len(rows) > 10000:
            raise HTTPException(409, '持仓超过完整核对上限，未生成不完整差异')
        records = []
        for row in rows:
            official = await official_record(conn, who.id, row)
            manual = record_dto(row)
            records.append({'recordId': row['id'], 'security': row['market'] + ':' + row['code'],
                            'revision': row['revision'], 'historyState': row['history_state'],
                            'official': official, 'manual': {k: manual[k] for k in ('qty', 'cost', 'price')}})
        return jsonable_encoder({'accountId': account['id'], 'beforeSource': account['holding_source'],
                                 'afterSource': 'manual', 'records': records, 'account': account,
                                 'financialHistoryChanged': False, 'snapshotsRetained': True,
                                 'sourceConfigurationRetained': True, 'pendingContinuationInvalidated': True})

    async def preview(self, who, raw, *, connection=None):
        payload = command(raw)
        async with self.context(who, connection=connection) as conn:
            versions = await self.versions(conn, who.id)
            if versions != (payload['expectedCollectionRevision'], payload['expectedRecordCollectionRevision']):
                raise HTTPException(409, '账户或记录目录已变化')
            prior = await (await conn.execute('SELECT 1 FROM broker_account_operations WHERE owner_id=%s AND request_id=%s', (who.id, payload['data']['requestId']))).fetchone()
            if prior:
                raise HTTPException(409, '原操作已有结果，请查询原编号')
            plan = await self.plan(conn, who, payload)
            identifier = uuid4()
            # Holding source is an account update category, with a distinct, bound payload kind.
            expiry = await (await conn.execute("INSERT INTO broker_metadata_previews(owner_id,id,request_id,kind,account_id,payload,fingerprint,authorization_binding,collection_revision,record_collection_revision,account_dependency) VALUES(%s,%s,%s,'update',%s,%s,%s,%s,%s,%s,%s) RETURNING expires_at",
                                               (who.id, identifier, payload['data']['requestId'], payload['accountId'], Jsonb(payload), fingerprint(payload), await self.binding(conn, who), *versions, fingerprint(plan)))).fetchone()
            return {**plan, 'previewId': str(identifier), 'requestId': payload['data']['requestId'], 'expiresAt': jsonable_encoder(expiry['expires_at'])}

    async def submit(self, who, raw, *, connection=None, project=None, legacy_request_hash=None):
        if (not isinstance(raw, dict) or set(raw) != {'previewId', 'command', 'acknowledgeProjectionChange'}
                or raw['acknowledgeProjectionChange'] is not True):
            raise HTTPException(422, '请明确确认官方与手工投影的差异')
        payload = command(raw['command'])
        try:
            identifier = UUID(raw['previewId'])
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, '来源预览编号无效') from None
        request, expected = payload['data']['requestId'], fingerprint(payload)
        async with self.context(who, connection=connection) as conn:
            prior = await (await conn.execute('SELECT fingerprint,result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s', (who.id, request))).fetchone()
            if prior:
                if prior['result'].get('state') == 'closed':
                    return prior['result']
                if prior['fingerprint'] != expected:
                    raise HTTPException(409, '原操作编号已用于其他操作')
                return prior['result']
            preview = await (await conn.execute('SELECT *,expires_at>clock_timestamp() AS valid FROM broker_metadata_previews WHERE owner_id=%s AND id=%s', (who.id, identifier))).fetchone()
            if (not preview or not preview['valid'] or preview['payload'].get('kind') != 'holding-source'
                    or preview['fingerprint'] != expected or str(preview['request_id']) != request
                    or preview['authorization_binding'] != await self.binding(conn, who)):
                raise HTTPException(409, '来源预览已失效或内容已变化')
            if await self.versions(conn, who.id) != (preview['collection_revision'], preview['record_collection_revision']):
                raise HTTPException(409, '账户或记录目录已变化')
            plan = await self.plan(conn, who, payload)
            if fingerprint(plan) != preview['account_dependency']:
                raise HTTPException(409, '来源、历史或快照已变化，请重新预览')
            await conn.execute("UPDATE broker_accounts SET holding_source='manual',revision=revision+1,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s", (who.id, payload['accountId']))
            await conn.execute('DELETE FROM broker_metadata_previews WHERE owner_id=%s AND account_id=%s', (who.id, payload['accountId']))
            await conn.execute('DELETE FROM broker_binding_previews WHERE owner_id=%s AND account_id=%s', (who.id, payload['accountId']))
            await conn.execute('DELETE FROM broker_statement_previews WHERE owner_id=%s AND account_id=%s', (who.id, payload['accountId']))
            from .broker_statement_sources import BrokerStatementSources
            await BrokerStatementSources(self.db).advance_source_generation(conn, who, payload['accountId'])
            await conn.execute('INSERT INTO broker_account_collections(owner_id,revision) VALUES(%s,1) ON CONFLICT(owner_id) DO UPDATE SET revision=broker_account_collections.revision+1', (who.id,))
            result = {'request_id': request, 'kind': 'holding-source', 'account_id': payload['accountId'], 'state': 'completed', 'error': None,
                      'data': {'holdingSource': 'manual', 'financialHistoryChanged': False, 'snapshotsRetained': True, 'sourceConfigurationRetained': True, 'pendingContinuationInvalidated': True},
                      'collection_revision': (await self.versions(conn, who.id))[0]}
            if legacy_request_hash is not None:
                result["legacy_request_hash"] = legacy_request_hash
            if project is not None:
                result['legacy_snapshot'] = jsonable_encoder(await project(conn, who.id, payload['accountId']))
            await conn.execute('INSERT INTO broker_account_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)', (who.id, request, expected, Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'broker.holding-source',%s,%s)", (who.id, payload['accountId'], request))
            return result

    async def legacy_apply(self, who, account_id, raw, *, project=None):
        if (not isinstance(raw, dict) or set(raw) != {'requestId', 'revision', 'source', 'recordCollectionRevision'}
                or raw['source'] != 'manual'):
            raise HTTPException(422, '手动来源请求字段无效')
        legacy_hash = fingerprint({"accountId": account_id, "body": raw})
        try:
            original_request = UUID(raw['requestId'])
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(422, '原操作编号无效') from None
        async with self.context(who) as conn:
            previous = await (await conn.execute('SELECT result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s', (who.id, original_request))).fetchone()
            if previous:
                if previous['result'].get('state') != 'closed' and previous['result'].get('legacy_request_hash') != legacy_hash:
                    raise HTTPException(409, '原操作编号已用于其他请求，请查询原回执')
                return previous['result']
            account = await broker_account(conn, who.id, account_id)
            versions = await self.versions(conn, who.id)
            payload = command({'kind': 'holding-source', 'accountId': account_id,
                               'data': {'requestId': raw['requestId'], 'revision': raw['revision'], 'source': 'manual', 'accountKind': account['account_kind']},
                               'expectedCollectionRevision': versions[0], 'expectedRecordCollectionRevision': raw['recordCollectionRevision']})
            prior = await (await conn.execute('SELECT result FROM broker_account_operations WHERE owner_id=%s AND request_id=%s', (who.id, payload['data']['requestId']))).fetchone()
            if prior:
                result = prior['result']
                if result.get('state') != 'closed' and (result.get('kind') != 'holding-source' or result.get('account_id') != account_id):
                    raise HTTPException(409, '原操作编号已用于其他操作')
                return result
            preview = await self.preview(who, payload, connection=conn)
            return await self.submit(who, {'previewId': preview['previewId'], 'command': payload, 'acknowledgeProjectionChange': True}, connection=conn, project=project, legacy_request_hash=legacy_hash)
