from uuid import uuid4
import httpx
import pytest_asyncio
from alcor_api.cli import create_user
from test_account_admin import login
from test_legacy_asset_directory import write

P='/api/admin/asset-library/access'

@pytest_asyncio.fixture(autouse=True)
async def artwork(settings,tmp_path):
    settings.file_root=tmp_path/'uploads'
    write(settings.file_root,'asset/stock/US/DEMO.svg')
    settings.file_root.chmod(0o700)

async def test_access_tiers_apply_to_catalog_lookup_alias_and_image_without_mutation_rights(client,admin,app,settings):
    await create_user(settings,'ReaderOne','Synthetic9Pass',role='user')
    reader=await login(app,'ReaderOne')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as guest:
        initial=(await client.get(P)).json()
        assert initial=={'revision':0,'registered':True,'guest':True}
        asset=(await guest.get('/api/assets?type=stock&paged=1')).json()['assets'][0]
        assert (await guest.get(asset['imageUrl'])).status_code==200
        body={'requestId':str(uuid4()),'expectedRevision':0,'registered':True,'guest':False}
        saved=await client.post(P,json=body)
        assert saved.status_code==200,saved.text
        assert (await client.post(P,json=body)).json()==saved.json()
        paths=['/api/assets?type=stock&paged=1','/api/asset-catalog?type=stock&paged=1','/api/asset-catalog/lookup?keys=[]','/api/asset-catalog/alias?url=/uploads/asset/stock/US/DEMO.svg',asset['imageUrl']]
        for path in paths:
            assert (await guest.get(path)).status_code==401,path
        assert (await reader.get('/api/assets?type=stock&paged=1')).status_code==200
        assert (await reader.get(asset['imageUrl'])).status_code==200
        assert (await reader.post(P,json=body)).status_code==403
        assert (await reader.post('/api/admin/asset-catalog/entries',json={})).status_code==403
        assert (await reader.post('/api/admin/shared-assets/upload',data={})).status_code==403
        assert (await guest.get('/api/asset-library/access')).json()=={'revision':1,'registered':True,'guest':False}
        body={**body,'requestId':str(uuid4()),'expectedRevision':1,'registered':False}
        assert (await client.post(P,json=body)).status_code==200
        assert (await reader.get('/api/assets?type=stock&paged=1')).status_code==403
        assert (await reader.get(asset['imageUrl'])).status_code==403
        assert (await client.get('/api/assets?type=stock&paged=1')).status_code==200
        assert (await client.get(asset['imageUrl'])).status_code==200
    await reader.aclose()

async def test_access_cas_replay_tampering_and_no_guest_escalation(client,admin):
    body={'requestId':str(uuid4()),'expectedRevision':0,'registered':False,'guest':True}
    assert (await client.post(P,json=body)).status_code==400
    body['registered']=True;body['guest']=False
    result=await client.post(P,json=body)
    assert result.status_code==200,result.text
    assert (await client.get(P+'/operations/'+body['requestId'])).json()==result.json()
    assert (await client.post(P,json={**body,'guest':True})).status_code==409
    assert (await client.post(P,json={**body,'requestId':str(uuid4())})).status_code==409
    for patch in [{'admin':False},{'expectedRevision':True},{'guest':'false'}]:
        assert (await client.post(P,json={**body,**patch})).status_code==400
