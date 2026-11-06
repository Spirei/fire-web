"""Real public routes and independent publication originals, no provider IO."""
import hashlib
import io
import json
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alcor_api.market_contract import Query
from alcor_api.market_worker import decode
from PIL import Image
from psycopg.errors import CheckViolation
from psycopg.types.json import Jsonb
from public_market_candidate.test_public_quotes import prepared
from test_system_assets import upload


@pytest_asyncio.fixture(autouse=True)
async def files(settings,tmp_path):settings.file_root=tmp_path/'public-site'


async def test_all_fixed_public_artwork_manifest_same_brand_version_pwa_override_and_no_secret_projection(client,admin,app,db):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver')as public:
        assert (await public.get('/api/site-favicon')).status_code==404
        for size in (180,192,512):
            response=await public.get('/api/pwa-icon',params={'size':size})
            assert response.status_code==200,response.text
            assert Image.open(io.BytesIO(response.content)).size==(size,size)
            assert (await public.get('/api/pwa-icon',params={'size':size},headers={'if-none-match':response.headers['etag']})).status_code==304
        assert (await public.get('/api/pwa-icon?v=wrong')).status_code==404
        assert (await public.get('/api/pwa-icon?size=12')).status_code==400
        banner=await public.get('/api/system-assets/mail-banner');assert banner.status_code==200 and Image.open(io.BytesIO(banner.content)).size==(1080,280)
        passkey=await public.get('/api/system-assets/passkey');assert passkey.status_code==200 and passkey.content.startswith(b'\x89PNG')
        image=io.BytesIO();Image.new('RGB',(12,8),(170,20,40)).save(image,format='PNG')
        ico,_=await upload(client,'ico',image.getvalue(),'ico.png');assert ico.status_code==200,ico.text
        image=io.BytesIO();Image.new('RGB',(8,12),(10,120,200)).save(image,format='PNG')
        pwa,_=await upload(client,'ico',image.getvalue(),'pwa.png');assert pwa.status_code==200,pwa.text
        state=(await client.get('/api/admin/site-settings')).json()
        changed=await client.put('/api/admin/site-settings',json={'requestId':str(uuid4()),'expectedRevision':state['revision'],'patch':{'title':'Declared public brand','logoText':'Public','ico':ico.json()['version'],'pwaIcon':pwa.json()['version']},'password':'Synthetic9Pass'})
        assert changed.status_code==200,changed.text
        favicon=await public.get('/api/site-favicon');assert favicon.status_code==200 and Image.open(io.BytesIO(favicon.content)).size==(64,64)
        assert Image.open(io.BytesIO(favicon.content)).convert('RGB').getpixel((32,32))==(170,20,40)
        manifest=await public.get('/manifest.webmanifest');assert manifest.status_code==200,manifest.text
        doc=manifest.json();assert doc['name']=='Declared public brand' and doc['start_url']=='/' and doc['scope']=='/'
        assert {icon['sizes']for icon in doc['icons']}=={'192x192','512x512'}
        for icon in doc['icons']:
            response=await public.get(icon['src']);assert response.status_code==200,response.text
            assert response.headers['x-alcor-artwork-version'] in icon['src']
            rendered=Image.open(io.BytesIO(response.content)).convert('RGB')
            assert rendered.getpixel((rendered.width//2,rendered.height//2))==(10,120,200)
        assert all(value not in manifest.text for value in (admin,'smtpPassword','secret','/api/admin/'))
        for name, original in [('pwa-icon','/api/pwa-icon'),('site-favicon','/api/site-favicon'),('mail-banner','/api/system-assets/mail-banner'),('passkey','/api/system-assets/passkey'),('security-check','/api/system-assets/security-check')]:
            legacy=await public.get(original)
            unified=await public.get('/assets/system/'+name,headers={'authorization':'Bearer invalid'})
            assert unified.status_code==legacy.status_code==200,(name,unified.text[:120])
            assert unified.content==legacy.content
            assert unified.headers['content-type']==legacy.headers['content-type']
            if 'etag' in legacy.headers:
                assert unified.headers['etag']==legacy.headers['etag']
                assert (await public.get('/assets/system/'+name,headers={'if-none-match':legacy.headers['etag']})).status_code==304
        assert (await public.get('/assets/system/not-registered')).status_code==404
        async with db.connection()as conn:
            assert not await(await conn.execute('SELECT 1 FROM public_market_tasks')).fetchone()


async def fact(db,authority,who,policy,license_id,at,price):
    query=Query('latest','US','AAPL')
    queued=await authority.enqueue(who,uuid4(),license_id,query,'Synthetic9Pass')
    raw=json.dumps({'query':asdict(query),'licenseRevision':policy.license_revision,'facts':[{'at':at.isoformat(),'currency':'USD','price':price,'session':'REGULAR','cached':None,'change':'1.25','changePct':'2.50','context':{'privateTarget':'not public'}}]}).encode()
    facts,_,_=decode(policy,query,raw);page=uuid4()
    async with db.connection()as conn,conn.transaction():
        await conn.execute("UPDATE public_market_tasks SET status='running' WHERE id=%s",(queued['taskId'],))
        await conn.execute("INSERT INTO public_market_pages(id,task_id,raw_bytes,raw_sha256,representation,http_status,complete) VALUES(%s,%s,%s,%s,'raw',200,true)",(page,queued['taskId'],raw,hashlib.sha256(raw).hexdigest()))
        await conn.execute('INSERT INTO public_market_facts(id,task_id,page_id,license_id,query,source_time,contents) VALUES(%s,%s,%s,%s,%s,%s,%s)',(uuid4(),queued['taskId'],page,license_id,Jsonb(asdict(query)),at,Jsonb(facts[0])))
        await conn.execute("UPDATE public_market_tasks SET status='completed' WHERE id=%s",(queued['taskId'],))
    return page


async def test_ticker_public_original_price_trend_declared_missing_seconds_and_no_private_fallback(client,admin,app,db):
    # A real private source fact is present and independently readable, but it
    # never becomes a public ticker fact, even when the public page is corrupt.
    from alcor_api.market_authority import Policy
    from alcor_api.market_worker import claim, execute, schedule
    from market_latest_candidate.test_market_authority import Transport, demand
    private=app.state.market_candidate;private.policy_provider=None
    private.policies=(Policy('private-fixture','controlled_market','fixture-v1','private-endpoint','private-fingerprint',admin,'private-only-license',('latest',),('US',),True),)
    registered=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'private-fixture'});assert registered.status_code==200,registered.text
    await demand(client,registered.json()['revision']);await schedule(private);task=await claim(db,uuid4());transport=Transport();transport.price='999999'
    assert await execute(private,task,transport)=='observed'
    db.settings.public_ticker={'instanceId':str(db.settings.instance_id),'items':[{'key':'private-attempt','label':'Declared private must not be borrowed','market':'US','code':'AAPL','instrument':'equity','sourceOwnerId':admin,'sourceRevision':registered.json()['revision'],'publicDisplay':True}]}
    private_attempt=await client.get('/api/ticker')
    assert private_attempt.status_code==503 and private_attempt.json()['items'][0]['price'] is None and '999999' not in private_attempt.text,private_attempt.text
    who,policy,_,authority=await prepared(db,client,admin)
    db.settings.public_market_data_policies=[asdict(policy)]
    saved=await authority.install(who,uuid4(),policy.id,'Synthetic9Pass')
    now=datetime.now(UTC)
    await fact(db,authority,who,policy,saved['licenseId'],now-timedelta(seconds=20),'120.000000000000000001')
    latest=await fact(db,authority,who,policy,saved['licenseId'],now-timedelta(seconds=10),'125.000000000000000001')
    db.settings.public_ticker={'instanceId':str(db.settings.instance_id),'interval':4000,'legacyPresentation':{'interval':4,'items':[{'key':'actual','secid':'explicit-legacy-id','label':'Observed public','market':'US'}]},'items':[{'key':'actual','label':'Observed public','market':'US','code':'AAPL','instrument':'equity','licenseId':saved['licenseId'],'publicDisplay':True,'legacySecid':'explicit-legacy-id','sourceOwnerId':admin,'sourceRevision':registered.json()['revision']},{'key':'declared','label':'No licensed mapping','market':'HK','publicDisplay':False}]}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver')as public:
        async with db.connection()as conn:before=(await(await conn.execute('SELECT count(*) n FROM public_market_tasks')).fetchone())['n']
        response=await public.get('/api/ticker');assert response.status_code==200,response.text
        body=response.json();assert body['interval']==4 and body['intervalMs']==4000 and body['state']=='partial' and body['collectionOnRead'] is False
        row=body['items'][0];assert row['price']==125 and row['priceExact']=='125.000000000000000001'
        assert row['points']==[120,125] and row['pointsExact']==['120.000000000000000001','125.000000000000000001']
        assert row['cached'] is None and row['displayStale'] is True and datetime.fromisoformat(row['observedAt'])==now-timedelta(seconds=10)
        assert row['trendBasis']['calendarComplete'] is False and row['trendBasis']['observedPoints']==2
        assert body['items'][1]['price'] is None and body['items'][1]['observedAt'] is None
        assert all(value not in response.text for value in (admin,'privateTarget','private-only-license','999999',str(latest)))
        async with db.connection()as conn,conn.transaction():
            valid_page=await(await conn.execute('SELECT raw_bytes,raw_sha256 FROM public_market_pages WHERE id=%s',(latest,))).fetchone()
            await conn.execute('ALTER TABLE public_market_pages DISABLE TRIGGER public_market_page_immutable')
            with pytest.raises(CheckViolation):
                async with conn.transaction():await conn.execute('UPDATE public_market_pages SET raw_bytes=%s WHERE id=%s',(b'polluted-public-response',latest))
            corrupted=b'polluted-public-response'
            await conn.execute('UPDATE public_market_pages SET raw_bytes=%s,raw_sha256=%s WHERE id=%s',(corrupted,hashlib.sha256(corrupted).hexdigest(),latest))
            await conn.execute('ALTER TABLE public_market_pages ENABLE TRIGGER public_market_page_immutable')
        corrupt=await public.get('/api/ticker');assert corrupt.status_code==503,corrupt.text
        assert corrupt.json()['items'][0]['price'] is None and '999999' not in corrupt.text
        async with db.connection()as conn,conn.transaction():
            await conn.execute('ALTER TABLE public_market_pages DISABLE TRIGGER public_market_page_immutable')
            await conn.execute('UPDATE public_market_pages SET raw_bytes=%s,raw_sha256=%s WHERE id=%s',(valid_page['raw_bytes'],valid_page['raw_sha256'],latest))
            await conn.execute('ALTER TABLE public_market_pages ENABLE TRIGGER public_market_page_immutable')
        restored=await public.get('/api/ticker');assert restored.status_code==200 and restored.json()['items'][0]['price']==125,restored.text
        await authority.revoke(who,uuid4(),saved['licenseId'],'Synthetic9Pass')
        assert (await public.get('/api/ticker')).status_code==503
        db.settings.public_ticker={'legacyPresentation':{'interval':5,'items':[{'key':'missing','secid':'not-a-ticker-map','market':'US','label':'Declared only'}]}}
        missing=await public.get('/api/ticker');assert missing.status_code==503 and missing.json()['interval']==5 and missing.json()['intervalMs']==5000,missing.text
        assert missing.json()['items'][0]['price'] is None and missing.json()['items'][0]['points']==[]
        async with db.connection()as conn:
            assert (await(await conn.execute('SELECT count(*) n FROM public_market_tasks')).fetchone())['n']==before
            assert (await(await conn.execute('SELECT count(*) n FROM market_facts')).fetchone())['n']==1
