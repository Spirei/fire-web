"""One read-only, owner-scoped projection of card metadata, preferences and balances."""

import asyncio
from datetime import UTC, datetime

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .card_catalog import CardCatalog
from .card_preferences import CardPreferences
from .card_preferences_protocol import card_member
from .card_wallet import CardWallet
from .market_contract import canonical
from .market_worker import Bound
from .security import COOKIE, identity, lock_mutation_identity


def mount_card_library(app, db):
    async def read(request, current=False):
        headers = {'Cache-Control': 'private, no-store', 'Vary': 'Cookie, Authorization'}
        try:
            if request.query_params:
                raise HTTPException(400, '卡面清单不接受查询参数')
            if current or request.cookies.get(COOKIE) or request.headers.get('x-csrf-token'):
                if 'authorization' in request.headers:
                    raise HTTPException(401, '请使用当前网页会话')
                who = await identity(request)
            else:
                who = await card_member(request, db)
            async with db.connection() as conn, conn.transaction():
                await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
                await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',
                                   ('identity-management:' + who.id,))
                await lock_mutation_identity(conn, who, require_admin=False)
                bound = Bound(conn, db.settings)
                catalog = await CardCatalog(bound).snapshot(who)
                preferences = await CardPreferences(bound).read(who)
                accounts = await (await conn.execute(
                    'SELECT card_key,amount,currency,note,updated_at FROM card_wallet_accounts '
                    'WHERE owner_id=%s ORDER BY updated_at DESC,card_key LIMIT 5001', (who.id,),
                )).fetchall()
                if len(accounts) > 5000:
                    raise HTTPException(409, '卡包清单超出整页读取预算，请使用卡包分页入口')
                # Read metadata directly; wallet snapshot's legacy initialization is
                # unnecessary here. This GET never creates a financial collection.
                details = await CardWallet(bound).details(conn, who.id)
                source = catalog['source']
                manifest = source['manifest'] if source else {'regions': [], 'typeOrder': []}
                runtime = None
                directory = getattr(app.state, 'legacy_card_directory', None)
                if source is None and directory is not None:
                    runtime = await asyncio.to_thread(directory.manifest)
                    if runtime is not None:
                        manifest = runtime
                published = await (await conn.execute(
                    'SELECT p.image_path,p.metadata,p.deleted_at,v.public_path,v.served_sha256 FROM card_catalog_public_index p '
                    'LEFT JOIN system_asset_versions v ON v.id=p.image_version '
                    'ORDER BY p.image_path LIMIT 10001',
                )).fetchall()
                if len(published) > 10000:
                    raise HTTPException(409, '卡面覆盖表超出完整读取预算')
                covers = {row['image_path']: row['public_path'] + '?sha256=' + row['served_sha256']
                          for row in published if not row['deleted_at'] and row['public_path'] and row['served_sha256']}
                if runtime is not None:
                    from urllib.parse import quote
                    overrides = {row['image_path']: row for row in published}
                    removed = {row['asset_id'] for row in await (await conn.execute(
                        'SELECT asset_id FROM asset_catalog_tombstones WHERE restored_at IS NULL'
                    )).fetchall()}
                    for region in manifest['regions']:
                        for bank in region.get('banks', []):
                            visible = []
                            for card in bank.get('cards', []):
                                path = '/uploads/cards/' + quote(card['file'], safe='/%')
                                override = overrides.get(path)
                                if 'card:' + card['file'] in removed or override and override['deleted_at']:
                                    continue
                                if override and override['metadata'].get('name'):
                                    card['name'] = override['metadata']['name']
                                if path in covers:
                                    covers[card['file']] = covers[path]
                                visible.append(card)
                            bank['cards'] = visible
                value = {
                    **manifest, 'updatedAt': source['importedAt'] if source else None,
                    'source': 'registered_card_manifest' if source else 'runtime_public_card_manifest' if runtime is not None else '',
                    'sourceRevision': catalog['sourceRevision'],
                    'sourceState': 'available' if source or runtime is not None else 'unavailable',
                    **({'error': '卡面清单暂时无法读取，请检查原有卡面目录挂载'} if source is None and runtime is None else {}),
                    'preferenceRevision': preferences['revision'],
                    'amounts': [{'cardKey': row['card_key'], 'amount': row['amount'],
                                 'currency': row['currency'], 'note': row['note'],
                                 'updatedAt': row['updated_at'].isoformat(),
                                 'amountKnown': row['amount'] is not None} for row in accounts],
                    'tags': preferences['tags'], 'holdings': preferences['holdings'],
                    'nowMs': int(datetime.now(UTC).timestamp() * 1000),
                    'firstSeen': {row['image']: row['createdAt'] for row in catalog['customCards']
                                  if row.get('image') and row.get('createdAt')},
                    'firstSeenCoverage': 'owner_custom_cards_only',
                    'details': details, 'secretFields': 'masked', 'covers': covers,
                    'customCards': catalog['customCards'], 'collectionOnRead': False,
                }
            encoded = canonical(value).encode('utf-8', 'backslashreplace')
            if len(encoded) > 8 * 1024 * 1024:
                raise HTTPException(409, '卡面聚合超出完整读取预算')
            return Response(encoded, media_type='application/json', headers=headers)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                headers['X-Alcor-Retire-Context'] = 'true'
            return JSONResponse({'error': str(exc.detail)}, status_code=exc.status_code, headers=headers)

    @app.get('/api/cards')
    async def legacy(request: Request):
        return await read(request)

    @app.get('/api/account/card-library')
    async def current(request: Request):
        return await read(request, current=True)
