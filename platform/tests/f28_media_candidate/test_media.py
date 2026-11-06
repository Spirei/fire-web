"""Only explicit immutable mappings may connect old URLs to private originals."""
from uuid import uuid4

import httpx
import pytest_asyncio
from test_asset_catalog_management import command
from test_card_wallet import owner
from test_financial_reports import RAW
from test_financial_reports import upload as report_upload
from test_system_assets import SVG
from test_system_assets import upload as image_upload


@pytest_asyncio.fixture(autouse=True)
async def files(settings,tmp_path):settings.file_root=tmp_path/'mapped-originals'


async def test_media_three_legacy_paths_real_hash_range_private_report_mapping_and_tombstone(client,admin,app):
    material,_=await image_upload(client,raw=SVG,name='synthetic.svg',folder='stock',market='US',code='SYNTHETIC')
    assert material.status_code==200,material.text
    path=material.json()['legacyUrl'].removeprefix('/uploads/')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as public:
        for prefix in ('/api/managed-upload/','/api/upload-files/'):
            response=await public.get(prefix+path)
            assert response.status_code==200 and response.content.startswith(b'<!-- by alcor -->'),response.text
            ranged=await public.get(prefix+path,headers={'range':'bytes=0-7'})
            assert ranged.status_code==206 and ranged.content==response.content[:8]
            assert (await public.get(prefix+path,headers={'range':'bytes=99999-'})).status_code==416
            assert (await public.get(prefix+path+'?sha256='+'0'*64)).status_code==404
        assert (await public.get('/api/managed-upload/reports/no.pdf')).status_code==404
        for url in ('/api/upload-files/asset/%2e%2e/x.svg','/api/upload-files/asset%2fstock/x.svg'):
            assert (await public.get(url)).status_code in (400,404)
    uploaded=await report_upload(client)
    assert uploaded.status_code==201,uploaded.text
    rid=str(uuid4());legacy='/uploads/reports/synthetic/kept.pdf'
    mapping={'requestId':rid,'expectedRevision':0,'legacyPath':legacy,'targetKind':'report','targetId':uploaded.json()['report']['id'],'scope':'admin'}
    saved=await client.post('/api/media-aliases',json=mapping)
    assert saved.status_code==200,saved.text
    assert (await client.post('/api/media-aliases',json=mapping)).json()==saved.json()
    for url in ('/api/private-reports/synthetic/kept.pdf','/api/upload-files/reports/synthetic/kept.pdf'):
        response=await client.get(url)
        assert response.status_code==200 and response.content==RAW,response.text
        assert 'no-store' in response.headers['cache-control'] and response.headers['x-content-type-options']=='nosniff'
        partial=await client.get(url,headers={'range':'bytes=-4'})
        assert partial.status_code==206 and partial.content==RAW[-4:]
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as public:
            denied=await public.get(url)
            assert denied.status_code==403 and denied.text=='Forbidden' and denied.headers['x-alcor-retire-context']=='true'
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as peer:
            await owner(peer,'RptPeer'+str(uuid4())[:6])
            denied=await peer.get(url)
            assert denied.status_code==403 and denied.text=='Forbidden' and denied.headers['x-alcor-retire-context']=='true'
    forbidden=await client.post('/api/media-aliases',json={**mapping,'requestId':str(uuid4()),'scope':'public','publicDisplay':True,'acknowledgePublicDisclosure':True})
    assert forbidden.status_code==403
    report=uploaded.json()['report']
    removed=await client.delete('/api/financial-reports/'+report['id'],params={'requestId':str(uuid4()),'expectedRevision':1})
    assert removed.status_code==200,removed.text
    assert (await client.get('/api/private-reports/synthetic/kept.pdf')).status_code==404
    assert (await client.get('/api/media-aliases/operations/'+rid)).json()==saved.json()


async def test_attachment_library_actual_global_metadata_paging_unknown_cap_and_admin_scope(client,admin,app):
    for index,(code,name) in enumerate((('B','Name_under'),('A','Name%literal'),('C','ΓREEK'))):
        response=await client.post('/api/admin/asset-catalog/entries',json=command(revision=index,code=code,name=name))
        assert response.status_code==200,response.text
    result=await client.get('/api/attachments/library',params={'paged':'1','type':'stock','sort':'code','pageSize':'2.9','page':'1'})
    assert result.status_code==200,result.text
    data=result.json()
    assert data['pageSize']==2 and data['total']==3 and [r['code'] for r in data['items']]==['A','B']
    assert all(r['marketCap'] is None for r in data['items'])
    query=await client.get('/api/attachments/library',params={'paged':'1','q':'_','sort':'cap_desc'})
    assert query.status_code==200 and [r['code'] for r in query.json()['items']]==['B']
    assert query.json()['sortApplied']=='code' and query.json()['unavailableReasons']==['verified_market_cap_and_conversion_basis_unavailable']
    tree=(await client.get('/api/attachments/library')).json()
    assert len(tree['stock']['US'])==3
    bad=await client.get('/api/attachments/library?paged=1&paged=0')
    assert bad.status_code==400
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as peer:
        await owner(peer,'LibraryNotAdmin')
        assert (await peer.get('/api/attachments/library')).status_code==403


async def test_managed_cards_explicit_public_alias_and_owner_private_resource_alias_never_cross_scope(client,admin,app,db):
    from resource_test_support import upload as resource_upload
    from test_legacy_devices import grant
    material,_=await image_upload(client,raw=SVG,name='mapped.svg',folder='card',code='SYNTHETIC')
    assert material.status_code==200,material.text
    public_alias={'requestId':str(uuid4()),'expectedRevision':0,'scope':'public','legacyPath':'/uploads/cards/Synthetic.svg','targetKind':'system','targetId':material.json()['version'],'publicDisplay':True,'acknowledgePublicDisclosure':True}
    mapped=await client.post('/api/media-aliases',json=public_alias)
    assert mapped.status_code==200,mapped.text
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as anonymous:
        served=await anonymous.get('/api/managed-upload/cards/Synthetic.svg')
        assert served.status_code==200 and served.content.startswith(b'<!-- by alcor -->'),served.text
    pair=await grant(db,admin,'portfolio.read resources.read resources.write')
    resource,_=await resource_upload(client,'/api/client/resource-library',pair,'private.txt',b'synthetic-owner-private\r\nbytes')
    assert resource.status_code==201,resource.text
    fid=resource.json()['result']['id']
    original={'requestId':str(uuid4()),'expectedRevision':0,'scope':'owner','legacyPath':'/uploads/owner_docs/private.txt','targetKind':'resource','targetId':fid}
    alias=await client.post('/api/media-aliases',json=original)
    assert alias.status_code==200,alias.text
    url='/api/upload-files/owner_docs/private.txt'
    assert (await client.get(url)).content==b'synthetic-owner-private\r\nbytes'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as anonymous:
        assert (await anonymous.get(url)).status_code==404
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as peer:
        await owner(peer,'OtherResourceAlias')
        assert (await peer.get(url)).status_code==404
    publish=await client.post('/api/media-aliases',json={**original,'requestId':str(uuid4()),'scope':'public','publicDisplay':True,'acknowledgePublicDisclosure':True})
    assert publish.status_code==403
    removed=await client.post('/api/media-aliases',json={**original,'requestId':str(uuid4()),'expectedRevision':1,'action':'remove'})
    assert removed.status_code==200 and removed.json()['alias']['deleted'] is True,removed.text
    assert (await client.get(url)).status_code==404
    assert (await client.get('/api/media-aliases/operations/'+original['requestId'])).json()==alias.json()
