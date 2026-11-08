"""Card covers use the existing public card index and immutable system image store."""
from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .card_catalog import can_publish_cards
from .card_catalog_contract import public_metadata
from .legacy_card_directory import LegacyCardDirectory
from .legacy_asset_directory import LegacyAssetDirectory, public_upload_root


class CardPublicAssets:
    def __init__(self, db, directory=None):
        self.db = db
        self.directory = directory or LegacyCardDirectory(public_upload_root(db.settings))

    async def source(self, aid):
        source = await self.directory.find(aid)
        if source is not None:
            return source
        assets = getattr(self.directory, 'asset_directory', None) or LegacyAssetDirectory(self.directory.root)
        row = next((row for row in await assets.entries() if row['id'] == aid and row['type'] == 'card'), None)
        return {**row, 'originalImageUrl': row['legacyPath'], 'bank': '', 'region': ''} if row else None

    async def bind(self, conn, who, expected, aid, version, reset=False, name=None):
        if not await can_publish_cards(conn, who):
            raise HTTPException(403, '当前连接没有卡面管理权限')
        revision = (await (await conn.execute('SELECT revision FROM asset_catalog_scope FOR UPDATE')).fetchone())['revision']
        if revision != expected or revision >= 9007199254740990:
            raise HTTPException(409, '公共素材目录已变化，请重新读取')
        tombstone = await (await conn.execute('SELECT 1 FROM asset_catalog_tombstones WHERE asset_id=%s AND restored_at IS NULL', (aid,))).fetchone()
        if tombstone:
            raise HTTPException(409, '卡面已移除，请先恢复素材')
        source = await self.source(aid)
        if source is None:
            raise HTTPException(409, '原始卡面清单已变化，请重新读取')
        old = await (await conn.execute('SELECT deleted_at,metadata,image_version FROM card_catalog_public_index WHERE image_path=%s', (source['originalImageUrl'],))).fetchone()
        if old and old['deleted_at'] and not reset:
            raise HTTPException(409, '卡面已移除，请明确恢复原图')
        label = name if name is not None else (old['metadata'].get('name') if old else None) or source['name']
        metadata = {'name': label, 'bank': source['bank'], 'region': source['region'], 'image': source['originalImageUrl'], 'libraryId': aid, 'libraryCustomized': (old['metadata'].get('libraryCustomized', False) if old else False) if name is not None else not reset}
        public_metadata(metadata)
        await conn.execute('INSERT INTO card_catalog_public_index(image_path,metadata,image_version,updated_by) VALUES(%s,%s,%s,%s) ON CONFLICT(image_path) DO UPDATE SET metadata=excluded.metadata,image_version=excluded.image_version,updated_by=excluded.updated_by,updated_at=clock_timestamp(),deleted_at=NULL', (source['originalImageUrl'], Jsonb(metadata), version, who.id))
        await conn.execute('UPDATE asset_catalog_scope SET revision=revision+1')
        return {'id': aid, 'type': 'card', 'market': (source['market'] or 'OTHER').upper(), 'code': label.upper(), 'revision': revision + 1, 'imageVersion': version}
