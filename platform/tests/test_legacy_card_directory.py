import hashlib
import json
from uuid import uuid4

import pytest_asyncio
from test_legacy_asset_directory import SVG, write

P = '/api/admin/shared-assets'
FILE = 'Example%20region/Example%20card.svg'
AID = 'card:' + FILE

@pytest_asyncio.fixture(autouse=True)
async def cards(settings, tmp_path):
    settings.file_root = tmp_path / 'uploads'
    write(settings.file_root, 'cards/Example region/Example card.svg')
    manifest = {'regions': [{'label': 'Example region', 'banks': [{'name': 'Example bank', 'cards': [{'name': 'Example card', 'file': FILE}]}]}]}
    (settings.file_root / 'cards/manifest.json').write_text(json.dumps(manifest))
    settings.file_root.chmod(0o700)
    write(settings.file_root, 'cards/unlisted.svg')
    write(settings.file_root, 'avatar/private.svg')

async def listing(client):
    response = await client.get('/api/assets?type=card&paged=1&pageSize=18')
    assert response.status_code == 200, response.text
    return response.json()

async def replacement(client, raw=SVG.replace(b'M0 0', b'M9 9'), **override):
    head = (await client.get(P)).json()
    values = {'kind': 'asset', 'folder': 'card', 'name': 'Example card', 'market': 'Example region', 'code': 'EXAMPLE CARD', 'assetId': AID, 'catalogRevision': str((await listing(client))['revision']), 'requestId': str(uuid4()), 'expectedRevision': str(head['revision']), 'publicMetadataConfirmed': 'true', **override}
    return await client.post(P + '/upload', data=values, files={'file': ('chosen.svg', raw, 'image/svg+xml')})

async def test_manifest_lists_only_allowlisted_public_cards_without_seeding_business_records(client, db, settings):
    values = await listing(client)
    assert values['total'] == 1
    one = values['assets'][0]
    assert one['id'] == AID and one['name'] == 'Example card' and one['bank'] == 'Example bank'
    assert one['originalSha256'] == hashlib.sha256(SVG).hexdigest()
    assert (await client.get(one['imageUrl'])).status_code == 200
    for path in ['/uploads/cards/manifest.json', '/uploads/cards/unlisted.svg', '/uploads/avatar/private.svg']:
        assert (await client.get(path)).status_code in (400, 404)
    async with db.connection() as conn:
        for table in ['card_catalog_sources', 'card_catalog_public_index', 'card_custom_records', 'card_preference_collections']:
            assert (await (await conn.execute('SELECT count(*) n FROM ' + table)).fetchone())['n'] == 0

async def test_replacement_and_restore_share_card_index_and_keep_original_bytes(client, admin, settings, db):
    response = await replacement(client)
    assert response.status_code == 200, response.text
    first = response.json()
    assert first['binding']['id'] == AID and first['binding']['type'] == 'card'
    rows = await listing(client)
    assert rows['total'] == 1 and rows['assets'][0]['customized'] is True
    assert (await client.get(rows['assets'][0]['imageUrl'])).status_code == 200
    data = {'requestId': str(uuid4()), 'expectedRevision': first['revision'], 'catalogRevision': rows['revision'], 'assetId': AID, 'publicMetadataConfirmed': True}
    restored = await client.post(P + '/restore-card', json=data)
    assert restored.status_code == 200, restored.text
    assert (await client.post(P + '/restore-card', json=data)).json() == restored.json()
    assert restored.json()['originalSha256'] == hashlib.sha256(SVG).hexdigest()
    assert (await client.get(first['url'])).status_code == 200
    rows = await listing(client)
    assert rows['total'] == 1 and rows['assets'][0]['customized'] is False
    assert (settings.file_root / 'cards/Example region/Example card.svg').read_bytes() == SVG
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM card_catalog_public_index')).fetchone())['n'] == 1
        assert (await (await conn.execute('SELECT count(*) n FROM card_custom_records')).fetchone())['n'] == 0

async def test_stale_or_unlisted_card_never_publishes_new_cover(client, admin, db):
    for change in [{'catalogRevision': '9'}, {'assetId': 'card:../avatar/private.svg'}]:
        response = await replacement(client, **change)
        assert response.status_code == 409, response.text
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM system_asset_versions')).fetchone())['n'] == 0
        assert (await (await conn.execute('SELECT revision FROM system_asset_scope')).fetchone())['revision'] == 0

async def test_card_manifest_private_metadata_and_symlink_never_become_public(client, settings):
    p = settings.file_root / 'cards/manifest.json'
    raw = json.loads(p.read_text()); raw['accounts'] = [{'cardNumber': 'synthetic-private'}]
    p.write_text(json.dumps(raw))
    assert (await client.get('/api/assets?type=card&paged=1')).status_code >= 400

async def test_original_asset_card_photo_can_be_replaced_and_restored_without_duplicate_row(client, admin, settings):
    write(settings.file_root, 'asset/card/Manual.svg')
    rows = await listing(client)
    manual = next(row for row in rows['assets'] if row['id'].startswith('legacy-file:'))
    response = await replacement(client, assetId=manual['id'])
    assert response.status_code == 200, response.text
    rows = await listing(client)
    assert rows['total'] == 2
    one = next(row for row in rows['assets'] if row['id'] == manual['id'])
    assert one['customized'] is True
    data = {'requestId': str(uuid4()), 'expectedRevision': response.json()['revision'], 'catalogRevision': rows['revision'], 'assetId': manual['id'], 'publicMetadataConfirmed': True}
    result = await client.post(P + '/restore-card', json=data)
    assert result.status_code == 200, result.text
    assert result.json()['originalSha256'] == hashlib.sha256(SVG).hexdigest()
    assert (settings.file_root/'asset/card/Manual.svg').read_bytes() == SVG
    assert (await listing(client))['total'] == 2

async def test_card_library_reads_existing_manifest_without_import_or_account_writes(client, admin, db):
    response = await client.get('/api/cards')
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['sourceState'] == 'available' and data['source'] == 'runtime_public_card_manifest'
    assert data['regions'][0]['banks'][0]['cards'][0]['file'] == FILE
    assert data['holdings'] == [] and data['amounts'] == []
    async with db.connection() as conn:
        for table in ['card_catalog_sources','card_preference_collections','card_wallet_accounts','card_custom_records']:
            assert (await (await conn.execute('SELECT count(*) n FROM '+table)).fetchone())['n'] == 0

async def test_card_library_applies_removed_and_replaced_public_cards(client, admin):
    uploaded = await replacement(client)
    assert uploaded.status_code == 200, uploaded.text
    data = (await client.get('/api/cards')).json()
    assert data['covers'][FILE].startswith('/uploads/')
