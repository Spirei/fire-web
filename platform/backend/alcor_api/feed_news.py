"""F21 Plan/retrieval/article/Edit/Review over the one existing feed job authority."""
import hashlib
import json
from datetime import UTC,datetime
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .feed_core import FeedService
from .feed_model import FeedModel
from .feed_model_chat import decoded
from .feed_news_contract import normalize_posts,object_reply,phase_messages
from .feed_parse import parse_feed
from .feed_search import article,balance,parse,topics
from .feed_sources import fingerprint
from .feed_transport import Response


def packed(value):return json.dumps(value,sort_keys=True,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode()


class NewsPipeline:
    def __init__(self,worker):
        self.worker,self.db,self.sources=worker,worker.db,worker.sources
        self.models=FeedModel(self.db)

    def target(self,job,selection,model=False):
        target=self.models.target(job['owner_id'],selection['id'],purpose='feed.compose')if model else self.sources.target(job['owner_id'],selection['id'])
        if fingerprint(target)!=selection['fingerprint']or target['licenseRevision']!=selection['licenseRevision']:raise HTTPException(409,'动态来源许可或配置已变化')
        return target

    async def predecessors(self,conn,job,identifiers):
        for pid in identifiers:
            row=await(await conn.execute('SELECT p.*,a.stage FROM feed_source_pages p JOIN feed_source_admissions a USING(owner_id,job_id,target_key) WHERE p.owner_id=%s AND p.job_id=%s AND p.id=%s',(job['owner_id'],job['id'],pid))).fetchone()
            if not row or hashlib.sha256(bytes(row['raw'])).hexdigest()!=row['raw_sha256']:raise HTTPException(409,'动态前驱原件不可核对')
            target=self.models.target(job['owner_id'],row['target_id'],purpose='feed.compose')if row['stage']in {'plan','edit','review'}else self.sources.target(job['owner_id'],row['target_id'])
            if fingerprint(target)!=row['target_fingerprint']or target['licenseRevision']!=row['license_revision']:raise HTTPException(409,'动态前驱许可已变化')

    async def saved(self,conn,job,key):
        row=await(await conn.execute('SELECT result FROM feed_source_results WHERE owner_id=%s AND job_id=%s AND target_key=%s',(job['owner_id'],job['id'],key))).fetchone()
        return row['result']if row else None

    async def stage(self,task,job,stage,selection,data,predecessors=()):
        model=stage in {'plan','edit','review'}
        ids=list(dict.fromkeys(str(x)for x in predecessors))
        body={'ownerId':job['owner_id'],'jobId':str(job['id']),'requestId':str(job['request_id']),'instanceId':job['subject']['instanceId'],
            'groupRevision':job['group_revision'],'stage':stage,'predecessorPageIds':ids,'input':data}
        raw_input=packed(body);input_sha=hashlib.sha256(raw_input).hexdigest()
        if len(raw_input)>131072:raise HTTPException(413,'动态阶段输入超过完整原件预算')
        key=stage+':'+selection['id']+':'+input_sha
        page=None;target=None
        async with self.db.connection()as conn,conn.transaction():
            owned=await self.worker.lock(conn,task)
            prior=await self.saved(conn,job,key)
            if prior:return prior
            if not owned:return {'state':'unknown','reason':'lease_lost_before_stage','stage':stage}
            reason=await self.worker.valid(conn,job)
            if owned['status']=='cancel_requested':reason='cancelled'
            base={'stage':stage,'targetId':selection['id'],'inputSha256':input_sha,'predecessorPageIds':ids,'willRetryAutomatically':False}
            if reason:return await self.worker.result(conn,job,key,{**base,'state':'unavailable','reason':reason})
            try:
                target=self.target(job,selection,model)
                await self.predecessors(conn,job,ids)
            except HTTPException:
                return await self.worker.result(conn,job,key,{**base,'state':'unavailable','reason':'current_target_or_predecessor_permission_changed'})
            admitted=await(await conn.execute('SELECT * FROM feed_source_admissions WHERE owner_id=%s AND job_id=%s AND target_key=%s',(job['owner_id'],job['id'],key))).fetchone()
            page=await(await conn.execute('SELECT * FROM feed_source_pages WHERE owner_id=%s AND job_id=%s AND target_key=%s',(job['owner_id'],job['id'],key))).fetchone()
            if admitted and not page:
                return await self.worker.result(conn,job,key,{**base,'state':'unknown','reason':'admitted_outcome_unconfirmed'})
            if not admitted:
                await conn.execute('''INSERT INTO feed_source_admissions(owner_id,job_id,target_key,target_id,target_fingerprint,license_revision,purpose,lease_owner,lease_version,stage,input_bytes,input_sha256,predecessor_page_ids)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(job['owner_id'],job['id'],key,selection['id'],selection['fingerprint'],selection['licenseRevision'],target['purpose'],task['lease_owner'],task['lease_version'],stage,raw_input,input_sha,ids))
        if page is None:
            try:
                async def operation():
                    if model:
                        response=await self.models.complete(target,data['messages'],structured=True)
                        return Response(response['raw'],response['status'],response.get('bodyComplete',False))
                    return await self.worker.transport.read(target,params=data.get('params'))
                response=await self.worker.pulse(task,operation)
            except Exception:
                async with self.db.connection()as conn,conn.transaction():
                    return await self.worker.result(conn,job,key,{**base,'state':'unknown','reason':'provider_outcome_unconfirmed'})
            # Bind observed history to the admitted original task, not the now-current
            # actor/lease. Revocation blocks publication, never erases an issued reply.
            async with self.db.connection()as conn,conn.transaction():
                binding=await(await conn.execute('''SELECT j.id FROM feed_source_jobs j JOIN tasks t ON t.id=j.task_id JOIN alcor_instance i ON i.singleton
                    WHERE j.owner_id=%s AND j.id=%s AND t.id=%s AND t.owner_id=j.owner_id AND j.subject->>'instanceId'=i.instance_id::text''',(job['owner_id'],job['id'],task['id']))).fetchone()
                if not binding:return {'state':'unknown','reason':'original_task_instance_unavailable','stage':stage}
                if not isinstance(response.raw,bytes)or len(response.raw)>1500000 or type(response.status)is not int:raise ValueError('feed_reply_not_bounded_original')
                page=await(await conn.execute('''INSERT INTO feed_source_pages(owner_id,id,job_id,target_key,target_id,target_fingerprint,license_revision,raw,raw_sha256,http_status,complete,representation)
                 VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING *''',
                    (job['owner_id'],uuid4(),job['id'],key,selection['id'],selection['fingerprint'],selection['licenseRevision'],response.raw,hashlib.sha256(response.raw).hexdigest(),response.status,response.complete,
                     ('model'if model else target['provider'])+'_http_response_body'+(':'+('text/html'if getattr(response,'content_type',None)=='text/html'else'unknown')if target.get('provider')=='publisher-html'else'')))).fetchone()
                if page is None:page=await(await conn.execute('SELECT * FROM feed_source_pages WHERE owner_id=%s AND job_id=%s AND target_key=%s',(job['owner_id'],job['id'],key))).fetchone()
        outcome={**base,'pageId':str(page['id']),'rawSha256':page['raw_sha256'],'httpStatus':page['http_status'],'complete':page['complete'],
            'inputOriginal':'/api/feed/originals/'+str(page['id'])+'/request'}
        async with self.db.connection()as conn,conn.transaction():
            prior=await self.saved(conn,job,key)
            if prior:return prior
            owned=await self.worker.lock(conn,task)
            reason=await self.worker.valid(conn,job)if owned else'lease_lost_after_read'
            if owned and owned['status']=='cancel_requested':reason='cancelled_after_read'
            try:
                self.target(job,selection,model);await self.predecessors(conn,job,ids)
            except HTTPException:reason='permission_changed_after_read'
            if reason:return await self.worker.result(conn,job,key,{**outcome,'state':'unavailable','reason':reason},page['id'])
            if not page['complete']or hashlib.sha256(bytes(page['raw'])).hexdigest()!=page['raw_sha256']:
                return await self.worker.result(conn,job,key,{**outcome,'state':'unknown','reason':'source_original_incomplete'},page['id'])
            if page['http_status']!=200:
                return await self.worker.result(conn,job,key,{**outcome,'state':'rejected'if 300<=page['http_status']<500 else'unknown','reason':'provider_http_status'},page['id'])
            try:
                async with conn.transaction():
                    raw=bytes(page['raw'])
                    if model:
                        text,_=decoded(raw);value=object_reply(text)
                        if stage=='plan':
                            queries=topics(value.get('queries'))
                            if not queries:raise ValueError('feed_public_topics_missing')
                            outcome['queries']=queries
                        else:
                            posts=normalize_posts(value.get('posts'),data['sources'])
                            if not posts:raise ValueError('feed_cited_posts_missing')
                            outcome['posts']=posts
                            if stage=='review':
                                for post in posts:post['original']={'modelGenerated':True,'modelPageId':str(page['id']),'sourcePageIds':ids,'instructionsRevision':job['group_revision'],'pipeline':'Plan/retrieval/article/Edit/Review','factVerification':'not_independently_verified'}
                                published=await FeedService(self.db).ingest_on_connection(conn,job['owner_id'],job['group_id'],posts,source_revision=selection['fingerprint'],source_page_id=str(page['id']),expected_revision=job['group_revision'])
                                outcome.update(published,instructionsApplied=True)
                    elif stage=='rss':outcome['sources']=parse_feed(raw,target['url'],target.get('name',''))['sources']
                    elif stage=='search':outcome['sources']=parse(target['provider'],raw,url=target['url'])
                    elif stage=='article':
                        outcome['article']=article(raw,data['params']['url'])if page['representation'].endswith(':text/html')else None
                        outcome['articleState']='verified_body'if outcome['article']else'unavailable_body_or_content_type'
                    else:raise ValueError('feed_stage_unsupported')
                    return await self.worker.result(conn,job,key,{**outcome,'state':'succeeded'},page['id'])
            except (ValueError,TypeError,KeyError,IndexError,HTTPException):
                return await self.worker.result(conn,job,key,{**outcome,'state':'rejected','reason':'model_format_invalid'if model else'source_format_invalid'},page['id'])

    async def model(self,task,job,phase,selection,messages,pages,*,sources=None):
        prior_pages=list(pages)
        for provider_index,chosen in enumerate([selection,*job['inputs'].get('composeFallbacks',[])][:2]):
            data={'messages':messages,'sources':sources or[],'structured':True,'providerAttempt':provider_index}
            result=await self.stage(task,job,phase,chosen,data,prior_pages)
            if result.get('state')=='rejected'and result.get('reason')=='model_format_invalid'and result.get('complete')and result.get('httpStatus')==200:
                # Retry only a complete, observed invalid format, never unknown IO.
                data={**data,'attempt':2,'messages':[{**m,'content':m['content']+('\nPrevious output failed JSON validation. Return only one smaller complete JSON object.'if m['role']=='system'else'')}for m in messages]}
                result=await self.stage(task,job,phase,chosen,data,[*prior_pages,result['pageId']])
            if result.get('state')=='succeeded':return result
            if result.get('state')not in {'rejected'}or not result.get('complete')or not result.get('pageId'):return result
            # A second explicitly installed text provider is an original legacy
            # configured fallback, after a known reply only. Bind its predecessor.
            prior_pages=[*prior_pages,result['pageId']]
        return result

    async def execute(self,task,job):
        selected=job['inputs']['composeTarget'];today=job['created_at'].astimezone(UTC).isoformat();instructions=job['inputs']['instructions']
        from .feed_event_hints import event_hints
        hints=await event_hints(self.db,instructions)
        phase=await self.model(task,job,'plan',selected,phase_messages('plan',instructions=instructions,today=today,hints=hints),[])
        if phase.get('state')=='succeeded':
            anchored=topics([f"{h['name'][:28]} {h['symbol']} {h['scheduledDate']} results investor relations"for h in hints[:2]])
            phase={**phase,'queries':topics(anchored+phase['queries'][:4])}
        if phase.get('state')=='succeeded':
            pages=[phase['pageId']];groups=[]
            for source in job['inputs']['targets']:
                result=await self.stage(task,job,'rss',source,{'params':{},'today':today},[phase['pageId']])
                if result.get('state')=='succeeded':groups.append(result['sources']);pages.append(result['pageId'])
            # Independent public-topic searches are bounded and individually admitted.
            for query in phase['queries']:
                native=[];fallback=[]
                for provider in ('deepseek-search','brave-search','google-news-rss'):
                    choices=[s for s in job['inputs'].get('searchTargets',[])if self.sources.target(job['owner_id'],s['id'])['provider']==provider]
                    if not choices:continue
                    result=await self.stage(task,job,'search',choices[0],{'params':{'query':query,'today':today}},[phase['pageId']])
                    if result.get('state')=='succeeded':
                        values=result['sources'];pages.append(result['pageId'])
                        if provider=='deepseek-search':native=values
                        elif provider=='brave-search'and values and not native:fallback=values;break
                        else:fallback=values
                groups.append(balance([native,fallback]))
            sources=balance(groups)
            if sources:
                # At most four distinct publisher origins, like the original
                # enrichment; only an explicitly installed matching target may read.
                origins=set();count=0
                for source in sources:
                    origin=urlsplit(source['url']).netloc
                    if origin in origins or count>=4:continue
                    origins.add(origin);matches=[]
                    for candidate in job['inputs'].get('articleTargets',[]):
                        try:
                            target=self.target(job,candidate)
                            spec=self.worker.transport.specification(target,{'url':source['url']})
                            if spec['url']==source['url']:matches.append(candidate)
                        except (ValueError,HTTPException):continue
                    if len(matches)!=1:continue
                    count+=1;result=await self.stage(task,job,'article',matches[0],{'params':{'url':source['url']}},pages)
                    if result.get('state')=='succeeded'and result.get('article'):
                        proof=result['article'];source.update(excerpt=proof['excerpt'],evidence='publisher-page',publishedAt=proof['publishedAt']or source.get('publishedAt'),media=proof.get('media')or source.get('media',[]));pages.append(result['pageId'])
                from .feed_news_contract import cut,units
                for source in sources:
                    excerpt=source.get('excerpt','')
                    if units(excerpt)>1000:source.update(excerpt=cut(excerpt,1000),excerptContextTruncated=True)
                edit=await self.model(task,job,'edit',selected,phase_messages('edit',instructions=instructions,today=today,sources=sources,hints=hints),pages,sources=sources)
                if edit.get('state')=='succeeded':
                    await self.model(task,job,'review',selected,phase_messages('review',instructions=instructions,today=today,sources=sources,drafts=edit['posts']),[*pages,edit['pageId']],sources=sources)
        return await self.finish(task,job)

    async def finish(self,task,job):
        from .worker import finish
        async with self.db.connection()as conn,conn.transaction():
            owned=await self.worker.lock(conn,task)
            if not owned:return False
            values=[r['result']for r in await(await conn.execute('SELECT result FROM feed_source_results WHERE owner_id=%s AND job_id=%s ORDER BY created_at,target_key',(job['owner_id'],job['id']))).fetchall()]
            published=[v for v in values if v.get('stage')=='review'and v.get('state')=='succeeded']
            completed_phases={v.get('stage')for v in values if v.get('state')=='succeeded'}
            recovered=[v for v in values if v.get('state')=='rejected'and v.get('stage')in {'plan','edit','review'}and v.get('stage')in completed_phases]
            state='cancelled'if owned['status']=='cancel_requested'else'succeeded'if published and all(v['state']=='succeeded'or v in recovered for v in values)else'partial'if published else'unknown'if any(v['state']=='unknown'for v in values)else'failed'
            result={'requestId':str(job['request_id']),'jobId':str(job['id']),'state':state,'sources':values,'pipeline':'Plan/retrieval/article/Edit/Review',
                'recoveredStageFailures':len(recovered),'instructionsApplied':bool(published),'added':sum(v.get('added',0)for v in published),'willRetryAutomatically':False}
            await conn.execute('UPDATE feed_source_jobs SET status=%s,result=%s,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s',(state,Jsonb(result),job['owner_id'],job['id']))
        return await finish(self.db,task,result,error_code=None if state in {'succeeded','partial','cancelled'}else'feed_job_'+state)
