"""Material edits are metadata operations; originals and business records stay untouched."""
import json
from urllib.parse import quote
from uuid import uuid4
import pytest
import pytest_asyncio
from test_legacy_asset_directory import SVG, write

P = '/api/admin/asset-catalog'

@pytest_asyncio.fixture(autouse=True)
async def originals(settings, tmp_path):
    settings.file_root = tmp_path / 'uploads'
    for path in ['asset/stock/US/RKLB.svg','asset/flag/AD.svg','asset/broker/华泰证券.svg','asset/broker/HK/HKDemo.svg','asset/crypto/BTC.svg','asset/group/owner-secret/group-secret/private.svg']:
        write(settings.file_root, path)
    write(settings.file_root, 'cards/Example region/Example card.svg')
    manifest={'regions':[{'label':'Example region','banks':[{'name':'Example bank','cards':[{'name':'Example card','file':'Example%20region/Example%20card.svg'}]}]}]}
    (settings.file_root/'cards/manifest.json').write_text(json.dumps(manifest))
    settings.file_root.chmod(0o700)

async def rows(client, kind, deleted=False):
    path=P+'/entries?' if deleted else '/api/assets?'
    result=await client.get(path+f'type={kind}&paged=1&pageSize=100'+('&deleted=1' if deleted else ''))
    assert result.status_code==200, result.text
    return result.json()

@pytest.mark.parametrize('kind',['flag','broker','crypto','card'])
async def test_inline_rename_all_materials_keeps_identity_original_and_replay(client, admin, settings, kind):
    before=await rows(client,kind); asset=before['assets'][0]
    body={'requestId':str(uuid4()),'expectedRevision':before['revision'],'publicMetadataConfirmed':True,'asset':{'id':asset['id'],'name':'本人修改名称'},'restore':False}
    url=P+'/entries/'+quote(asset['id'],safe='')
    response=await client.put(url,json=body)
    assert response.status_code==200,response.text
    assert (await client.put(url,json=body)).json()==response.json()
    after=await rows(client,kind)
    one=next(r for r in after['assets'] if r['id']==asset['id'])
    assert one['name']=='本人修改名称'
    assert (await client.get(one['imageUrl'])).status_code==200
    if kind=='card': assert one['customized'] is False
    assert all(p.read_bytes()==SVG for p in settings.file_root.rglob('*.svg'))

async def test_stock_add_uses_independent_market_and_ticker_without_quotes(client,admin,db):
    for revision,(market,code) in enumerate([('US','RKLX'),('US','AAPU'),('HK','RKLX')]):
        body={'requestId':str(uuid4()),'expectedRevision':revision,'publicMetadataConfirmed':True,'asset':{'type':'stock','market':market,'code':code,'name':code},'restore':False}
        response=await client.post(P+'/entries',json=body)
        assert response.status_code==200,response.text
        assert response.json()['asset']['id']==f'stock:{market}:{code}'
        assert (await client.post(P+'/entries',json=body)).json()==response.json()
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM asset_catalog_entries')).fetchone())['n']==3

async def test_removed_original_never_resurrects_in_list_lookup_or_availability_and_can_restore(client,admin,settings):
    before=await rows(client,'stock'); aid=before['assets'][0]['id']; rid=str(uuid4())
    url=P+'/entries/'+aid+f'?requestId={rid}&expectedRevision={before["revision"]}'
    response=await client.delete(url)
    assert response.status_code==200,response.text
    assert (await client.delete(url)).json()==response.json()
    assert (await rows(client,'stock'))['assets']==[]
    assert (await client.get('/api/assets?type=stock&keys=US:RKLB')).json()['assets']==[]
    assert (await client.get('/api/assets?type=stock&marketAvailability=1')).json()=={'markets':[]}
    assert (await rows(client,'stock',True))['assets'][0]['id']==aid
    body={'requestId':str(uuid4()),'expectedRevision':response.json()['revision'],'assetId':aid}
    restored=await client.post(P+'/restore',json=body)
    assert restored.status_code==200,restored.text
    assert (await client.post(P+'/restore',json=body)).json()==restored.json()
    assert (await rows(client,'stock'))['assets'][0]['id']==aid
    assert (settings.file_root/'asset/stock/US/RKLB.svg').read_bytes()==SVG

async def test_country_and_broker_originals_rename_and_remove_without_exposing_owner_group_files(client,admin):
    flags=await rows(client,'flag');aid=flags['assets'][0]['id']
    response=await client.delete(P+'/entries/'+aid+f'?requestId={uuid4()}&expectedRevision={flags["revision"]}')
    assert response.status_code==200,response.text
    assert (await client.get('/api/assets?type=flag&keys=AD')).json()['assets']==[]
    assert (await rows(client,'group'))['assets']==[]
    assert (await client.get('/uploads/asset/group/owner-secret/group-secret/private.svg')).status_code==404

async def test_brokers_with_same_code_in_different_markets_remain_separate(client,admin):
    for revision,market in enumerate(['US','HK','CN']):
        body={'requestId':str(uuid4()),'expectedRevision':revision,'publicMetadataConfirmed':True,'asset':{'type':'broker','market':market,'code':'SAME','name':market+'券商'},'restore':False}
        response=await client.post(P+'/entries',json=body)
        assert response.status_code==200,response.text
    results=await rows(client,'broker')
    assert {r['id'] for r in results['assets'] if r['code']=='SAME'}=={'broker:US:SAME','broker:HK:SAME','broker:CN:SAME'}

async def test_card_name_survives_replacement_and_restoration_then_soft_remove(client,admin,settings):
    before=await rows(client,'card');asset=before['assets'][0]
    rename={'requestId':str(uuid4()),'expectedRevision':before['revision'],'publicMetadataConfirmed':True,'asset':{'id':asset['id'],'name':'保留卡名'},'restore':False}
    result=await client.put(P+'/entries/'+quote(asset['id'],safe=''),json=rename)
    assert result.status_code==200,result.text
    for action in ['delete','restore']:
        current=await rows(client,'card'); rev=current['revision']
        if action=='delete': result=await client.delete(P+'/entries/'+quote(asset['id'],safe='')+f'?requestId={uuid4()}&expectedRevision={rev}')
        else: result=await client.post(P+'/restore',json={'requestId':str(uuid4()),'expectedRevision':rev,'assetId':asset['id']})
        assert result.status_code==200,result.text
        assert (await rows(client,'card'))['total']==(0 if action=='delete' else 1)
    assert (await rows(client,'card'))['assets'][0]['name']=='保留卡名'
    assert (settings.file_root/'cards/Example region/Example card.svg').read_bytes()==SVG

async def test_unified_paged_catalog_includes_originals_for_all_clients_and_chinese_region_labels(client):
    for kind in ['stock','flag','broker','card']:
        response=await client.get('/api/asset-catalog',params={'type':kind,'paged':'1','pageSize':1})
        assert response.status_code==200,response.text
        data=response.json()
        assert data['page']==1 and data['pageSize']==1 and len(data['assets'])==1
        assert type(data['revision']) is int
        assert data['assets'][0]['type']==kind
        assert (await client.get(data['assets'][0]['imageUrl'])).status_code==200
        if kind=='flag': assert data['assets'][0]['name']=='安道尔'

async def test_raw_card_files_do_not_break_other_material_category_lists(client,settings):
    write(settings.file_root, 'asset/card/Raw card.svg')
    for kind in ['market','stock','flag','broker']:
        response=await client.get('/api/assets',params={'type':kind,'paged':1})
        assert response.status_code==200,response.text
        assert all(r['type']==kind for r in response.json()['assets'])

async def test_deleted_market_slot_stays_hidden_and_registered_card_remains_recoverable(client,admin,settings):
    write(settings.file_root,'asset/market/US.svg')
    before=await rows(client,'market');aid=before['assets'][0]['id']
    result=await client.delete(P+'/entries/'+aid+f'?requestId={uuid4()}&expectedRevision={before["revision"]}')
    assert result.status_code==200,result.text
    assert (await rows(client,'market'))['excludedMarkets']==['US']
    removed=await rows(client,'market',True)
    assert len(removed['assets'])==1 and removed['assets'][0]['id']==aid
    body={'requestId':str(uuid4()),'expectedRevision':removed['revision'],'assetId':aid}
    assert (await client.post(P+'/restore',json=body)).status_code==200
    assert (await rows(client,'market'))['excludedMarkets']==[]
    card=(await rows(client,'card'))['assets'][0]
    revision=(await rows(client,'card'))['revision']
    rename={'requestId':str(uuid4()),'expectedRevision':revision,'publicMetadataConfirmed':True,'asset':{'id':card['id'],'name':'可恢复卡面'},'restore':False}
    renamed=await client.put(P+'/entries/'+quote(card['id'],safe=''),json=rename)
    assert renamed.status_code==200,renamed.text
    result=await client.delete(P+'/entries/'+quote(card['id'],safe='')+f'?requestId={uuid4()}&expectedRevision={renamed.json()["revision"]}')
    assert result.status_code==200,result.text
    removed=await rows(client,'card',True)
    assert len(removed['assets'])==1 and removed['assets'][0]['name']=='可恢复卡面'

async def test_new_leveraged_etf_uses_underlying_art_without_merging_its_identity(client,admin,settings):
    body={'requestId':str(uuid4()),'expectedRevision':0,'publicMetadataConfirmed':True,'asset':{'type':'stock','market':'US','code':'RKLX','name':'RKLB 2 倍做多 ETF'},'restore':False}
    saved=await client.post(P+'/entries',json=body)
    assert saved.status_code==200,saved.text
    asset=saved.json()['asset']
    assert asset['id']=='stock:US:RKLX' and asset['code']=='RKLX'
    assert asset['imageInheritance']=={'market':'US','code':'RKLB'}
    assert asset['iconTarget']['code']=='RKLB'
    assert (await client.get(asset['imageUrl'])).status_code==200
    assert (settings.file_root/'asset/stock/US/RKLB.svg').read_bytes()==SVG

async def test_country_pages_are_chinese_sorted_before_paging_without_loading_every_image(client,settings):
    for code in ['AL','DZ','AE']:
        write(settings.file_root, f'asset/flag/{code}.svg')
    first=await client.get('/api/assets?type=flag&paged=1&pageSize=1')
    assert first.status_code==200,first.text
    assert first.json()['assets'][0]['name']=='阿尔巴尼亚'
    second=await client.get('/api/assets?type=flag&paged=1&pageSize=1&page=2')
    assert second.json()['assets'][0]['name']=='阿尔及利亚'
    found=await client.get('/api/assets?type=flag&paged=1&q=阿尔')
    assert {a['code'] for a in found.json()['assets']}=={'AL','DZ'}
