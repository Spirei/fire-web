"""One explicit old owned file capture and one CAS application through 55, not a new media store."""

import asyncio
import json
from uuid import UUID

from fastapi import HTTPException
from psycopg import DatabaseError
from psycopg.types.json import Jsonb

from .resource_media import ResourceMedia
from .source_budget import reserve
from .source_snapshot import SourceMismatch, canonical, sha
from .watch_group_icon_source import IconSourceError, load_icon_roots
from .watch_group_icons import WatchGroupIcons
from .watch_group_import import Bound, WatchGroupImport, identifier
from .watch_group_source_display import stored_text


class WatchGroupSourceIcons:
    def __init__(self, db, authority):
        self.db, self.authority = db, authority
        self.metadata = WatchGroupImport(db, authority)
        self.media = ResourceMedia(db.settings)
        self.after_read = None
        self.after_commit = None

    async def operation(self, conn, who, request, fingerprint=None):
        return await self.metadata.prior(conn, who, identifier(request), fingerprint)

    async def manifest(self, conn, who, manifest_id):
        return await self.metadata.manifest_row(conn, who, identifier(manifest_id), authorize=True)

    def root(self, grant):
        definition = self.authority.definition(grant)
        root = load_icon_roots(self.db.settings, self.authority.registry).get(definition.alias)
        if not root:
            raise IconSourceError('source_icon_root_not_registered')
        return root

    async def capture(self, who, manifest_id, command):
        request = identifier(command['requestId']); group = command['originalGroupId']
        fingerprint = sha(canonical({'domain': 'source_icon_capture', 'manifestId': str(manifest_id), **command}))
        async with self.db.connection() as conn, conn.transaction():
            await self.metadata.lock(conn, who)
            prior = await self.operation(conn, who, request, fingerprint)
            if prior:
                return prior['result']
            manifest = await self.manifest(conn, who, manifest_id)
            grant = await self.authority.grant(conn, who, manifest['grant_id'], manifest['grant_revision'])
            index = manifest['manifest']['groupIndex'].get(group)
            if not index or index.get('blocker'):
                raise HTTPException(409, '原分组编号或元数据尚未核实，不能取原图')
            raw = json.loads(bytes(manifest['raw']))
            original = next(row for row in raw['tables']['watch_groups'] if stored_text(row, 'id') == group)
            if stored_text(original, 'user_id') != grant['source_owner'] or sha(canonical(original)) != index['rowSha256']:
                raise HTTPException(409, '原分组字节或本人归属不匹配')
            reference_known = not original.get('icon', {}).get('null') and isinstance(original.get('icon', {}).get('text'), str)
            reference = stored_text(original, 'icon') or ''
            accepted = {'requestId': str(request), 'kind': 'capture', 'domain': 'source_icon', 'state': 'reading', 'manifestId': str(manifest_id), 'originalGroupId': group, 'platformInstance': str(self.db.settings.instance_id), 'reservationBytes': await reserve(conn, who.id, self.db.settings.instance_id), 'retry': 'query_original_uuid', 'financialApplied': False}
            await conn.execute("INSERT INTO watch_group_import_operations(owner_id,request_id,fingerprint,kind,state,result) VALUES(%s,%s,%s,'capture','reading',%s)", (who.id, request, fingerprint, Jsonb(accepted)))
        name = None; data = None; identity = None; binding = None; reason = None
        state = 'market_default' if index['kind'] == 'market' else 'empty' if not reference else 'captured'
        if not reference_known and index['kind'] != 'market':
            state, reason = 'blocked', 'source_icon_reference_missing_or_unsupported_storage'
        if state == 'market_default':
            reason = 'market_icon_keeps_client_MarketIcon_source_reference_not_imported' if reference else 'client_market_default_no_file'
        try:
            if state == 'captured':
                try:
                    root = self.root(grant); binding = root.binding()
                    name, data, identity = await asyncio.to_thread(root.read, grant['source_owner'], group, reference)
                except IconSourceError as error:
                    state, reason = 'blocked', str(error)
            if self.after_read:
                await self.after_read()
            async with self.db.connection() as conn, conn.transaction():
                await self.metadata.lock(conn, who)
                operation = await self.operation(conn, who, request)
                if operation['state'] != 'reading':
                    return operation['result']
                manifest = await self.manifest(conn, who, manifest_id)
                grant = await self.authority.grant(conn, who, manifest['grant_id'], manifest['grant_revision'])
                if state == 'captured' and self.root(grant).binding() != binding:
                    raise SourceMismatch('source_icon_registration_changed_during_read')
                digest = await self.media.stage(conn, who.id, data) if state == 'captured' else None
                if state == 'captured':
                    self.root(grant).check(grant['source_owner'])
                await conn.execute('INSERT INTO watch_group_source_icon_captures(owner_id,request_id,manifest_id,original_group_id,source_row_sha256,source_reference,root_binding_hash,state,reason,file_name,original_sha256,original_size,file_identity) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', (who.id, request, manifest_id, group, index['rowSha256'], reference, binding, state, reason, name, digest, len(data) if data is not None else None, Jsonb(identity) if identity else None))
                result = {'requestId': str(request), 'kind': 'capture', 'domain': 'source_icon', 'state': 'completed' if state in ('captured', 'empty') or state == 'market_default' and not reference and reference_known else 'completed_with_blocked', 'manifestId': str(manifest_id), 'originalGroupId': group, 'captureState': state, 'reason': reason, 'originalSha256': digest, 'originalSize': len(data) if data is not None else None, 'sourceReference': reference, 'sourceReferenceKnown': reference_known, 'rawSha256': manifest['raw_sha256'], 'sourceRowSha256': index['rowSha256'], 'sourceFileIdentity': identity, 'displayValidated': False, 'provenance': 'registered_owner_group_file_observed_at_explicit_capture_not_original_upload_hash', 'originalPath': '/api/watch-group-import/operations/'+str(request)+'/icon-original' if digest else None, 'financialApplied': False}
                await conn.execute("UPDATE watch_group_import_operations SET state='completed',result=%s,finished_at=clock_timestamp() WHERE owner_id=%s AND request_id=%s", (Jsonb(result), who.id, request))
                await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'watch-group-source.icon-captured',%s,%s)", (who.id, group, request))
            if self.after_commit:
                await self.after_commit(result)
            return result
        except Exception as error:
            async with self.db.connection() as conn, conn.transaction():
                row = await (await conn.execute('SELECT * FROM watch_group_import_operations WHERE owner_id=%s AND request_id=%s FOR UPDATE', (who.id, request))).fetchone()
                if row['state'] != 'reading':
                    if row['state'] == 'completed':
                        raise
                    return row['result']
                result = {'requestId': str(request), 'kind': 'capture', 'domain': 'source_icon', 'state': 'failed', 'manifestId': str(manifest_id), 'originalGroupId': group, 'reason': str(error) if isinstance(error, SourceMismatch) else 'source_icon_read_or_permission_changed', 'retry': 'query_original_uuid_then_explicit_new_request_after_review', 'financialApplied': False}
                await conn.execute("UPDATE watch_group_import_operations SET state='failed',result=%s,finished_at=clock_timestamp() WHERE owner_id=%s AND request_id=%s", (Jsonb(result), who.id, request))
                return result

    async def plan(self, conn, who, capture_id, replace):
        captured = await (await conn.execute('SELECT * FROM watch_group_source_icon_captures WHERE owner_id=%s AND request_id=%s', (who.id, identifier(capture_id)))).fetchone()
        if not captured:
            raise HTTPException(404, '本人原图捕获不存在')
        manifest = await self.manifest(conn, who, captured['manifest_id'])
        group = await (await conn.execute('SELECT g.* FROM watch_group_source_bindings b JOIN watch_groups g ON g.owner_id=b.owner_id AND g.id=b.target_group_id WHERE b.owner_id=%s AND b.source_instance=%s AND b.source_owner=%s AND b.original_group_id=%s AND g.deleted_at IS NULL', (who.id, manifest['source_instance'], manifest['source_owner'], captured['original_group_id']))).fetchone()
        revision = await (await conn.execute('SELECT revision FROM watch_group_collections WHERE owner_id=%s', (who.id,))).fetchone()
        blocker = ('source_original_not_captured' if captured['state'] != 'captured' else 'original_group_binding_missing' if not group else 'custom_group_required' if group['kind'] != 'custom' else 'current_icon_requires_explicit_replacement' if group['icon'] and not replace else None)
        value = {'captureRequestId': str(capture_id), 'manifestId': str(captured['manifest_id']), 'originalGroupId': captured['original_group_id'], 'originalSha256': captured['original_sha256'], 'originalSize': captured['original_size'], 'targetGroupId': group['id'] if group else None, 'beforeIcon': group['icon'] if group else None, 'groupRevision': revision['revision'] if revision else 0, 'replaceCurrent': replace, 'ready': blocker is None, 'blocker': blocker, 'financialApplied': False}
        value['preview'] = sha(canonical(value))
        return value, captured

    async def preview(self, who, capture_id, replace):
        async with self.db.connection() as conn, conn.transaction():
            await self.metadata.lock(conn, who)
            value, _ = await self.plan(conn, who, capture_id, replace)
            return value

    async def apply(self, who, capture_id, command):
        request = identifier(command['requestId']); fingerprint = sha(canonical({'domain': 'source_icon_apply', 'captureId': str(capture_id), **command}))
        try:
            return await self._apply(who, capture_id, command)
        except HTTPException as error:
            if error.status_code < 500:
                raise
            return await self.failed_apply(who, capture_id, request, fingerprint)
        except (OSError, RuntimeError, DatabaseError):
            return await self.failed_apply(who, capture_id, request, fingerprint)

    async def failed_apply(self, who, capture_id, request, fingerprint):
        async with self.db.connection() as conn, conn.transaction():
            await self.metadata.lock(conn, who)
            prior = await self.operation(conn, who, request, fingerprint)
            if prior:
                raise HTTPException(503, '响应未能确认，请查询原UUID回执')
            result = {'requestId': str(request), 'domain': 'source_icon', 'kind': 'apply', 'state': 'failed', 'reason': 'source_icon_apply_rolled_back', 'captureRequestId': str(capture_id), 'retry': 'query_original_uuid_then_explicit_new_request_after_review', 'financialApplied': False}
            await conn.execute("INSERT INTO watch_group_import_operations(owner_id,request_id,fingerprint,kind,state,result,finished_at) VALUES(%s,%s,%s,'apply','failed',%s,clock_timestamp())", (who.id, request, fingerprint, Jsonb(result)))
            return result

    async def _apply(self, who, capture_id, command):
        request = identifier(command['requestId']); fingerprint = sha(canonical({'domain': 'source_icon_apply', 'captureId': str(capture_id), **command}))
        async with self.db.connection() as conn, conn.transaction():
            await self.metadata.lock(conn, who)
            prior = await self.operation(conn, who, request, fingerprint)
            if prior:
                return prior['result']
            value, captured = await self.plan(conn, who, capture_id, command['replaceCurrent'])
            if not value['ready'] or value['preview'] != command['preview'] or value['groupRevision'] != command['expectedRevision']:
                raise HTTPException(409, '原图、来源归属、现图或版本已变化，请重新预览')
            raw = await self.media.read(conn, who.id, captured['original_sha256'])
            uploaded = await WatchGroupIcons(Bound(conn, self.db.settings)).upload(who, value['targetGroupId'], request, value['groupRevision'], captured['file_name'], raw, canonical=True)
            if uploaded['state'] == 'completed':
                await conn.execute('INSERT INTO watch_group_source_icon_links(owner_id,request_id,capture_request_id,target_group_id,version_id) VALUES(%s,%s,%s,%s,%s)', (who.id, request, capture_id, value['targetGroupId'], UUID(uploaded['icon']['version'])))
            result = {**uploaded, 'domain': 'source_icon', 'kind': 'apply', 'captureRequestId': str(capture_id), 'manifestId': str(captured['manifest_id']), 'originalGroupId': captured['original_group_id'], 'sourceOriginalSha256': captured['original_sha256'], 'financialApplied': False}
            await conn.execute('INSERT INTO watch_group_import_operations(owner_id,request_id,fingerprint,kind,state,result,finished_at) VALUES(%s,%s,%s,\'apply\',%s,%s,clock_timestamp())', (who.id, request, fingerprint, uploaded['state'], Jsonb(result)))
        if self.after_commit:
            await self.after_commit(result)
        return result

    async def original(self, who, capture_id):
        async with self.db.connection() as conn, conn.transaction():
            await self.metadata.lock(conn, who)
            row = await (await conn.execute("SELECT * FROM watch_group_source_icon_captures WHERE owner_id=%s AND request_id=%s AND state='captured'", (who.id, identifier(capture_id)))).fetchone()
            if not row:
                raise HTTPException(404, '本人原图捕获不存在')
            return row, await self.media.open(conn, who.id, row['original_sha256'])
