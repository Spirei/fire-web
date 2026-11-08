"""Explicit public card metadata snapshots and owner-isolated custom card associations."""

import hashlib
import asyncio
import json
from contextlib import asynccontextmanager
from datetime import UTC
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .card_catalog_contract import custom_input, key_of, manifest_value, public_manifest, sqlite_metadata
from .card_preferences import JS_WHITESPACE, persist_json, restore_json
from .security import lock_mutation_identity


def canonical(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False)


def card_value(row):
    return dict(restore_json(row['metadata']), id=str(row['id']), createdAt=row['created_at'].astimezone(UTC).isoformat(timespec='milliseconds').replace('+00:00', 'Z'))


class CardCatalog:
    def __init__(self, db):
        self.db = db

    @asynccontextmanager
    async def context(self, who, *, write=False, admin=False):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('identity-management:' + who.id,))
            await lock_mutation_identity(conn, who, require_admin=admin)
            if admin and not await can_publish_cards(conn,who):
                raise HTTPException(403,'当前连接没有卡面管理权限')
            await conn.execute('SELECT pg_advisory_xact_lock' + ('' if write else '_shared') + "(hashtextextended('card-catalog',0))")
            yield conn

    async def source(self, conn):
        return await (await conn.execute('SELECT c.revision,s.* FROM card_catalog_scope c LEFT JOIN card_catalog_sources s ON s.id=c.current_source WHERE c.singleton')).fetchone()

    async def snapshot(self, who):
        async with self.context(who) as conn:
            source = await self.source(conn)
            administrative = await can_publish_cards(conn,who)
            rows = await (await conn.execute('SELECT * FROM card_custom_records WHERE owner_id=%s AND deleted_at IS NULL ORDER BY created_at,id', (who.id,))).fetchall()
            own = await (await conn.execute('SELECT revision FROM card_preference_collections WHERE owner_id=%s', (who.id,))).fetchone()
            # Actual shared image registry only; source manifests never prove byte availability.
            images = await (await conn.execute("SELECT p.public_path,v.served_sha256,v.id FROM system_asset_paths p JOIN system_asset_versions v ON v.id=p.current_version WHERE v.kind='asset' AND v.folder='card' ORDER BY p.public_path LIMIT 1001")).fetchall()
            published = await published_card_assets(conn, limit=201)
            return {'publishedAssets': published[:200], 'publishedAssetsPartial': len(published) > 200, 'sourceRevision': source['revision'], 'source': None if source['id'] is None else {
                'id': str(source['id']), 'sha256': source['sha256'], 'sourceLabel': source['source_label'] if administrative else None,
                'cardCount': source['card_count'], 'importedAt': source['imported_at'].isoformat(),
                'manifest': public_manifest(restore_json(source['manifest'])), 'coverage': 'captured-metadata-only',
            }, 'customCards': [dict(card_value(row), materialState='registered-shared-image' if row['image_version'] else 'unverified-reference') for row in rows],
                'preferenceRevision': own['revision'] if own else 0,
                'availableImages': [{'path': row['public_path'], 'sha256': row['served_sha256'], 'version': str(row['id'])} for row in images[:1000]],
                'availableImagesPartial': len(images) > 1000}

    async def preview(self, who, text, label):
        value = manifest_value(text, label)
        async with self.context(who, admin=True) as conn:
            source = await self.source(conn)
            return {'sha256': value['sha256'], 'sourceLabel': value['sourceLabel'], 'cardCount': value['cardCount'],
                    'regionCount': len(value['manifest']['regions']), 'sourceRevision': source['revision'],
                    'coverage': 'captured-metadata-only', 'materialBytesImported': False}

    async def prior(self, conn, who, identifier, fingerprint):
        row = await (await conn.execute('SELECT fingerprint,result FROM card_catalog_operations WHERE owner_id=%s AND request_id=%s', (who.id, identifier))).fetchone()
        if row:
            if restore_json(row['result']).get('state') == 'closed':
                raise HTTPException(409, '原请求已关闭')
            if row['fingerprint'] != fingerprint:
                raise HTTPException(409, '原UUID已用于其他卡面操作')
            return restore_json(row['result'])
        return None

    async def record(self, conn, who, identifier, fingerprint, result, action):
        await conn.execute('INSERT INTO card_catalog_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)', (who.id, identifier, fingerprint, Jsonb(persist_json(result))))
        await conn.execute('INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,%s,%s)', (who.id, action, identifier))
        return result

    async def import_source(self, who, text, label, identifier, expected_revision, expected_digest):
        value = manifest_value(text, label)
        if value['sha256'] != expected_digest:
            raise HTTPException(409, '清单内容已变化，请重新预览')
        fingerprint = hashlib.sha256(canonical(['source', value['sha256'], value['sourceLabel'], expected_revision]).encode()).hexdigest()
        async with self.context(who, write=True, admin=True) as conn:
            if previous := await self.prior(conn, who, identifier, fingerprint):
                return previous
            source = await self.source(conn)
            if type(expected_revision) is not int or expected_revision != source['revision']:
                raise HTTPException(409, '卡面来源已变化，请重新预览')
            source_id = uuid4()
            await conn.execute('INSERT INTO card_catalog_sources(id,sha256,source_label,manifest,original_text,card_count,imported_by) VALUES(%s,%s,%s,%s,%s,%s,%s)', (source_id, value['sha256'], value['sourceLabel'], Jsonb(persist_json(value['manifest'])), text, value['cardCount'], who.id))
            await conn.execute('UPDATE card_catalog_scope SET current_source=%s,revision=revision+1 WHERE singleton', (source_id,))
            return await self.record(conn, who, identifier, fingerprint, {'requestId': str(identifier), 'kind': 'source_import', 'state': 'completed', 'sourceId': str(source_id), 'sourceRevision': source['revision'] + 1, 'sha256': value['sha256'], 'cardCount': value['cardCount']}, 'cards.source.imported')

    async def lock_preferences(self, conn, owner, expected):
        await conn.execute('INSERT INTO card_preference_collections(owner_id) VALUES(%s) ON CONFLICT DO NOTHING', (owner,))
        current = await (await conn.execute('SELECT revision FROM card_preference_collections WHERE owner_id=%s FOR UPDATE', (owner,))).fetchone()
        if expected is not None and (type(expected) is not int or expected != current['revision']):
            raise HTTPException(409, '卡包偏好已变化，请重新读取')
        return current['revision']

    async def create(self, who, raw, identifier, expected=None):
        value = custom_input(raw)
        fingerprint = hashlib.sha256(canonical(['create', value, expected]).encode()).hexdigest()
        async with self.context(who, write=True) as conn:
            if previous := await self.prior(conn, who, identifier, fingerprint):
                return previous
            source = await self.source(conn)
            if source['id'] is None:
                from .legacy_card_directory import LegacyCardDirectory
                from .legacy_asset_directory import public_upload_root
                source_value = await asyncio.to_thread(LegacyCardDirectory(public_upload_root(self.db.settings)).manifest)
                if source_value is None:
                    raise HTTPException(409, '卡面来源尚未核对，请先导入清单')
            else:
                source_value = restore_json(source['manifest'])
            index = manifest_value(canonical(source_value), source['source_label'] or '运行目录原始卡面清单')['nameKeys']
            existing = await (await conn.execute('SELECT metadata FROM card_custom_records WHERE owner_id=%s AND deleted_at IS NULL', (who.id,))).fetchall()
            if key_of(value) in index or any(key_of(restore_json(row['metadata'])) == key_of(value) for row in existing):
                raise HTTPException(409, '卡面库里已经有这张卡了（同名 + 同银行）')
            revision = await self.lock_preferences(conn, who.id, expected)
            # Freeze an existing shared image identity if available. A legacy opaque URL stays explicitly unverified.
            await conn.execute("SELECT pg_advisory_xact_lock_shared(hashtextextended('system-public-assets',0))")
            stored_metadata = sqlite_metadata(value)
            image_key = stored_metadata['image']
            if '\x00' in image_key:
                image_key = 'json:' + canonical(image_key)
            image = await (await conn.execute('SELECT p.current_version FROM system_asset_paths p WHERE public_path=%s', (image_key,))).fetchone()
            material = image['current_version'] if image else None
            row = await (await conn.execute('INSERT INTO card_custom_records(owner_id,id,metadata,image_path,image_version) VALUES(%s,%s,%s,%s,%s) RETURNING *', (who.id, uuid4(), Jsonb(persist_json(stored_metadata)), image_key, material))).fetchone()
            if await can_publish_cards(conn,who):
                await conn.execute('INSERT INTO card_catalog_public_index(image_path,metadata,image_version,updated_by) VALUES(%s,%s,%s,%s) ON CONFLICT(image_path) DO UPDATE SET metadata=excluded.metadata,image_version=excluded.image_version,updated_by=excluded.updated_by,updated_at=clock_timestamp(),deleted_at=NULL', (image_key, Jsonb(persist_json(stored_metadata)), material, who.id))
            await conn.execute('UPDATE card_preference_collections SET revision=revision+1 WHERE owner_id=%s', (who.id,))
            # The legacy creator returns original JS fields, while later SQLite reads contain UTF-8 replacement.
            card = dict(value, id=str(row['id']), createdAt=card_value(row)['createdAt'])
            return await self.record(conn, who, identifier, fingerprint, {'requestId': str(identifier), 'kind': 'custom_create', 'state': 'completed', 'card': card, 'preferenceRevision': revision + 1, 'sourceRevision': source['revision'], 'materialState': 'registered-shared-image' if material else 'unverified-reference'}, 'cards.custom.created')

    async def delete(self, who, raw_id, identifier, expected=None):
        if not raw_id:
            raise HTTPException(400, '缺少卡片标识')
        try:
            card_id = UUID(raw_id)
        except (ValueError, TypeError, AttributeError):
            raise HTTPException(404, '这张卡不存在') from None
        fingerprint = hashlib.sha256(canonical(['delete', str(card_id), expected]).encode()).hexdigest()
        async with self.context(who, write=True) as conn:
            if previous := await self.prior(conn, who, identifier, fingerprint):
                return previous
            row = await (await conn.execute('SELECT * FROM card_custom_records WHERE owner_id=%s AND id=%s AND deleted_at IS NULL FOR UPDATE', (who.id, card_id))).fetchone()
            if not row:
                raise HTTPException(404, '这张卡不存在')
            revision = await self.lock_preferences(conn, who.id, expected)
            await conn.execute('UPDATE card_custom_records SET deleted_at=clock_timestamp() WHERE owner_id=%s AND id=%s', (who.id, card_id))
            await conn.execute('UPDATE card_preference_holdings SET held=false WHERE owner_id=%s AND card_key=%s', (who.id, row['image_path']))
            administrative = await can_publish_cards(conn,who)
            used = await (await conn.execute('SELECT 1 FROM card_custom_records WHERE image_path=%s AND deleted_at IS NULL LIMIT 1', (row['image_path'],))).fetchone()
            if administrative and not used:
                # Only the publication association is retired. Immutable shared bytes/other owners remain untouched.
                await conn.execute('UPDATE card_catalog_public_index SET deleted_at=clock_timestamp(),updated_by=%s WHERE image_path=%s', (who.id, row['image_path']))
            await conn.execute('UPDATE card_preference_collections SET revision=revision+1 WHERE owner_id=%s', (who.id,))
            return await self.record(conn, who, identifier, fingerprint, {'requestId': str(identifier), 'kind': 'custom_delete', 'state': 'completed', 'ok': True, 'preferenceRevision': revision + 1}, 'cards.custom.deleted')

    async def original(self, who, source_id):
        async with self.context(who, admin=True) as conn:
            row = await (await conn.execute('SELECT original_text,sha256 FROM card_catalog_sources WHERE id=%s', (source_id,))).fetchone()
            if not row:
                raise HTTPException(404, '卡面来源不存在')
            raw = row['original_text'].encode('utf-8')
            if hashlib.sha256(raw).hexdigest() != row['sha256']:
                raise HTTPException(503, '卡面来源摘要不匹配')
            return raw, row['sha256']

    async def close(self, who, identifier, kind):
        if kind not in ('source_import', 'custom_create', 'custom_delete'):
            raise HTTPException(400, '原卡面操作类型无效')
        async with self.context(who, write=True) as conn:
            previous = await (await conn.execute('SELECT result FROM card_catalog_operations WHERE owner_id=%s AND request_id=%s', (who.id, identifier))).fetchone()
            if previous:
                return restore_json(previous['result'])
            result = {'requestId': str(identifier), 'kind': kind, 'state': 'closed'}
            fingerprint = hashlib.sha256(canonical(['closed', str(identifier), kind]).encode()).hexdigest()
            return await self.record(conn, who, identifier, fingerprint, result, 'cards.operation.closed')

    async def receipt(self, who, identifier):
        async with self.context(who) as conn:
            row = await (await conn.execute('SELECT result FROM card_catalog_operations WHERE owner_id=%s AND request_id=%s', (who.id, identifier))).fetchone()
            if not row:
                raise HTTPException(404, '回执不存在')
            return restore_json(row['result'])


async def purge_owner(conn, owner):
    """Remove private card associations/receipts during the existing closure transaction."""
    installed = (await (await conn.execute(
        "SELECT EXISTS(SELECT 1 FROM public.schema_migrations WHERE name='0081_card_catalog.sql') AS installed"
    )).fetchone())['installed']
    for table in ('card_catalog_operations', 'card_custom_records'):
        if not installed:
            present = await (await conn.execute('SELECT to_regclass(%s) AS relation', ('public.' + table,))).fetchone()
            if present['relation'] is None:
                continue
            raise HTTPException(503, '卡面数据结构尚未完整核对')
        # A current schema claiming this migration must contain these tables. Errors abort closure.
        await conn.execute('DELETE FROM ' + table + ' WHERE owner_id=%s', (owner,))


async def published_card_assets(conn, limit=None, *, include_deleted=False):
    """Read-only projection for the unified shared-asset catalog; never copy card metadata elsewhere."""
    await conn.execute("SELECT pg_advisory_xact_lock_shared(hashtextextended('card-catalog',0))")
    if limit is not None and (type(limit) is not int or not 1 <= limit <= 10000):
        raise HTTPException(400, '卡面目录读取上限无效')
    query = 'SELECT metadata,image_version,updated_at FROM card_catalog_public_index' + ('' if include_deleted else ' WHERE deleted_at IS NULL') + ' ORDER BY updated_at,image_path'
    rows = await (await conn.execute(query + (' LIMIT %s' if limit is not None else ''), (limit,) if limit is not None else ())).fetchall()
    items = []
    for row in rows:
        value = restore_json(row['metadata'])
        # This index is populated only by an administrator's explicit public custom-card registration.
        items.append({'id': value.get('libraryId') or 'card:' + value['image'], 'type': 'card',
                      'bank': value.get('bank', ''), 'region': value.get('region', ''),
                      'originalImageUrl': value['image'] if value.get('libraryId') else None,
                      'customized': value.get('libraryCustomized', False),
                      'market': (value.get('region') or 'OTHER').strip(JS_WHITESPACE).upper(),
                      'code': (value.get('name') or 'CARD').strip(JS_WHITESPACE).upper(), 'name': value.get('name', ''),
                      'url': value['image'], 'source': 'manual',
                      'materialState': 'registered-shared-image' if row['image_version'] else 'unverified-reference',
                      'imageVersion': str(row['image_version']) if row['image_version'] else None,
                      'updatedAt': row['updated_at'].astimezone(UTC).isoformat(timespec='milliseconds').replace('+00:00', 'Z')})
    return items


async def can_publish_cards(conn,who):
    if getattr(who,'grant_id',None):
        return False
    row=await(await conn.execute("SELECT u.role,s.client_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=%s AND s.user_id=%s",(who.token_hash,who.id))).fetchone()
    return bool(row and row['role']=='admin' and row['client_id'] in ('new-web','legacy-web'))
