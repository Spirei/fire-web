"""Public disclosure protocol and provenance, using only isolated synthetic pages."""
import hashlib
import io
import json
from uuid import uuid4

import httpx
import pytest_asyncio
from alcor_api.celeb_source_worker import CelebSourceWorker
from alcor_api.worker import claim
from PIL import Image


@pytest_asyncio.fixture(autouse=True)
async def files(settings,tmp_path):settings.file_root=tmp_path/'celeb-files'


async def create(client,identifier='example',**fields):
    raw={'requestId':str(uuid4()),'expectedRevision':0,'id':identifier,'name':'Registered public disclosure',**fields}
    response=await client.post('/api/celebs',json=raw)
    assert response.status_code==201,response.text
    return response.json(),raw


async def test_all_public_versions_crud_reorder_returns_unknown_and_no_owner_financial_writes(client,admin,app,db):
    created,raw=await create(client,holdings=[{'code':'PUBLIC','name':'Declared','quantity':'9007199254740993.123456789','cost':None,'currency':None}],returns={'y1':'12.34','points':['0','12.34']})
    assert created['result']['celeb']['dataAuthority']=='administrator_registered_disclosure'
    assert (await client.post('/api/celebs',json=raw)).json()==created
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as public:
        for prefix in ('/api/celebs','/api/v1/celebs','/api/v2/celebs'):
            listing=await public.get(prefix);assert listing.status_code==200,listing.text
            payload=listing.json() if prefix=='/api/celebs' else listing.json()['data']
            assert payload['celebs'][0]['holdings'][0]['quantity']=='9007199254740993.123456789'
            assert payload['celebs'][0]['holdings'][0]['cost'] is None
            detail=await public.get(prefix+'/example');assert detail.status_code==200,detail.text
            response=await public.get(prefix+'/example/returns');assert response.status_code==200,response.text
            returns=response.json() if prefix=='/api/celebs' else response.json()['data']
            assert returns['state']=='unknown' and returns['dates']==[] and returns['portfolioPerformanceKnown'] is False
            assert returns['disclosedSummary']['y1']=='12.34'
        assert (await public.get('/api/celebs/returns?celeb=example')).status_code==200
        assert (await public.get('/api/celebs/manage')).status_code==401
        assert (await public.post('/api/celebs',json=raw)).status_code==401
    assert (await client.get('/api/celebs/manage')).json()['celebs'][0]['returns']['points']==['0','12.34']
    await create(client,'second')
    reordered=await client.put('/api/celebs',json={'requestId':str(uuid4()),'expectedRevision':2,'reorder':['second','example']})
    assert reordered.status_code==200,reordered.text
    assert [r['id'] for r in (await client.get('/api/celebs')).json()['celebs']]==['second','example']
    patch={'requestId':str(uuid4()),'expectedRevision':2,'id':'example','title':'Updated declaration'}
    response=await client.put('/api/celebs',json=patch);assert response.status_code==200,response.text
    assert (await client.get('/api/celebs/operations/'+raw['requestId'])).json()==created
    deleted=await client.request('DELETE','/api/celebs',json={'requestId':str(uuid4()),'expectedRevision':3,'id':'example'})
    assert deleted.status_code==200,deleted.text
    assert (await client.get('/api/v2/celebs/example')).status_code==404
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM celeb_revisions WHERE celeb_id=%s',('example',))).fetchone())['n']==4
        for table in ('trade_ledger','cash_ledger_entries','portfolio_records'):
            assert (await(await conn.execute('SELECT count(*) n FROM '+table)).fetchone())['n']==0


async def test_legacy_admin_bearer_normalization_partial_update_cas_and_native_cannot_inherit_role(client,admin,app,db):
    from alcor_api.native_app_auth import issue_grant
    from alcor_api.security import digest
    async with db.connection() as conn:
        user=await(await conn.execute('SELECT * FROM users WHERE id=%s',(admin,))).fetchone()
        web,_=await app.state.legacy_create_session(conn,user,str(uuid4()))
        v1,_=await app.state.legacy_create_session(conn,user,str(uuid4()),v1=True)
        native=await issue_grant(conn,user,'portfolio.read','Public disclosure isolation')
        fake='C'*64
        await conn.execute("INSERT INTO sessions(token_hash,user_id,client_id,session_version,expires_at) VALUES(%s,%s,'new-web',%s,clock_timestamp()+interval '1 hour')",(digest(fake),admin,user['session_version']))
    client.cookies.set('fire_session',web)
    for token in (v1,native['access_token'],fake,''):
        assert (await client.get('/api/celebs/manage',headers={'authorization':'Bearer '+token})).status_code==401
    headers={'authorization':'Bearer '+web,'X-Alcor-Request-Id':str(uuid4())}
    response=await client.post('/api/celebs',json={'id':' Example ID! ','name':' A public declaration ','title':' Keep this ','enabled':True},headers=headers)
    assert response.status_code==201,response.text
    assert set(response.json())=={'celeb'} and response.json()['celeb']['id']=='example-id-'
    updated=await client.put('/api/celebs',json={'id':'example-id-','enabled':False,'name':None},headers={'authorization':'Bearer '+web,'X-Alcor-Request-Id':str(uuid4())})
    assert updated.status_code==200,updated.text
    assert updated.json()['celeb']['name']=='A public declaration' and updated.json()['celeb']['title']=='Keep this'
    rid=str(uuid4());bad=await client.put('/api/celebs',json={'requestId':rid,'expectedRevision':1,'id':'example-id-','title':'Stale'})
    assert bad.status_code==409,bad.text
    assert (await client.get('/api/celebs/operations/'+rid)).status_code==404
    ordered=await client.put('/api/celebs',json={'reorder':['example-id-']},headers={'authorization':'Bearer '+web,'X-Alcor-Request-Id':str(uuid4())})
    assert ordered.json()=={'ok':True},ordered.text
    assert set((await client.get('/api/celebs/manage',headers={'authorization':'Bearer '+web})).json())=={'celebs'}
    deleted=await client.delete('/api/celebs?id=Example%20ID!',headers={'authorization':'Bearer '+web,'X-Alcor-Request-Id':str(uuid4())})
    assert deleted.status_code==200 and deleted.json()=={'ok':True},deleted.text
    async with db.connection() as conn:await conn.execute("UPDATE users SET role='user' WHERE id=%s",(admin,))
    assert (await client.get('/api/celebs/manage',headers={'authorization':'Bearer '+web})).status_code==403


async def test_avatar_and_stock_icon_registered_versions_atomic_uuid_replay_and_no_external_urls(client,admin,db):
    await create(client)
    image=io.BytesIO();Image.new('RGB',(3,3),(20,40,60)).save(image,format='PNG');raw=image.getvalue()
    rid=str(uuid4());data={'id':'example','expectedRevision':'1','requestId':rid}
    response=await client.post('/api/celebs/avatar',data=data,files={'file':('avatar.png',raw,'image/png')})
    assert response.status_code==200,response.text
    avatar=response.json()['result']['celeb']['avatar']
    assert '?sha256=' in avatar and (await client.get(avatar)).status_code==200
    replay=await client.post('/api/celebs/avatar',data=data,files={'file':('avatar.png',raw,'image/png')})
    assert replay.json()==response.json(),replay.text
    bad=await client.post('/api/celebs/stock-icon',json={'requestId':str(uuid4()),'expectedRevision':2,'id':'example','code':'PUBLIC','url':'https://example.invalid/private.png'})
    assert bad.status_code==409,bad.text
    icon=await client.post('/api/celebs/stock-icon',json={'requestId':str(uuid4()),'expectedRevision':2,'id':'example','code':'PUBLIC','url':avatar})
    assert icon.status_code==200,icon.text
    assert icon.json()['result']['celeb']['stockIcons']=={'PUBLIC':avatar}
    async with db.connection() as conn:assert (await(await conn.execute('SELECT count(*) n FROM system_asset_versions')).fetchone())['n']==1


def target(app,owner):
    value={'id':'sec-example','ownerId':owner,'instanceId':str(app.state.db.settings.instance_id),'approvedAccess':True,'purpose':'celebs.sec.collect','provider':'sec-edgar','licenseRevision':'synthetic-sec-v1','expiresAt':'2099-01-01T00:00:00+00:00','cik':'0000000123','sourceKind':'13f','celebId':'example','userAgent':'Synthetic admin@example.invalid','addresses':{'data.sec.gov':['93.184.216.34'],'www.sec.gov':['93.184.216.34']}}
    app.state.db.settings.celeb_source_targets=[value];return value


XML=b'<informationTable><infoTable><nameOfIssuer>Declared issuer</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>123456789</cusip><value>123.456789</value><shrsOrPrnAmt><sshPrnamt>9007199254740993.00001</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable></informationTable>'


class SEC:
    def __init__(self):self.calls=[];self.hook=None
    async def read(self,request):
        self.calls.append(request.url)
        if self.hook:await self.hook(request)
        if 'submissions/' in request.url:return json.dumps({'cik':123,'filings':{'recent':{'form':['13F-HR'],'accessionNumber':['0000000123-26-000001'],'filingDate':['2026-10-01'],'reportDate':['2026-09-30'],'primaryDocument':['infotable.xml']}}}).encode()
        if request.url.endswith('index.json'):return b'{"directory":{"item":[{"name":"infotable.xml"}]}}'
        return XML


async def collect(client,app,provider):
    rid=str(uuid4());raw={'requestId':rid,'celebId':'example','revision':1,'targetId':'sec-example'}
    response=await client.post('/api/celebs/sources/collect',json=raw);assert response.status_code==200,response.text
    task=await claim(app.state.db,uuid4());assert task and task['kind']=='celeb.sec_collect'
    worker=CelebSourceWorker(app.state.db);worker.transport=provider
    assert await worker.execute(task)
    read=await client.get('/api/celebs/sources/operations/'+rid);assert read.status_code==200,read.text
    return raw,read.json()


async def test_sec_originals_real_parser_public_unknown_units_replay_and_restore_corruption(client,admin,app,db):
    await create(client,sourceKind='13f',cik='0000000123')
    target(app,admin);provider=SEC()
    raw,out=await collect(client,app,provider)
    assert out['state']=='completed',out
    detail=(await client.get('/api/v2/celebs/example')).json()['data']
    assert detail['detail']['sourceIntegrity']['state']=='verified',detail
    holding=detail['celeb']['holdings'][0]
    assert holding['code']=='' and holding['market'] is None and holding['currency'] is None
    assert holding['quantity']=='9007199254740993.00001' and holding['valueUnit']=='unknown' and holding['cost'] is None
    page=out['result']['sourcePageId'];original=await client.get('/api/celebs/sources/originals/'+page)
    assert original.content==XML and original.headers['x-content-sha256']==hashlib.sha256(XML).hexdigest()
    assert (await client.post('/api/celebs/sources/collect',json=raw)).json()==out
    assert len(provider.calls)==3 and await claim(db,uuid4()) is None
    async with db.connection() as conn,conn.transaction():
        await conn.execute('ALTER TABLE celeb_source_pages DISABLE TRIGGER retain_celeb_source_page')
        await conn.execute('UPDATE celeb_source_pages SET raw=%s WHERE id=%s',(b'<informationTable/>',page))
        await conn.execute('ALTER TABLE celeb_source_pages ENABLE TRIGGER retain_celeb_source_page')
    after=(await client.get('/api/celebs/example')).json()
    assert after['detail']['sourceIntegrity']['state']=='retained_unavailable'
    assert after['celeb']['holdings']==detail['celeb']['holdings']
    assert after['celeb']['dataAuthority']=='registered_disclosure_source_retained_unavailable'
    assert (await client.get('/api/celebs/sources/originals/'+page)).status_code==503
    async with db.connection() as conn:assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==0


async def test_dated_disclosed_returns_are_exact_observations_not_synthetic_portfolio_performance(client,admin):
    await create(client,returns={'dates':['2025-01-01','2025-02-01'],'values':['0','1.234567890123456789'],'currency':'USD','source':'published report','sourceUrl':'https://example.invalid/disclosure','benchmarks':[{'code':'INDEX','name':'Published benchmark','values':['0',None]}]})
    result=(await client.get('/api/celebs/returns?celebId=example')).json()
    assert result['state']=='observed' and result['values']==['0','1.234567890123456789'],result
    assert result['benchmarks'][0]['values']==['0',None]
    assert result['portfolioPerformanceKnown'] is False and result['calculation']['holdingsBackfilled'] is False
    response=await client.put('/api/celebs',json={'requestId':str(uuid4()),'expectedRevision':1,'id':'example','returns':{'dates':['2025-01-01'],'values':['9'],'source':'synthetic','synthetic':True}})
    assert response.status_code==200,response.text
    result=(await client.get('/api/celebs/example/returns')).json()
    assert result['state']=='unknown' and result['dates']==[] and result['values']==[]


async def test_received_sec_response_survives_late_license_revoke_and_unknown_never_recollects(client,admin,app,db):
    await create(client,sourceKind='13f',cik='0000000123')
    installed=target(app,admin);provider=SEC()
    async def revoke(_request):installed['approvedAccess']=False
    provider.hook=revoke
    raw,out=await collect(client,app,provider)
    assert out['state']=='unavailable',out
    assert len(out['sourcePages'])==1 and out['sourcePages'][0]['complete'] is True,out
    assert (await client.get(out['sourcePages'][0]['originalPath'])).status_code==200
    assert (await client.post('/api/celebs/sources/collect',json=raw)).json()==out
    assert len(provider.calls)==1 and await claim(db,uuid4()) is None
    assert (await client.get('/api/celebs/example')).json()['celeb']['holdings']==[]
    installed['approvedAccess']=True
    class Lost(SEC):
        async def read(self,request):
            self.calls.append(request.url)
            raise TimeoutError('Synthetic unavailable response')
    lost=Lost();request,unknown=await collect(client,app,lost)
    assert unknown['state']=='unknown' and unknown['sourcePages']==[],unknown
    assert (await client.post('/api/celebs/sources/collect',json=request)).json()==unknown
    assert len(lost.calls)==1 and await claim(db,uuid4()) is None
    from alcor_api.sec_company_transport import PageFailure
    class Oversized(SEC):
        async def read(self,request):
            self.calls.append(request.url)
            raise PageFailure(b'x'*(8388608+1),502,True)
    oversized=Oversized();request,retained=await collect(client,app,oversized)
    assert retained['state']=='unavailable' and retained['sourcePages'][0]['complete'] is False,retained
    download=await client.get(retained['sourcePages'][0]['originalPath'])
    assert download.status_code==200 and len(download.content)==8388608
    assert hashlib.sha256(download.content).hexdigest()==retained['sourcePages'][0]['sha256']
    assert (await client.post('/api/celebs/sources/collect',json=request)).json()==retained
    assert len(oversized.calls)==1 and await claim(db,uuid4()) is None


async def test_form4_original_transaction_is_disclosure_not_trade_and_fee_unknown(client,admin,app,db):
    await create(client,sourceKind='form4',cik='0000000123')
    installed=target(app,admin);installed['sourceKind']='form4'
    xml=b'<ownershipDocument><issuer><issuerName>Issuer</issuerName><issuerTradingSymbol>FORM</issuerTradingSymbol></issuer><nonDerivativeTransaction><securityTitle>Common</securityTitle><transactionDate><value>2026-09-30</value></transactionDate><transactionCoding><transactionCode>A</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>3.000000001</value></transactionShares><transactionPricePerShare><value>7.123456789</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>10</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeTransaction></ownershipDocument>'
    class Form4(SEC):
        async def read(self,request):
            self.calls.append(request.url)
            if 'submissions/' in request.url:return json.dumps({'cik':123,'filings':{'recent':{'form':['4'],'accessionNumber':['0000000123-26-000001'],'filingDate':['2026-10-01'],'reportDate':['2026-09-30'],'primaryDocument':['ownership.xml']}}}).encode()
            return xml
    provider=Form4();_,out=await collect(client,app,provider)
    assert out['state']=='completed' and len(provider.calls)==2,out
    data=(await client.get('/api/celebs/example')).json()
    assert data['detail']['sourceIntegrity']['state']=='verified',data
    trade=data['celeb']['trades'][0]
    assert trade['action']=='A' and trade['quantity']=='3.000000001' and trade['price']=='7.123456789'
    assert trade['currency'] is None and trade['cost'] is None and trade['amount'] is None
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==0
        assert (await(await conn.execute('SELECT count(*) n FROM cash_ledger_entries')).fetchone())['n']==0
