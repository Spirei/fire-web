"""Anonymous people originals and translation evidence, no outbound transport."""
import hashlib
import json
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from alcor_api.feed_core import FeedService
from alcor_api.feed_model import FeedModel
from alcor_api.feed_people import parse_people
from alcor_api.feed_sources import fingerprint
from psycopg.types.json import Jsonb


def install(app,owner,person,provider='person-original-json',public=True):
    url='https://example.invalid/'+person
    if provider=='trump-archive-html':url='https://trumpstruth.org/'
    if provider=='xueqiu-status-json':url='https://api.xueqiu.com/statuses/user_timeline.json?user_id=1247347556'
    target={'id':person+'-'+provider,'ownerId':owner,'instanceId':str(app.state.db.settings.instance_id),'approvedAccess':True,'licenseRevision':'public-person-synthetic-v1','expiresAt':'2099-01-01T00:00:00+00:00','purpose':'feed.person.read','provider':provider,'personId':person,'publicDisplay':public,'translationPublicDisplay':True,'url':url,'addresses':['93.184.216.34'],'refreshMinutes':30}
    if provider=='xueqiu-status-json':target['credentialCiphertext']='server-held-synthetic-cookie-never-published'
    app.state.db.settings.feed_targets=[*app.state.db.settings.feed_targets,target];return target


def post(person,number='10000',text='Original statement',date='2026-10-01T12:00:00+00:00'):
    return {'id':number,'text':text,'date':date,'originalUrl':('https://truthsocial.com/@realDonaldTrump/' if person=='trump' else 'https://xueqiu.com/1247347556/')+number,'images':['https://images.example.invalid/public.png'],'quote':{'name':'Quoted source','text':'Quote','url':'https://example.invalid/quote','images':['https://images.example.invalid/quote.png']}}


async def retain(app,db,owner,target,raw):
    job,task,rid,page=uuid4(),uuid4(),uuid4(),uuid4();group='fg-'+hashlib.sha256(target['id'].encode()).hexdigest()[:24];digest=fingerprint(target)
    async with db.connection() as conn,conn.transaction():
        await conn.execute("INSERT INTO feed_groups(owner_id,id,name,mode,people) VALUES(%s,%s,'Public people','people',%s) ON CONFLICT DO NOTHING",(owner,group,Jsonb([target['personId']])))
        await conn.execute("INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,%s,'feed.refresh','queued','{}')",(task,owner,rid,digest))
        await conn.execute("INSERT INTO feed_source_jobs(owner_id,id,request_id,task_id,kind,group_id,group_revision,inputs,subject,fingerprint) VALUES(%s,%s,%s,%s,'refresh',%s,0,'{}',%s,%s)",(owner,job,rid,task,group,Jsonb({'instanceId':str(db.settings.instance_id)}),digest))
        await conn.execute('INSERT INTO feed_source_admissions(owner_id,job_id,target_key,target_id,target_fingerprint,license_revision,purpose,lease_owner,lease_version) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,1)',(owner,job,'rss:'+target['id'],target['id'],digest,target['licenseRevision'],'feed.person.read',uuid4()))
        await conn.execute("INSERT INTO feed_source_pages(owner_id,id,job_id,target_key,target_id,target_fingerprint,license_revision,raw,raw_sha256,http_status,complete,representation) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,200,true,%s)",(owner,page,job,'rss:'+target['id'],target['id'],digest,target['licenseRevision'],raw,hashlib.sha256(raw).hexdigest(),target['provider']+'_http_response_body'))
        added=await FeedService(db).ingest_on_connection(conn,owner,group,parse_people(raw,target)['posts'],source_revision=digest,source_page_id=str(page))
    return {'job':job,'page':page,'group':group,'postIds':added['postIds']}


async def test_all_three_legacy_public_routes_real_originals_cursor_no_get_side_effect_or_private_feed(client,admin,app,db):
    trump=install(app,admin,'trump');duan=install(app,admin,'duan')
    await retain(app,db,admin,trump,json.dumps({'posts':[post('trump','10000'),post('trump','10001','Second statement')]}).encode())
    await retain(app,db,admin,duan,json.dumps({'posts':[post('duan','20000')]}).encode())
    private={**trump,'id':'private-person','publicDisplay':False}
    app.state.db.settings.feed_targets.append(private)
    await retain(app,db,admin,private,json.dumps({'posts':[post('trump','99999','Private never public')]}).encode())
    client.cookies.clear();client.headers.pop('x-csrf-token',None)
    async with db.connection() as conn:before=(await(await conn.execute('SELECT count(*) n FROM tasks')).fetchone())['n']
    for author in ('trump','duan','feed'):
        response=await client.get('/api/trading-square/'+author+'?refresh=1')
        assert response.status_code==200,response.text
        assert response.json()['migration']=={'refreshRequested':True,'refreshExecuted':False,'collectionOnRead':False}
        if author=='duan':assert response.json()['user']['id']=='1247347556'
        if author=='trump':assert response.json()['cached'] is True and response.json()['posts'][0]['images']
        if author=='feed':assert all('images' not in p and 'media' not in p for p in response.json()['posts'])
        assert 'server-held' not in response.text and 'Private never public' not in response.text and admin not in response.text
    seen=[];cursor=None
    while True:
        query={'limit':1}
        if cursor:query['cursor']=cursor
        response=await client.get('/api/public-square',params=query);assert response.status_code==200,response.text
        body=response.json();seen += [(p['author'],p['id'])for p in body['posts']];cursor=body['nextCursor']
        if not cursor:break
    assert len(seen)==3 and len(set(seen))==3
    duan['publicDisplay']=False
    assert (await client.get('/api/trading-square/duan')).status_code==503
    partial=await client.get('/api/trading-square/feed')
    assert partial.status_code==200 and partial.json()['state']=='partial',partial.text
    assert {p['author']for p in partial.json()['posts']}=={'trump'}
    assert partial.json()['coverage']['completeHistory'] is False and partial.json()['coverage']['retainedProjectionComplete'] is False
    assert partial.json()['updatedByAuthor']['duan'] is None
    assert (await client.get('/api/trading-square/trump')).status_code==200
    async with db.connection() as conn:assert (await(await conn.execute('SELECT count(*) n FROM tasks')).fetchone())['n']==before


async def test_actual_archive_and_xueqiu_parsers_bind_author_identity_date_and_retained_sha(client,admin,app,db):
    archive=install(app,admin,'trump','trump-archive-html')
    raw=b'<div class="status" data-status-url="10000"><a href="https://truthsocial.com/@realDonaldTrump/90000">Original</a><time datetime="2026-10-01T12:00:00+00:00"></time><div class="status__content">Archive original</div></div>'
    bound=await retain(app,db,admin,archive,raw)
    snow=install(app,admin,'duan','xueqiu-status-json')
    await retain(app,db,admin,snow,json.dumps({'statuses':[{'id':20000,'user':{'id':1247347556},'text':'回复@公开作者: 原帖','created_at':int(datetime(2026,10,1,tzinfo=UTC).timestamp()*1000)},{'id':20001,'user':{'id':999},'text':'Not this person','created_at':0}]}).encode())
    client.cookies.clear();client.headers.pop('x-csrf-token',None)
    value=(await client.get('/api/trading-square/feed')).json()
    assert len(value['posts'])==2,value
    trump=next(p for p in value['posts']if p['author']=='trump')
    assert trump['id']=='10000' and trump['originalUrl'].endswith('/90000')
    duan=next(p for p in value['posts']if p['author']=='duan');assert duan['replyTo']=='公开作者'
    async with db.connection() as conn,conn.transaction():
        await conn.execute('ALTER TABLE feed_source_pages DISABLE TRIGGER immutable_feed_source_page')
        await conn.execute('UPDATE feed_source_pages SET raw=%s WHERE id=%s',(b'<div>tampered</div>',bound['page']))
        await conn.execute('ALTER TABLE feed_source_pages ENABLE TRIGGER immutable_feed_source_page')
    assert (await client.get('/api/trading-square/trump')).status_code==503
    assert (await client.get('/api/trading-square/duan')).status_code==200


@pytest.mark.parametrize('provider',['mymemory','deepseek'])
async def test_public_translation_reparses_model_original_and_withholds_on_corruption_or_permission_revoke(client,admin,app,db,provider):
    source=install(app,admin,'trump');original=post('trump')
    bound=await retain(app,db,admin,source,json.dumps({'posts':[original]}).encode())
    installed={'id':'public-translation','ownerId':admin,'instanceId':str(db.settings.instance_id),'approvedAccess':True,'provider':'mymemory','purpose':'feed.translate','host':'api.mymemory.translated.net','model':'mymemory','publicDisplay':True,'addresses':['93.184.216.34'],'licenseRevision':'public-model-v1','expiresAt':'2099-01-01T00:00:00+00:00'}
    if provider=='deepseek':installed.update(provider='deepseek',host='api.deepseek.com',model='deepseek-chat',credentialCiphertext='server-only-synthetic-key')
    app.state.db.settings.feed_model_targets=[installed]
    model=FeedModel(db).target(admin,installed['id'],purpose='feed.translate');page=uuid4();key='model:public-translation'
    raw=b'{"responseStatus":200,"responseData":{"translatedText":"Real translated response"}}'
    if provider=='deepseek':raw=json.dumps({'choices':[{'finish_reason':'stop','message':{'content':json.dumps([{'personId':'trump','platformPostId':'10000','textZh':'Real translated response'}])}}]}).encode()
    translation={'personId':'trump','platformPostId':'10000','text':original['text'],'sourcePageId':str(bound['page']),'textZh':'Real translated response','translationAuthority':'licensed_model_translation','modelPublicDisplay':True,'publicDisplay':True}
    async with db.connection() as conn,conn.transaction():
        await conn.execute('INSERT INTO feed_source_admissions(owner_id,job_id,target_key,target_id,target_fingerprint,license_revision,purpose,lease_owner,lease_version) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,1)',(admin,bound['job'],key,model['id'],fingerprint(model),model['licenseRevision'],'feed.translate',uuid4()))
        await conn.execute("INSERT INTO feed_source_pages(owner_id,id,job_id,target_key,target_id,target_fingerprint,license_revision,raw,raw_sha256,http_status,complete,representation) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,200,true,'model_http_response_body')",(admin,page,bound['job'],key,model['id'],fingerprint(model),model['licenseRevision'],raw,hashlib.sha256(raw).hexdigest()))
        await conn.execute('INSERT INTO feed_source_results(owner_id,job_id,target_key,page_id,result) VALUES(%s,%s,%s,%s,%s)',(admin,bound['job'],key,page,Jsonb({'state':'succeeded','purpose':'feed.translate','translations':[translation]})))
    client.cookies.clear();client.headers.pop('x-csrf-token',None)
    response=await client.get('/api/trading-square/trump');assert response.status_code==200,response.text
    assert response.json()['posts'][0]['textZh']=='Real translated response'
    installed['publicDisplay']=False
    response=await client.get('/api/trading-square/trump');assert response.status_code==200,response.text
    assert 'textZh' not in response.json()['posts'][0]
    installed['publicDisplay']=True
    async with db.connection() as conn,conn.transaction():
        await conn.execute('ALTER TABLE feed_source_pages DISABLE TRIGGER immutable_feed_source_page')
        await conn.execute('UPDATE feed_source_pages SET raw=%s WHERE id=%s',(b'{"responseStatus":200,"responseData":{"translatedText":"Forged response"}}',page))
        await conn.execute('ALTER TABLE feed_source_pages ENABLE TRIGGER immutable_feed_source_page')
    response=await client.get('/api/trading-square/trump');assert response.status_code==200,response.text
    assert response.json()['posts'][0]['text']==original['text'] and 'textZh' not in response.json()['posts'][0]
    assert response.json()['translationMissing']==[{'personId':'trump','reason':'translation_original_unverified'}]
    source['translationPublicDisplay']=False
    assert (await client.get('/api/trading-square/trump')).status_code==503
