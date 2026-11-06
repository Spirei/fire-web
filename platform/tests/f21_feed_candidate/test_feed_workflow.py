"""F21 owner HTTP and real immutable stage chain; all supplier IO is controlled."""
import hashlib
import io
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from PIL import Image
from alcor_api.feed_model import FeedModel
from alcor_api.feed_worker import FeedWorker
from alcor_api.feed_transport import FeedTransport, Response
from alcor_api.worker import claim
from test_legacy_devices import grant, bearer


def target(db, owner, identifier='rss', provider='rss-atom', purpose='feed.subscription.read', url='https://example.com/rss'):
    return dict(id=identifier,ownerId=owner,instanceId=str(db.settings.instance_id),provider=provider,purpose=purpose,url=url,
        approvedAccess=True,addresses=['93.184.216.34'],licenseRevision='synthetic-license-1',expiresAt=(datetime.now(UTC)+timedelta(days=1)).isoformat(),name='Verified feed')


def wire(text):
    return json.dumps({'model':'explicit-test-model','choices':[{'finish_reason':'stop','message':{'content':json.dumps(text)}}]}).encode()


async def execute(db):
    task=await claim(db,uuid4())
    assert task, 'explicit HTTP intent must create one real task'
    await FeedWorker(db).execute(task)
    return task


@pytest.mark.parametrize('version',[1,2])
async def test_old_owner_actions_avatar_and_strict_credentials(client,db,admin,version,tmp_path):
    db.settings.file_root=tmp_path.resolve()/'private-files'
    pair=await grant(db,admin,'portfolio.read feed.read feed.write')
    headers=bearer(pair);base=f'/api/v{version}/feed'
    for path in ('','/groups','/profile','/jobs'):
        response=await client.get(base+path,headers=headers)
        assert response.status_code==200,response.text
    rid=str(uuid4())
    group=await client.post(base+'/groups',headers={**headers,'X-Alcor-Request-Id':rid},json={'name':'Exact group'})
    assert group.status_code==200,group.text
    gid=group.json()['data']['id']
    assert (await client.post(base+'/groups',headers={**headers,'X-Alcor-Request-Id':rid},json={'name':'Exact group'})).json()==group.json()
    response=await client.put(base+'/groups/'+gid,headers=headers,json={'name':'Renamed','revision':0})
    assert response.status_code==200,response.text
    prefs=await client.put(base+'/preferences?group='+gid,headers=headers,json={'revision':1,'instructions':'Public news','subscriptions':[],'enabled':False,'intervalMinutes':360})
    assert prefs.status_code==200,prefs.text
    profile=(await client.get(base+'/profile',headers=headers)).json()['data']
    changed=await client.put(base+'/profile',headers=headers,json={'name':'Own agent','revision':profile['revision']})
    assert changed.status_code==200,changed.text
    first=Image.new('RGB',(3,3),'red');second=Image.new('RGB',(3,3),'blue');raw=io.BytesIO();first.save(raw,format='GIF',save_all=True,append_images=[second],duration=100,loop=0)
    upload=await client.post(base+'/profile/avatar',headers=headers,data={'revision':str(changed.json()['data']['revision']),'requestId':str(uuid4())},files={'file':('agent.gif',raw.getvalue(),'image/gif')})
    assert upload.status_code==200,upload.text
    image=upload.json()['data']['image']
    downloaded=await client.get(image,headers=headers)
    assert downloaded.status_code==200 and downloaded.content==raw.getvalue()
    denied=await client.get('/api/feed',headers={'Authorization':''})
    assert denied.status_code==401
    read=await grant(db,admin,'portfolio.read feed.read')
    assert (await client.post(base+'/groups',headers=bearer(read),json={'name':'Denied'})).status_code==403
    other=await client.get(base+'/groups/'+gid,headers=headers)
    assert other.status_code==404


async def test_plan_search_article_review_originals_and_replay(client,db,admin,monkeypatch):
    db.settings.feed_targets=[target(db,admin),target(db,admin,'search','google-news-rss','feed.search','https://news.google.com/rss/search'),target(db,admin,'publisher','publisher-html','feed.article.read','https://example.com/')]
    db.settings.feed_model_targets=[{**target(db,admin,'model','deepseek','feed.compose','https://api.deepseek.com/chat/completions'),'model':'explicit-test-model','credentialCiphertext':'not-decrypted-by-controlled-transport'}]
    calls=[]
    async def model(self,t,context,**kwargs):
        content=context[0]['content'];phase='plan'if 'Plan public' in content else 'review'if 'Review the drafts' in content else 'edit'
        calls.append(phase)
        value={'queries':['Public semiconductor news']}if phase=='plan'else{'posts':[{'title':'Verified item','segments':[{'text':'Actual archived source evidence only.','sourceId':'s1'}]}]}
        return {'raw':wire(value),'status':200,'bodyComplete':True,'complete':True}
    async def read(self,t,*,params=None):
        calls.append(t['provider'])
        if t['provider']=='publisher-html':return Response(b'<html><main><p>'+b'Public verified article content. '*9+b'</p></main></html>',200,True,'text/html')
        return Response(b'<rss><channel><title>Source title</title><item><title>Actual title</title><link>https://example.com/item</link><description>Actual source excerpt.</description><pubDate>Tue, 03 Nov 2026 01:00:00 GMT</pubDate></item></channel></rss>',200)
    monkeypatch.setattr(FeedModel,'complete',model);monkeypatch.setattr(FeedTransport,'read',read)
    saved=await client.put('/api/feed/preferences',json={'requestId':str(uuid4()),'revision':0,'instructions':'Public semiconductor news','enabled':False,'intervalMinutes':360,'subscriptions':[{'name':'Own RSS','url':'https://example.com/rss'}]})
    assert saved.status_code==200,saved.text
    rid=str(uuid4());command={'requestId':rid,'groupId':'default','groupRevision':1}
    response=await client.post('/api/feed/refresh',json=command)
    assert response.status_code==200,response.text
    task=await execute(db)
    result=await client.get('/api/feed/operations/'+rid)
    assert result.status_code==200,result.text
    assert result.json()['state']=='succeeded',result.text
    assert calls==['plan','rss-atom','google-news-rss','publisher-html','edit','review']
    replay=await client.post('/api/feed/refresh',json=command)
    assert replay.status_code==200 and replay.json()['jobId']==response.json()['jobId']
    assert len(calls)==6
    async with db.connection()as conn:
        rows=await(await conn.execute('SELECT a.*,p.raw,p.raw_sha256 FROM feed_source_admissions a JOIN feed_source_pages p USING(owner_id,job_id,target_key) WHERE a.job_id=%s ORDER BY a.admitted_at',(response.json()['jobId'],))).fetchall()
        assert len(rows)==6
        for row in rows:
            original=bytes(row['input_bytes']);assert hashlib.sha256(original).hexdigest()==row['input_sha256']
            assert hashlib.sha256(bytes(row['raw'])).hexdigest()==row['raw_sha256']
            assert b'credentialCiphertext'not in original and b'not-decrypted'not in original
        posts=await(await conn.execute('SELECT * FROM feed_posts WHERE owner_id=%s',(admin,))).fetchall()
        assert len(posts)==1 and posts[0]['payload']['original']['pipeline']=='Plan/retrieval/article/Edit/Review'
    pid=posts[0]['id']
    pair=await grant(db,admin,'portfolio.read feed.read feed.write')
    for version in (1,2):
        old=f'/api/v{version}/feed'
        assert (await client.get(old+'/posts/'+pid,headers=bearer(pair))).status_code==200
        assert (await client.get(old+'/posts/'+pid+'/discussion',headers=bearer(pair))).json()['data']['messages']==[]
        mark=await client.put(old+'/posts/'+pid,headers=bearer(pair),json={'liked':True,'hidden':False})
        assert mark.status_code==200,mark.text
        job=await client.get(old+'/jobs/'+response.json()['jobId'],headers=bearer(pair))
        assert job.status_code==200 and job.json()['data']['status']=='done'and job.json()['data']['revision']==1
    # Exact stage input is an owner/job/instance-bound original, not arbitrary JSON.
    import psycopg
    async with db.connection()as conn,conn.transaction():
        original=rows[0];body=json.loads(bytes(original['input_bytes']))
        for patch,preds in (({'ownerId':'foreign-owner'},[]),({'predecessorPageIds':[str(uuid4())]},None)):
            data={**body,**patch};badpreds=preds if preds is not None else data['predecessorPageIds'];data['predecessorPageIds']=badpreds
            raw=json.dumps(data).encode()
            with pytest.raises(psycopg.errors.CheckViolation):
                async with conn.transaction():
                    await conn.execute('INSERT INTO feed_source_admissions(owner_id,job_id,target_key,target_id,target_fingerprint,license_revision,purpose,lease_owner,lease_version,stage,input_bytes,input_sha256,predecessor_page_ids) VALUES('+','.join(['%s']*13)+')',
                        (admin,original['job_id'],'forged-'+uuid4().hex,original['target_id'],original['target_fingerprint'],original['license_revision'],original['purpose'],original['lease_owner'],original['lease_version'],original['stage'],raw,hashlib.sha256(raw).hexdigest(),badpreds))
    assert (await client.get('/api/feed/posts/'+pid)).status_code==200
    marked=await client.put('/api/feed/posts/'+pid,json={'requestId':str(uuid4()),'liked':True})
    assert marked.status_code==200,marked.text
    assert (await client.get('/api/feed/jobs/'+response.json()['jobId'])).status_code==200


@pytest.mark.parametrize('outcome',['revoke','partial','unknown'])
async def test_issued_source_retained_and_never_reissued(client,db,admin,monkeypatch,outcome):
    installed=target(db,admin);db.settings.feed_targets=[installed];calls=[]
    async def read(self,t,*,params=None):
        calls.append(t['id'])
        if outcome=='unknown':raise TimeoutError('controlled no confirmed response')
        if outcome=='revoke':installed['approvedAccess']=False
        return Response(b'actual observed reply prefix',502,outcome=='revoke')
    monkeypatch.setattr(FeedTransport,'read',read)
    rid=str(uuid4());command={'requestId':rid,'targetId':'rss'}
    admitted=await client.post('/api/feed/subscriptions/test',json=command)
    assert admitted.status_code==200,admitted.text
    task=await execute(db)
    result=(await client.get('/api/feed/operations/'+rid)).json()
    assert result['state'] in {'failed','partial','unknown'},result
    async with db.connection()as conn:
        admissions=await(await conn.execute('SELECT * FROM feed_source_admissions WHERE owner_id=%s',(admin,))).fetchall()
        pages=await(await conn.execute('SELECT * FROM feed_source_pages WHERE owner_id=%s',(admin,))).fetchall()
        assert len(admissions)==1
        assert len(pages)==(0 if outcome=='unknown'else 1)
        if pages:
            assert bytes(pages[0]['raw'])==b'actual observed reply prefix'
            assert pages[0]['raw_sha256']==hashlib.sha256(bytes(pages[0]['raw'])).hexdigest()
        assert (await(await conn.execute('SELECT count(*)n FROM feed_posts WHERE owner_id=%s',(admin,))).fetchone())['n']==0
    # Reentering the exact admitted task and exact original HTTP UUID is read/reconcile only.
    await FeedWorker(db).execute(task)
    assert (await client.post('/api/feed/subscriptions/test',json=command)).status_code==200
    assert calls==['rss']


@pytest.mark.parametrize('version',[1,2])
@pytest.mark.parametrize('fallback',[False,True])
async def test_legacy_web_is_local_bridge_and_discussion_has_real_reply(client,db,admin,monkeypatch,version,fallback):
    logged=await client.post('/api/auth/login',json={'username':'AdminOne','password':'Synthetic9Pass'})
    assert logged.status_code==200,logged.text
    for path in ('','/groups','/profile','/jobs'):
        response=await client.get('/api/v1/feed'+path)
        assert response.status_code==200,response.text
    from alcor_api.feed_core import FeedService
    async with db.connection()as conn,conn.transaction():
        inserted=await FeedService(db).ingest_on_connection(conn,admin,'default',[{'title':'Stored source','icon':'note','segments':[{'text':'Verified source text'}],'sources':[{'id':'s1','title':'Real original','url':'https://example.com/original','publishedAt':None}],'media':[],'publishedAt':None}],source_revision='explicit-source-rev',source_page_id='synthetic-page',expected_revision=0)
    pid=inserted['postIds'][0]
    db.settings.feed_model_targets=[{**target(db,admin,'discussion','deepseek','feed.discussion','https://api.deepseek.com/chat/completions'),'model':'explicit-test-model','credentialCiphertext':'controlled'}]
    if fallback:db.settings.feed_model_targets.insert(0,{**db.settings.feed_model_targets[0],'id':'denied'})
    calls=[]
    async def model(self,t,context,**kwargs):
        calls.append(t['id'])
        if t['id']=='denied':return {'raw':b'actual denied','status':403,'bodyComplete':True,'complete':False}
        raw=json.dumps({'choices':[{'finish_reason':'stop','message':{'content':'Actual controlled answer'}}]}).encode()
        return {'raw':raw,'status':200,'bodyComplete':True,'complete':True,'text':'Actual controlled answer'}
    monkeypatch.setattr(FeedModel,'complete',model)
    rid=str(uuid4());headers={'X-Alcor-Request-Id':rid}
    if version==2:headers.update(bearer(await grant(db,admin,'portfolio.read feed.read feed.write')))
    response=await client.post(f'/api/v{version}/feed/posts/'+pid+'/discussion',json={'text':'Explain this source'},headers=headers)
    assert response.status_code==202,response.text
    await execute(db)
    receipt=await client.get('/api/feed/operations/'+rid)
    assert receipt.status_code==200,receipt.text
    assert receipt.json()['replyState']=='succeeded',receipt.text
    messages=(await client.get(f'/api/v{version}/feed/posts/'+pid+'/discussion',headers=headers)).json()['data']['messages']
    assert [m['role']for m in messages]==['user','assistant']
    assert messages[-1]['text']=='Actual controlled answer'
    assert (await client.post(f'/api/v{version}/feed/posts/'+pid+'/discussion',json={'text':'Explain this source'},headers=headers)).status_code==200
    assert calls==(['denied','discussion']if fallback else['discussion'])


@pytest.mark.parametrize('unknown',[False,True])
@pytest.mark.parametrize('version',[1,2])
async def test_legacy_configured_model_fallback_only_after_known_reply(client,db,admin,monkeypatch,unknown,version):
    installed=target(db,admin);db.settings.feed_targets=[installed]
    db.settings.feed_model_targets=[{**target(db,admin,name,'deepseek','feed.compose','https://api.deepseek.com/chat/completions'),'model':'explicit-'+name,'credentialCiphertext':'controlled'}for name in ('first','second')]
    pair=await grant(db,admin,'portfolio.read feed.read feed.write');headers=bearer(pair)
    prefs=await client.put(f'/api/v{version}/feed/preferences',headers=headers,json={'revision':0,'instructions':'Public news','enabled':False,'subscriptions':[{'name':'Own source','url':installed['url']}]})
    assert prefs.status_code==200,prefs.text
    calls=[]
    async def model(self,t,context,**kwargs):
        calls.append(t['id'])
        if t['id']=='first':
            if unknown:raise TimeoutError('unconfirmed supplier outcome')
            return {'raw':b'known denied','status':403,'bodyComplete':True,'complete':False}
        phase='plan'if'Plan public'in context[0]['content']else'review'if'Review the drafts'in context[0]['content']else'edit'
        value={'queries':['Public topic']}if phase=='plan'else{'posts':[{'title':'Cited','segments':[{'text':'Original source evidence','sourceId':'s1'}]}]}
        return {'raw':wire(value),'status':200,'bodyComplete':True,'complete':True}
    async def read(self,t,**kwargs):return Response(b'<rss><channel><item><title>Actual</title><link>https://example.com/actual</link><description>Original evidence</description></item></channel></rss>',200)
    monkeypatch.setattr(FeedModel,'complete',model);monkeypatch.setattr(FeedTransport,'read',read)
    rid=str(uuid4());response=await client.post(f'/api/v{version}/feed/refresh',json={},headers={**headers,'X-Alcor-Request-Id':rid})
    assert response.status_code==200,response.text
    await execute(db)
    current=(await client.get('/api/feed/operations/'+rid)).json()
    assert current['state']==('unknown'if unknown else'succeeded'),current
    assert calls==(['first']if unknown else['first','second']*3)
    before=len(calls)
    assert (await client.post(f'/api/v{version}/feed/refresh',json={},headers={**headers,'X-Alcor-Request-Id':rid})).status_code==200
    assert len(calls)==before


async def test_explicit_schedule_and_read_only_owner_isolation(client,db,admin,monkeypatch):
    db.settings.feed_targets=[target(db,admin)]
    calls=[]
    async def read(self,t,**kwargs):
        calls.append(t['id'])
        return Response(b'<rss><channel><title>Actual feed</title><item><title>Actual item</title><link>https://example.com/actual</link><description>Actual original</description></item></channel></rss>',200)
    monkeypatch.setattr(FeedTransport,'read',read)
    command={'requestId':str(uuid4()),'revision':0,'instructions':'Public news','enabled':True,'intervalMinutes':60,'subscriptions':[{'name':'Actual','url':'https://example.com/rss'}]}
    result=await client.put('/api/feed/preferences',json=command)
    assert result.status_code==200,result.text
    assert result.json()['automation']['scheduled']is True
    await execute(db)
    async with db.connection()as conn:
        await conn.execute("UPDATE feed_source_jobs SET updated_at=updated_at-interval '2 hours' WHERE owner_id=%s",(admin,))
    worker=FeedWorker(db);assert await worker.schedule()==1
    assert await worker.schedule()==0
    assert calls==['rss'] # schedule only admits a task, never performs supplier IO itself.
    async with db.connection()as conn:
        tables=['feed_groups','feed_preferences','feed_posts','feed_post_marks','feed_agent_profiles','feed_source_jobs','feed_source_admissions','feed_source_pages']
        async def snapshot():return [await(await conn.execute('SELECT to_jsonb(t)row FROM '+table+' t ORDER BY to_jsonb(t)::text')).fetchall()for table in tables]
        before=await snapshot()
    for path in ('','/groups','/preferences','/profile','/jobs','/targets'):
        response=await client.get('/api/feed'+path)
        assert response.status_code==200,response.text
    async with db.connection()as conn:assert await snapshot()==before
    from alcor_api.cli import create_user
    foreign=await create_user(db.settings,'OtherFeedOwner','Synthetic9Pass')
    pair=await grant(db,foreign,'portfolio.read feed.read feed.write')
    async with db.connection()as conn:post=await(await conn.execute('SELECT id FROM feed_posts WHERE owner_id=%s LIMIT 1',(admin,))).fetchone()
    assert (await client.get('/api/v2/feed/posts/'+post['id'],headers=bearer(pair))).status_code==404
    assert (await client.get('/api/v2/feed/jobs/'+result.json()['automation']['jobId'],headers=bearer(pair))).status_code==404


@pytest.mark.parametrize('version',[1,2])
async def test_old_subscription_test_real_result_not_queued_dto(client,db,admin,monkeypatch,version):
    db.settings.feed_targets=[target(db,admin)];calls=[]
    async def read(self,t,**kwargs):
        calls.append(t['id'])
        return Response(b'<rss><channel><title>Observed source</title><item><title>Item</title><link>https://example.com/one</link></item></channel></rss>',200)
    monkeypatch.setattr(FeedTransport,'read',read)
    pair=await grant(db,admin,'portfolio.read feed.read feed.write');headers={**bearer(pair),'X-Alcor-Request-Id':str(uuid4())}
    path=f'/api/v{version}/feed/subscriptions/test';raw={'name':'Original name','url':'https://example.com/rss'}
    result=await client.post(path,headers=headers,json=raw)
    assert result.status_code==202 and result.json()['data']['pending']is True,result.text
    await execute(db)
    final=await client.post(path,headers=headers,json=raw)
    assert final.status_code==200,final.text
    assert {k:final.json()['data'][k]for k in ('title','count','url')}=={'title':'Observed source','count':1,'url':raw['url']}
    assert calls==['rss']
    async with db.connection()as conn:assert (await(await conn.execute('SELECT count(*)n FROM feed_posts WHERE owner_id=%s',(admin,))).fetchone())['n']==0
