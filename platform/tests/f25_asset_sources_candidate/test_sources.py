"""Actual source-task routes over isolated PG; every provider byte is controlled."""
import hashlib
import json
from uuid import uuid4

import httpx
import pytest_asyncio
from alcor_api.asset_source_transport import Response
from alcor_api.asset_source_worker import AssetSourceWorker
from alcor_api.worker import claim
from test_system_assets import SVG


@pytest_asyncio.fixture(autouse=True)
async def files(settings,tmp_path):
    settings.file_root=tmp_path/'asset-source-files'


def install(app,owner,providers=('eastmoney','companiesmarketcap','parqet','coingecko'),*,member=False):
    hosts={'eastmoney':['push2delay.eastmoney.com','push2.eastmoney.com'],'companiesmarketcap':['companiesmarketcap.com'],
           'parqet':['assets.parqet.com'],'tradingview':['www.tradingview.com','s3-symbol-logo.tradingview.com'],
           'webull':['quotes-gw.webullfintech.com','quotes-static.webullfintech.com'],
           'coingecko':['api.coingecko.com','assets.coingecko.com','coin-images.coingecko.com']}
    values=[{'id':provider,'provider':provider,'ownerId':owner,'instanceId':str(app.state.db.settings.instance_id),
             'approvedAccess':True,'publicDisplay':True,'memberAdd':member,'licenseRevision':'synthetic-public-license-v1','expiresAt':'2099-01-01T00:00:00+00:00',
             'purposes':['asset.list','asset.icon','asset.search','asset.delisting'],'addresses':{host:['93.184.216.34'] for host in hosts[provider]}}
            for provider in providers]
    app.state.db.settings.asset_source_targets=values
    return values


async def revision(client):return (await client.get('/api/asset-sources/status')).json()['revision']


async def submit(client,action,*,selection=None,options=None,target=None,rid=None):
    raw={'requestId':rid or str(uuid4()),'action':action,'targetId':target,'expectedRevision':await revision(client),'selection':selection or {},'options':options or {}}
    result=await client.post('/api/asset-sources/operations',json=raw)
    assert result.status_code==202,result.text
    return raw


class Provider:
    def __init__(self,*,manual=False):self.calls=[];self.manual=manual;self.hook=None;self.missing=False
    async def read(self,target,request):
        self.calls.append((target['id'],request))
        if self.hook:await self.hook(target,request)
        market=request.context.get('market')
        if request.representation=='image_http_response_body':raw=SVG
        elif request.representation=='coingecko_search_json':raw=json.dumps({'coins':[{'id':'bitcoin','symbol':'btc','name':'Bitcoin','thumb':'https://coin-images.coingecko.com/coins/images/1/thumb/bitcoin.png'}]}).encode()
        elif request.representation=='eastmoney_list_json':
            code={'US':'AUTO','HK':'00700','CN':'600000'}[market]
            rows=[{'f12':code,'f14':market+' observed issuer','f13':106,'f20':40000000000,'f2':10,'f3':None}]
            if market=='US' and self.manual:rows.append({'f12':'MANUAL','f14':'Manually registered','f13':106,'f20':30000000000,'f2':None,'f3':None})
            raw=json.dumps({'data':{'total':len(rows),'diff':rows}}).encode()
        elif request.representation=='cmc_list_html':
            if request.context['page']>1:raw=b'<table><tr><th>End of observed rows</th></tr></table>'
            else:
                symbol='7203.T' if market=='JP' else '005930.KS'
                raw=('<table><tr><td><div class="company-name">Observed issuer</div><div class="company-code"><span class="rank d-none"></span>'+symbol+'</div></td><td class="td-right" data-sort="40000000000"><span class="currency-symbol-left">$</span></td></tr></table>').encode()
        elif request.representation=='eastmoney_security_json':raw=b'{"rc":0,"data":null}' if self.missing else json.dumps({'data':{'f57':request.context['code'],'f58':'Still listed'}}).encode()
        else:raise AssertionError('Unexpected controlled source request '+request.representation)
        return Response(raw,200,True,request.representation,request.url,{})


async def run(client,app,provider,rid):
    task=await claim(app.state.db,uuid4())
    assert task and task['kind']=='asset.source'
    worker=AssetSourceWorker(app.state.db);worker.transport=provider
    assert await worker.execute(task)
    read=await client.get('/api/asset-sources/operations/'+rid)
    assert read.status_code==200,read.text
    return read.json()


async def manual(client,code):
    result=await client.post('/api/admin/asset-catalog/entries',json={'requestId':str(uuid4()),'expectedRevision':await revision(client),'publicMetadataConfirmed':True,'asset':{'type':'stock','market':'US','code':code,'name':'Manually registered'},'restore':False})
    assert result.status_code==200,result.text
    return result.json()


async def test_default_full_sync_five_markets_keeps_manual_origin_and_current_public_evidence(client,admin,app,db):
    targets=install(app,admin)
    await manual(client,'MANUAL')
    provider=Provider(manual=True)
    raw=await submit(client,'sync')
    result=await run(client,app,provider,raw['requestId'])
    assert result['state']=='completed',result
    assert {item['market'] for item in result['result']['coverage'] if 'market' in item}=={'US','HK','CN','JP','KR'}
    assert {request.context.get('market') for _,request in provider.calls if request.purpose=='asset.list'}=={'US','HK','CN','JP','KR'}
    public=await client.get('/api/v1/assets?type=stock&pageSize=100')
    assert public.status_code==200,public.text
    assets={item['code']:item for item in public.json()['data']}
    assert assets['AUTO']['source']=='auto' and assets['AUTO']['sourceKnown'] is True
    assert assets['MANUAL']['source']=='manual' and assets['MANUAL']['sourceKnown'] is True
    assert assets['AUTO']['marketCap']=='40000000000' and assets['AUTO']['price'] is None
    assert assets['AUTO']['metadataObservation']['state']=='observed' and assets['AUTO']['asOf'] is None
    before=len(provider.calls)
    assert (await client.post('/api/asset-sources/operations',json=raw)).json()['requestId']==raw['requestId']
    assert await claim(db,uuid4()) is None and len(provider.calls)==before
    source_id=result['sourcePages'][0]['id']
    original=await client.get('/api/asset-sources/originals/'+source_id)
    assert original.status_code==200 and hashlib.sha256(original.content).hexdigest()==result['sourcePages'][0]['sha256']
    targets[0]['approvedAccess']=False
    hidden=(await client.get('/api/v1/assets?type=stock&pageSize=100')).json()['data']
    hidden={item['code']:item for item in hidden}
    assert hidden['AUTO']['marketCap'] is None and hidden['AUTO']['metadataObservation']['state']=='retained_unavailable'
    assert hidden['AUTO']['url'] and (await client.get(hidden['AUTO']['imageUrl'])).status_code==200


async def test_icons_mode_uses_only_registered_missing_images_and_old_status_wrapper(client,admin,app,db):
    install(app,admin,('parqet',))
    await manual(client,'ONE');await manual(client,'TWO')
    provider=Provider()
    rid=str(uuid4())
    ack=await client.post('/api/assets/sync',json={'requestId':rid,'mode':'icons'})
    assert ack.status_code==200 and ack.json()=={'ok':True,'message':'图标补全已开始'},ack.text
    result=await run(client,app,provider,rid)
    assert result['state']=='completed',result
    assert len(provider.calls)==2 and all(request.purpose=='asset.icon' for _,request in provider.calls)
    assert result['result']['coverage'][0]['externalListCollection'] is False
    assert (await client.post('/api/assets/sync',json={'requestId':rid,'mode':'icons'})).json()==ack.json()
    assert await claim(db,uuid4()) is None
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as public:
        status=await public.get('/api/assets/sync')
        assert status.status_code==200 and set(status.json())=={'status'}
        assert status.json()['status']['running'] is False and status.json()['status']['done']==2
        assert 'requestId' not in status.text and 'owner' not in status.text


async def test_legacy_search_is_pure_exact_empty_and_retained_current_licensed_candidates(client,admin,app,db):
    targets=install(app,admin,('coingecko',))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as public:
        for query in ('','?type=stock&q=AUTO','?type=crypto&q='):
            assert (await public.get('/api/assets/search'+query)).json()=={'candidates':[]}
        empty=await client.get('/api/assets/search?type=crypto&q=bitcoin')
        assert empty.status_code==502 and empty.headers['x-alcor-asset-search-state']=='explicit_post_required'
        async with db.connection() as conn:assert not await(await conn.execute('SELECT 1 FROM asset_source_jobs')).fetchone()
        queued=await client.post('/api/asset-sources/search',json={'requestId':str(uuid4()),'targetId':'coingecko','type':'crypto','query':'bitcoin'})
        assert queued.status_code==202,queued.text
        provider=Provider();result=await run(client,app,provider,queued.json()['requestId'])
        assert result['state']=='completed',result
        value=await public.get('/api/assets/search?type=crypto&q=bitcoin')
        assert value.status_code==200 and value.json()=={'candidates':[{'code':'BTC','name':'Bitcoin','market':'ASSET','iconUrl':'https://coin-images.coingecko.com/coins/images/1/large/bitcoin.png'}]},value.text
        assert (await client.get('/api/assets/search?type=crypto&q=bitcoin')).json()==value.json()
        assert len(provider.calls)==1 and await claim(db,uuid4()) is None
        targets[0]['approvedAccess']=False
        assert (await public.get('/api/assets/search?type=crypto&q=bitcoin')).status_code==502


async def test_delisting_requires_auto_creation_two_distinct_pages_and_explicit_tombstone(client,admin,app,db):
    install(app,admin,('eastmoney','parqet'))
    await manual(client,'MANUAL')
    provider=Provider(manual=True)
    sync=await submit(client,'sync',selection={'market':'US'})
    assert (await run(client,app,provider,sync['requestId']))['state']=='completed'
    provider.missing=True
    original_calls=len(provider.calls)
    planned=await submit(client,'check-delisted')
    plan=await run(client,app,provider,planned['requestId'])
    assert plan['state']=='completed',plan
    candidates={item['id']:item for item in plan['result']['candidates']}
    assert candidates['stock:US:AUTO']['eligible'] is True
    assert candidates['stock:US:AUTO']['securityDelistedKnown'] is False
    assert len(set(candidates['stock:US:AUTO']['sourcePageIds']))==2
    assert candidates['stock:US:MANUAL']['eligible'] is False
    assert len(provider.calls)==original_calls+2
    execution=await submit(client,'check-delisted',options={'phase':'execute','confirm':True,'planRequestId':planned['requestId']})
    result=await run(client,app,provider,execution['requestId'])
    assert result['state']=='completed',result
    assert len(result['result']['operations'])==1 and result['result']['filesDeleted'] is False
    assert len(provider.calls)==original_calls+2
    read=(await client.get('/api/v1/assets?type=stock&pageSize=100')).json()['data']
    assert {row['code'] for row in read}=={'MANUAL'}
    async with db.connection() as conn:
        assert (await(await conn.execute("SELECT count(*) n FROM asset_catalog_tombstones WHERE asset_id='stock:US:AUTO' AND restored_at IS NULL")).fetchone())['n']==1
        assert (await(await conn.execute('SELECT count(*) n FROM system_asset_versions')).fetchone())['n']==2
        assert (await(await conn.execute("SELECT count(*) n FROM asset_source_admissions WHERE request_key LIKE 'security:%'")).fetchone())['n']==2
    assert (await client.post('/api/asset-sources/operations',json=execution)).json()['state']=='completed'
    assert await claim(db,uuid4()) is None


async def test_backfill_does_not_promote_manual_creation_or_collect_icons(client,admin,app,db):
    install(app,admin,('eastmoney',))
    await manual(client,'AUTO')
    provider=Provider()
    raw=await submit(client,'backfill',selection={'market':'US'})
    result=await run(client,app,provider,raw['requestId'])
    assert result['state']=='completed',result
    assert len(provider.calls)==1 and provider.calls[0][1].purpose=='asset.list'
    read=(await client.get('/api/v1/assets?type=stock')).json()['data'][0]
    assert read['source']=='manual' and read['marketCap']=='40000000000' and not read['url']
    provider.missing=True
    planned=await submit(client,'check-delisted',selection={'market':'US'})
    plan=await run(client,app,provider,planned['requestId'])
    assert plan['result']['candidates'][0]['eligible'] is False and len(provider.calls)==1
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM system_asset_versions')).fetchone()


async def test_unknown_admission_never_repeats_call_and_late_revocation_keeps_response(client,admin,app,db):
    targets=install(app,admin,('eastmoney',))
    class Interrupted(Provider):
        async def read(self,target,request):
            self.calls.append((target['id'],request))
            raise OSError('controlled outcome unknown')
    provider=Interrupted()
    raw=await submit(client,'sync',selection={'market':'US'})
    result=await run(client,app,provider,raw['requestId'])
    assert result['state']=='unknown' and result['willRetryAutomatically'] is False,result
    assert len(provider.calls)==1 and result['sourcePages']==[]
    assert (await client.post('/api/asset-sources/operations',json=raw)).json()['state']=='unknown'
    assert await claim(db,uuid4()) is None
    received=Provider()
    async def revoke(_target,_request):targets[0]['approvedAccess']=False
    received.hook=revoke
    second=await submit(client,'sync',selection={'market':'US'})
    stopped=await run(client,app,received,second['requestId'])
    assert stopped['state']=='unavailable' and len(stopped['sourcePages'])==1,stopped
    original=await client.get(stopped['sourcePages'][0]['originalPath'])
    assert original.status_code==200 and hashlib.sha256(original.content).hexdigest()==stopped['sourcePages'][0]['sha256']
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM asset_catalog_entries')).fetchone()
        assert (await(await conn.execute('SELECT count(*) n FROM asset_source_admissions')).fetchone())['n']==2


async def test_registered_icons_known_404_falls_back_only_to_approved_provider(client,admin,app,db):
    install(app,admin,('tradingview','parqet'))
    await manual(client,'ONE')
    class Fallback(Provider):
        async def read(self,target,request):
            if target['provider']=='tradingview':
                self.calls.append((target['id'],request))
                return Response(b'Not Found',404,True,request.representation,request.url,{})
            return await super().read(target,request)
    provider=Fallback()
    raw=await submit(client,'sync',options={'mode':'icons'})
    result=await run(client,app,provider,raw['requestId'])
    assert result['state']=='completed',result
    assert [target for target,_ in provider.calls]==['tradingview','parqet']
    assert len(result['sourcePages'])==2 and {page['httpStatus'] for page in result['sourcePages']}=={200,404}
    assert all(page['complete'] is True for page in result['sourcePages'])
    asset=(await client.get('/api/v1/assets?type=stock')).json()['data'][0]
    assert asset['url'] and asset['source']=='manual'


async def test_cleanup_uses_actual_reference_graph_and_never_deletes_original_files(client,admin,app,db):
    install(app,admin,())
    await manual(client,'KEEP');await manual(client,'FREE')
    preview=await client.post('/api/portfolio/records/preview',json={'kind':'create','data':{'name':'Private registered record','code':'KEEP','market':'US','price':None,'qty':'0','cost':'0','group':'','note':'','brokerAccountId':''}})
    assert preview.status_code==200,preview.text
    assert (await client.post('/api/portfolio/records/confirm',json={'requestId':str(uuid4()),'previewId':preview.json()['previewId']})).status_code==200
    planned=await submit(client,'cleanup')
    provider=Provider()
    plan=await run(client,app,provider,planned['requestId'])
    assert plan['state']=='completed' and plan['result']['phase']=='plan',plan
    candidates={row['id']:row for row in plan['result']['candidates']}
    assert candidates['stock:US:FREE']['eligible'] is True
    assert candidates['stock:US:KEEP']['eligible'] is False and candidates['stock:US:KEEP']['references']['records']==1
    async with db.connection() as conn:
        before=await(await conn.execute('SELECT row_to_json(r)::text raw FROM portfolio_records r WHERE owner_id=%s',(admin,))).fetchall()
    execution=await submit(client,'cleanup',options={'phase':'execute','confirm':True,'planRequestId':planned['requestId']})
    result=await run(client,app,provider,execution['requestId'])
    assert result['state']=='completed' and result['result']['filesDeleted'] is False,result
    assert not provider.calls
    async with db.connection() as conn:
        after=await(await conn.execute('SELECT row_to_json(r)::text raw FROM portfolio_records r WHERE owner_id=%s',(admin,))).fetchall()
        assert after==before
        assert (await(await conn.execute('SELECT count(*) n FROM asset_catalog_sources')).fetchone())['n']==2
    read=(await client.get('/api/v1/assets?type=stock')).json()['data']
    assert {row['code'] for row in read}=={'KEEP'}


async def test_old_web_bearer_is_exact_session_family_and_never_canonical_or_cookie_fallback(client,admin,app,db):
    from alcor_api.native_app_auth import issue_grant
    from alcor_api.security import digest
    install(app,admin)
    async with db.connection() as conn,conn.transaction():
        user=await(await conn.execute('SELECT * FROM users WHERE id=%s',(admin,))).fetchone()
        web,_=await app.state.legacy_create_session(conn,user,str(uuid4()))
        v1,_=await app.state.legacy_create_session(conn,user,str(uuid4()),v1=True)
        native=await issue_grant(conn,user,'portfolio.read','Synthetic source isolation')
        fake='N'*64
        await conn.execute("INSERT INTO sessions(token_hash,user_id,client_id,session_version,expires_at) VALUES(%s,%s,'new-web',%s,clock_timestamp()+interval '1 hour')",(digest(fake),admin,user['session_version']))
    client.cookies.set('fire_session',web)
    for token in (v1,native['access_token'],fake,''):
        headers={'authorization':'Bearer '+token}
        assert (await client.get('/api/assets/sync',headers=headers)).status_code==401
        assert (await client.post('/api/assets/sync',json={'mode':'icons'},headers=headers)).status_code==401
    headers={'authorization':'Bearer '+web,'X-Alcor-Request-Id':str(uuid4())}
    assert (await client.get('/api/assets/sync',headers=headers)).status_code==200
    accepted=await client.post('/api/assets/sync',json={'mode':'icons'},headers=headers)
    assert accepted.status_code==200,accepted.text
    assert (await client.get('/api/asset-sources/status',headers=headers)).status_code==401
    assert (await client.post('/api/asset-sources/operations',json={},headers=headers)).status_code==401
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM asset_source_jobs')).fetchone())['n']==1
        await conn.execute("UPDATE users SET role='user' WHERE id=%s",(admin,))
    denied=await client.post('/api/assets/sync',json={'mode':'icons'},headers={**headers,'X-Alcor-Request-Id':str(uuid4())})
    assert denied.status_code==403,denied.text
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM asset_source_jobs')).fetchone())['n']==1


async def test_member_only_fills_owned_stock_missing_icon_without_publishing_private_name(client,admin,app,db,settings):
    from alcor_api.cli import create_user
    from alcor_api.portfolio_records import PortfolioRecords
    from test_account_admin import login
    member=await create_user(settings,'AssetMember','Synthetic9Pass',role='user')
    records=PortfolioRecords(db)
    preview=await records.preview(member,'create',{'name':'Private portfolio nickname','code':'OWN','market':'US','price':None,'cost':None,'qty':'0','group':'','note':'Private note'})
    record=await records.confirm(member,preview['previewId'],uuid4())
    install(app,admin,('parqet',),member=True)
    peer=await login(app,'AssetMember')
    try:
        rid=str(uuid4())
        response=await peer.post('/api/assets/add-by-search',json={'type':'stock','market':'US','code':'OWN','name':'Never publish this','onlyIfMissing':True},headers={'X-Alcor-Request-Id':rid})
        assert response.status_code==202,response.text
        provider=Provider();out=await run(peer,app,provider,rid)
        assert out['state']=='completed',out
        row=(await client.get('/api/v1/assets?type=stock&pageSize=100')).json()['data'][0]
        assert row['code']=='OWN' and row['name']=='OWN' and row['source']=='auto'
        for body in ({'type':'stock','market':'US','code':'OTHER','onlyIfMissing':True},{'type':'stock','market':'US','code':'OWN','onlyIfMissing':False}):
            assert (await peer.post('/api/assets/add-by-search',json=body,headers={'X-Alcor-Request-Id':str(uuid4())})).status_code==403
        assert (await peer.post('/api/assets/sync',json={'mode':'icons'},headers={'X-Alcor-Request-Id':str(uuid4())})).status_code==403
        assert (await client.get('/api/asset-sources/operations/'+rid)).status_code==404
        assert (await client.get('/api/asset-sources/originals/'+out['sourcePages'][0]['id'])).status_code==404
        async with db.connection() as conn:
            current=await(await conn.execute('SELECT name,note,qty FROM portfolio_records WHERE id=%s',(record['record']['id'],))).fetchone()
            assert current['name']=='Private portfolio nickname' and current['note']=='Private note' and current['qty']==0
        assert len(provider.calls)==1
    finally:await peer.aclose()


async def test_restored_corrupt_search_page_never_becomes_public_candidate_or_download(client,admin,app,db):
    install(app,admin,('coingecko',))
    rid=str(uuid4())
    accepted=await client.post('/api/asset-sources/search',json={'requestId':rid,'targetId':'coingecko','type':'crypto','query':'bitcoin'})
    assert accepted.status_code==202,accepted.text
    provider=Provider();out=await run(client,app,provider,rid)
    page=out['sourcePages'][0]['id']
    async with db.connection() as conn,conn.transaction():
        await conn.execute('ALTER TABLE asset_source_pages DISABLE TRIGGER immutable_asset_source_page')
        await conn.execute('UPDATE asset_source_pages SET raw=%s WHERE id=%s',(b'{"coins":[]}',page))
        await conn.execute('ALTER TABLE asset_source_pages ENABLE TRIGGER immutable_asset_source_page')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as public:
        response=await public.get('/api/assets/search?type=crypto&q=bitcoin')
        assert response.status_code==502,response.text
    assert (await client.get('/api/asset-sources/originals/'+page)).status_code==503
    assert len(provider.calls)==1 and await claim(db,uuid4()) is None


async def test_delisting_http_error_and_restored_plan_corruption_cannot_retire_asset(client,admin,app,db):
    install(app,admin,('eastmoney','parqet'))
    provider=Provider()
    sync=await submit(client,'sync',selection={'market':'US'})
    assert (await run(client,app,provider,sync['requestId']))['state']=='completed'
    class ErrorProvider(Provider):
        async def read(self,target,request):
            response=await super().read(target,request)
            return Response(b'{"rc":0,"data":null}',503,True,request.representation,request.url,{}) if request.purpose=='asset.delisting' else response
    failed=await submit(client,'check-delisted')
    error=await run(client,app,ErrorProvider(),failed['requestId'])
    assert error['state']!='completed' and len(error['sourcePages'])==1,error
    provider.missing=True
    planned=await submit(client,'check-delisted')
    plan=await run(client,app,provider,planned['requestId'])
    candidate=next(row for row in plan['result']['candidates'] if row['eligible'])
    async with db.connection() as conn,conn.transaction():
        await conn.execute('ALTER TABLE asset_source_pages DISABLE TRIGGER immutable_asset_source_page')
        await conn.execute('UPDATE asset_source_pages SET raw=%s WHERE id=%s',(b'{"rc":0,"data":{"f57":"AUTO","f58":"Present"}}',candidate['sourcePageIds'][1]))
        await conn.execute('ALTER TABLE asset_source_pages ENABLE TRIGGER immutable_asset_source_page')
    execution=await submit(client,'check-delisted',options={'phase':'execute','confirm':True,'planRequestId':planned['requestId']})
    out=await run(client,app,provider,execution['requestId'])
    assert out['state']!='completed',out
    async with db.connection() as conn:
        assert not await(await conn.execute("SELECT 1 FROM asset_catalog_tombstones WHERE asset_id='stock:US:AUTO' AND restored_at IS NULL")).fetchone()


async def test_legacy_web_create_and_v1_id_delete_preserve_original_uuid_tombstone(client,admin,app,db):
    async with db.connection() as conn:
        user=await(await conn.execute('SELECT * FROM users WHERE id=%s',(admin,))).fetchone()
        web,_=await app.state.legacy_create_session(conn,user,str(uuid4()))
    client.cookies.set('fire_session',web)
    rid=str(uuid4());headers={'X-Alcor-Request-Id':rid,'X-Alcor-Assets-Revision':'0'}
    created=await client.post('/api/assets',json={'type':'stock','market':'US','code':'WEB','name':'Original name'},headers=headers)
    assert created.status_code==200,created.text
    assert set(created.json())=={'asset'}
    aid=created.json()['asset']['id']
    assert (await client.post('/api/assets',json={'type':'stock','market':'US','code':'WEB','name':'Original name'},headers=headers)).json()==created.json()
    delete_id=str(uuid4());delete_headers={'X-Alcor-Request-Id':delete_id,'X-Alcor-Assets-Revision':'1'}
    deleted=await client.delete('/api/v1/assets/'+aid,headers=delete_headers)
    assert deleted.status_code==200 and deleted.json()['data']=={'deleted':True},deleted.text
    assert (await client.delete('/api/v1/assets/'+aid,headers=delete_headers)).json()==deleted.json()
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM asset_catalog_operations')).fetchone())['n']==2
        assert (await(await conn.execute('SELECT name FROM asset_catalog_entries WHERE id=%s',(aid,))).fetchone())['name']=='Original name'
        assert await(await conn.execute('SELECT 1 FROM asset_catalog_tombstones WHERE asset_id=%s AND restored_at IS NULL',(aid,))).fetchone()
