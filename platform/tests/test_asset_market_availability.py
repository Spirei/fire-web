from uuid import uuid4
import pytest_asyncio
from test_legacy_asset_directory import SVG, write

@pytest_asyncio.fixture(autouse=True)
async def library(settings, tmp_path):
    settings.file_root = tmp_path / 'uploads'
    write(settings.file_root, 'asset/stock/US/DEMO.svg')
    write(settings.file_root, 'asset/stock/SG/BAD.svg', b'<svg><script>bad</script></svg>')
    write(settings.file_root, 'asset/flag/GB.svg')
    settings.file_root.chmod(0o700)

async def test_only_markets_with_verified_stock_art_are_available_not_flags_or_unsafe_files(client, admin):
    response = await client.get('/api/assets?type=stock&marketAvailability=1')
    assert response.status_code == 200
    assert response.json() == {'markets': ['US']}
    data = {'requestId': str(uuid4()), 'expectedRevision': 0, 'publicMetadataConfirmed': True, 'asset': {'id':'stock:GB:NOPHOTO','type':'stock','market':'GB','code':'NOPHOTO','name':'No image'}, 'restore': False}
    assert (await client.post('/api/admin/asset-catalog/entries', json=data)).status_code == 200
    assert (await client.get('/api/assets?type=stock&marketAvailability=1')).json() == {'markets': ['US']}
    # Explicit metadata and deletion remain authoritative over original filenames.
    data.update(requestId=str(uuid4()),expectedRevision=1,asset={'id':'stock:US:DEMO','type':'stock','market':'US','code':'DEMO','name':'Metadata only'})
    assert (await client.post('/api/admin/asset-catalog/entries', json=data)).status_code == 200
    assert (await client.get('/api/assets?type=stock&marketAvailability=1')).json() == {'markets': []}
