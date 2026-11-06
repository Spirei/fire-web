import hashlib
from uuid import uuid4
import pytest_asyncio
from test_legacy_asset_directory import SVG, write

@pytest_asyncio.fixture(autouse=True)
async def public_files(settings, tmp_path):
    settings.file_root = tmp_path / 'uploads'
    write(settings.file_root, 'asset/market/US.svg')
    settings.file_root.chmod(0o700)

async def test_market_label_edit_preserves_original_and_replays_one_operation(client, admin, settings, db):
    before = (await client.get('/api/assets?type=market&paged=1')).json()
    aid = before['assets'][0]['id']
    body = {'requestId': str(uuid4()), 'expectedRevision': before['revision'], 'publicMetadataConfirmed': True, 'asset': {'id': aid, 'name': '自定义美股名称'}, 'restore': False}
    response = await client.put('/api/admin/asset-catalog/entries/' + aid, json=body)
    assert response.status_code == 200, response.text
    assert response.json()['asset']['name'] == '自定义美股名称'
    assert (await client.put('/api/admin/asset-catalog/entries/' + aid, json=body)).json() == response.json()
    rows = (await client.get('/api/assets?type=market&paged=1')).json()
    assert rows['total'] == 1 and rows['assets'][0]['name'] == '自定义美股名称'
    assert (await client.get(rows['assets'][0]['imageUrl'])).status_code == 200
    assert (settings.file_root/'asset/market/US.svg').read_bytes() == SVG
    async with db.connection() as conn:
        image = await (await conn.execute('SELECT original_sha256 FROM system_asset_versions')).fetchone()
        assert image['original_sha256'] == hashlib.sha256(SVG).hexdigest()
        assert (await (await conn.execute('SELECT count(*) n FROM asset_catalog_entries')).fetchone())['n'] == 1

async def test_missing_image_market_can_be_named_without_inventing_image_bytes(client, admin, db):
    body = {'requestId': str(uuid4()), 'expectedRevision': 0, 'publicMetadataConfirmed': True, 'asset': {'id': 'market:SG', 'name': '新加坡市场'}, 'restore': False}
    response = await client.put('/api/admin/asset-catalog/entries/market:SG', json=body)
    assert response.status_code == 200, response.text
    assert response.json()['asset']['imageUrl'] == ''
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM system_asset_versions')).fetchone())['n'] == 0
    assert (await client.put('/api/admin/asset-catalog/entries/market:US', json=body)).status_code == 400
