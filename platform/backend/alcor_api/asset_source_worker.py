"""Leased asset collection: durable admission before every individual provider request."""

import copy
import hashlib
from contextlib import asynccontextmanager
from dataclasses import asdict
from types import SimpleNamespace
from uuid import uuid4, uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .asset_catalog_management import AssetManagement
from .asset_lookup_catalog import AssetCatalog
from .asset_source_protocol import ICON_LIMIT, LIMIT, parse, plan
from .asset_source_transport import Transport
from .asset_sources import AssetSources, fingerprint
from .feed_worker import FeedWorker
from .market_worker import Bound
from .system_assets import SystemAssets
from .worker import finish, owned_row


class UnknownOutcome(ValueError):pass


class MemberCatalog(AssetCatalog):
    """Only used after the worker's locked owner-record and empty-icon checks."""
    @asynccontextmanager
    async def context(self,who=None,write=False,*,connection=None):
        async with self.connection(connection) as conn,conn.transaction():
            from .security import lock_mutation_identity
            await lock_mutation_identity(conn,who,require_admin=False)
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('asset-lookup-catalog',0))")
            yield conn


class AssetSourceWorker:
    def __init__(self,db):
        self.db=db;self.sources=AssetSources(db);self.transport=Transport();self.pulse=FeedWorker(db).pulse

    async def active(self,conn,job):
        subject=job['subject'];member=subject['member']
        if subject['instanceId']!=str(self.db.settings.instance_id):raise HTTPException(409,'恢复实例已换代')
        from .fx_reference import external_delivery_blocked
        if job['target_id']!='local-catalogue' and await external_delivery_blocked(conn):raise HTTPException(409,'恢复实例尚未批准外部素材采集')
        actor=await(await conn.execute("SELECT u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=%s AND u.active AND u.deleted_at IS NULL AND s.token_hash=%s AND s.client_id=%s AND s.session_version=u.session_version AND u.session_version=%s AND s.expires_at>clock_timestamp()",(job['owner_id'],subject['sessionHash'],subject['sessionClient'],subject['sessionVersion']))).fetchone()
        if not actor or not member and actor['role']!='admin':raise HTTPException(403,'来源授权会话已变化')
        target=self.sources.target(job['owner_id'],job['target_id'],job['action'],member=member)
        if fingerprint(target)!=job['target_fingerprint']:raise HTTPException(409,'来源许可配置已变化')
        return target

    def who(self,job):
        return SimpleNamespace(id=job['owner_id'],token_hash=job['subject']['sessionHash'],role='user' if job['subject']['member'] else 'admin',legacy_client=job['subject']['sessionClient']=='legacy-web',legacy_platform=False)

    async def lock(self,conn,task):
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+task['owner_id'],))
        owned=await owned_row(conn,task)
        if not owned or owned['status']=='cancel_requested':raise UnknownOutcome('lease_lost_or_cancel_requested')

    async def page(self,task,job,target,request,key):
        target=copy.deepcopy(target)
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,task);await self.active(conn,job)
            current=(await(await conn.execute('SELECT revision FROM asset_catalog_scope')).fetchone())['revision']
            if current!=job['expected_revision']:raise HTTPException(409,'目录已变化，不能继续原来源请求')
            from .fx_reference import external_delivery_blocked
            if await external_delivery_blocked(conn):raise HTTPException(409,'恢复实例尚未批准外部素材采集')
            if target['id']!=job['target_id']:
                choices=list({(value['id'],value['fingerprint']):value for value in [*job['inputs'].get('iconTargets',[]),*job['inputs'].get('listTargets',[])] if value['id']==target['id']}.values())
                current=self.sources.target(job['owner_id'],target['id'],'add' if request.purpose=='asset.icon' else job['action'],member=job['subject']['member'])
                if len(choices)!=1 or choices[0]['fingerprint']!=fingerprint(current) or fingerprint(current)!=fingerprint(target):raise HTTPException(409,'图标来源许可已变化')
            prior=await(await conn.execute('SELECT * FROM asset_source_pages WHERE owner_id=%s AND job_id=%s AND request_key=%s',(job['owner_id'],job['id'],key))).fetchone()
            if prior:return self.checked(prior)
            admitted=await(await conn.execute('SELECT 1 FROM asset_source_admissions WHERE owner_id=%s AND job_id=%s AND request_key=%s',(job['owner_id'],job['id'],key))).fetchone()
            if admitted:raise UnknownOutcome('admitted_request_outcome_unconfirmed')
            count=await(await conn.execute('SELECT count(*) AS n FROM asset_source_admissions WHERE owner_id=%s AND job_id=%s',(job['owner_id'],job['id']))).fetchone()
            if count['n']>=120:raise HTTPException(409,'本任务来源页预算已达上限')
            await conn.execute('INSERT INTO asset_source_admissions(owner_id,job_id,request_key,request,target_fingerprint,license_revision) VALUES(%s,%s,%s,%s,%s,%s)',(job['owner_id'],job['id'],key,Jsonb(asdict(request)),fingerprint(target),target['licenseRevision']))
        try:response=await self.pulse(task,lambda:self.transport.read(target,request))
        except Exception as exc:raise UnknownOutcome('admitted_request_outcome_unconfirmed') from exc
        async with self.db.connection() as conn,conn.transaction():
            instance=await(await conn.execute('SELECT instance_id FROM alcor_instance WHERE singleton')).fetchone()
            original=await(await conn.execute('SELECT * FROM asset_source_jobs WHERE owner_id=%s AND id=%s',(job['owner_id'],job['id']))).fetchone()
            admitted=await(await conn.execute('SELECT * FROM asset_source_admissions WHERE owner_id=%s AND job_id=%s AND request_key=%s',(job['owner_id'],job['id'],key))).fetchone()
            if (not instance or str(instance['instance_id'])!=job['subject']['instanceId'] or str(self.db.settings.instance_id)!=job['subject']['instanceId']
                    or not original or original['task_id']!=task['id'] or original['subject']!=job['subject'] or original['target_fingerprint']!=job['target_fingerprint']
                    or not admitted or admitted['request']!=asdict(request) or admitted['target_fingerprint']!=fingerprint(target) or admitted['license_revision']!=target['licenseRevision']):
                raise HTTPException(409,'素材响应原任务、许可或实例绑定已变化')
            budget=ICON_LIMIT if request.representation=='image_http_response_body' else LIMIT
            complete=bool(response.complete and len(response.raw)<=budget and response.url==request.url and response.representation==request.representation)
            retained=bytes(response.raw[:budget])
            row=await(await conn.execute('INSERT INTO asset_source_pages(owner_id,id,job_id,request_key,raw,raw_sha256,http_status,complete,representation) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING RETURNING *',(job['owner_id'],uuid4(),job['id'],key,retained,hashlib.sha256(retained).hexdigest(),response.status,complete,response.representation))).fetchone()
            if row is None:
                row=await(await conn.execute('SELECT * FROM asset_source_pages WHERE owner_id=%s AND job_id=%s AND request_key=%s',(job['owner_id'],job['id'],key))).fetchone()
                if (bytes(row['raw']),row['http_status'],row['complete'],row['representation'])!=(retained,response.status,complete,response.representation):raise UnknownOutcome('original_response_conflict')
        return self.checked(row)

    def checked(self,row):
        if not row['complete'] or hashlib.sha256(bytes(row['raw'])).hexdigest()!=row['raw_sha256']:raise UnknownOutcome('source_page_incomplete_or_corrupt')
        if row['http_status']!=200:raise HTTPException(502,'来源未返回完整成功观察，保留原页且不自动重试')
        return row

    async def cleanup_plan(self,conn,selection):
        from .asset_reference_graph import cleanup_candidates
        return (await cleanup_candidates(conn,selection))['candidates']

    async def image_fallback(self,task,job,targets,item,pages):
        for target in targets:
            try:
                image=await self.images(task,job,target,item,{},pages)
                if image:return image
            except UnknownOutcome:raise
            except (HTTPException,ValueError,TypeError,KeyError):continue
        return None

    async def images(self,task,job,target,item,parsed,pages):
        requests=parsed.get('iconRequests',[])
        if not requests and item.get('iconUrl'):
            requests=[plan(target,'icon',item,{'stage':'image','url':item['iconUrl']})]
        if not requests and target['provider'] in ('tradingview','webull','parqet'):
            requests=[plan(target,'icon',item)]
        for index,request in enumerate(requests[:8]):
            page=await self.page(task,job,target,request,'icon:'+fingerprint(asdict(request)))
            pages.append(str(page['id']))
            decoded=parse(bytes(page['raw']),request)
            if request.representation=='image_http_response_body':return page,bytes(page['raw']),request
            for follow in decoded.get('iconRequests',[])[:4]:
                image=await self.page(task,job,target,follow,'image:'+fingerprint(asdict(follow)))
                pages.append(str(image['id']))
                if follow.representation=='image_http_response_body':return image,bytes(image['raw']),follow
        return None

    async def execute(self,task):
        async with self.db.connection() as conn:
            job=await(await conn.execute('SELECT * FROM asset_source_jobs WHERE owner_id=%s AND task_id=%s',(task['owner_id'],task['id']))).fetchone()
        if not job:return await finish(self.db,task,{'state':'unknown'},error_code='asset_source_job_missing')
        if job['result']:return await finish(self.db,task,job['result'],error_code=None if job['result']['state']=='completed' else 'asset_source_'+job['result']['state'])
        pages=[];coverage=[];items=[];images={};metadata_pages={};check_candidates=[];next_asset=None;image_missing=[];image_remaining=0;local_icon_total=None
        try:
            async with self.db.connection() as conn,conn.transaction():
                await self.lock(conn,task);target=await self.active(conn,job)
            selection=job['inputs']['selection'];options=job['inputs']['options'];action=job['action']
            if action=='add' and selection.get('type') in ('crypto','metal') and not selection.get('candidateRequestId'):
                if selection['type']=='metal':
                    from .asset_source_protocol import metal_candidates
                    candidates=metal_candidates(selection.get('code',''))
                else:
                    lookup=plan(target,'search',{'q':selection.get('code','')})
                    observed=await self.page(task,job,target,lookup,'inline-add-search')
                    pages.append(str(observed['id']));candidates=parse(bytes(observed['raw']),lookup).get('candidates',[])
                matching=[value for value in candidates if value.get('code')==selection.get('code')]
                if len(matching)!=1:raise HTTPException(409,'此代码尚无唯一已观察候选')
                supplied_url=selection.get('imageUrl',selection.get('iconUrl'))
                if supplied_url is not None and supplied_url!=matching[0].get('iconUrl'):raise HTTPException(409,'图片URL与实际来源候选不一致')
                selection={**matching[0],'candidateRequestId':'inline_source_observation'}
            if action=='sync' and options.get('mode')=='icons':
                async with self.db.connection() as conn:
                    where="type='stock' AND light_version IS NULL AND (%s::text IS NULL OR market=%s) AND (%s::text IS NULL OR id>%s) AND NOT EXISTS(SELECT 1 FROM asset_catalog_tombstones t WHERE t.asset_id=asset_catalog_entries.id AND t.restored_at IS NULL)"
                    args=(selection.get('market'),selection.get('market'),options.get('afterAssetId'),options.get('afterAssetId'))
                    local_icon_total=(await(await conn.execute('SELECT count(*) n FROM asset_catalog_entries WHERE '+where,args)).fetchone())['n']
                    registered=await(await conn.execute('SELECT type,market,code,name FROM asset_catalog_entries WHERE '+where+' ORDER BY id LIMIT 41',args)).fetchall()
                items=[dict(row) for row in registered];cursor=None
                coverage.append({'scope':'registered_catalogue_missing_icons','externalListCollection':False,'missingImages':local_icon_total})
            elif action=='search' and selection.get('type')=='metal':
                from .asset_source_protocol import metal_candidates
                items=metal_candidates(selection.get('q',''));cursor=None
                coverage.append({'authority':'registered_metal_identifiers','externalCollection':False})
            elif action in ('sync','backfill'):
                cursor=None
                for missing in job['inputs'].get('missingMarkets',[]):coverage.append({'market':missing,'state':'unavailable','reason':'licensed_source_not_installed','partial':True})
                for chosen in job['inputs'].get('listTargets',[]):
                    market_items=[];market_pages={};market_coverage=[]
                    try:
                        source=self.sources.target(job['owner_id'],chosen['id'],action)
                        if fingerprint(source)!=chosen['fingerprint']:raise HTTPException(409,'市场来源许可已变化')
                        next_page=options.get('cursor')
                        while True:
                            request=plan(source,'list',{'market':chosen['market']},options,next_page)
                            observed=await self.page(task,job,source,request,'source:'+fingerprint(asdict(request)))
                            pages.append(str(observed['id']));parsed=parse(bytes(observed['raw']),request)
                            market_coverage.append({'market':chosen['market'],'targetId':chosen['id'],'state':'observed',**parsed.get('coverage',{})})
                            market_items.extend(parsed.get('items',[]))
                            if source['provider']=='companiesmarketcap' and len(market_items)>=300:
                                market_items=market_items[:300]
                                market_coverage[-1].update(selectionLimit=300,selectionLimitReached=True,wholeMarketKnown=False,partial=False)
                            for item in parsed.get('items',[]):market_pages[fingerprint(item)]=observed
                            if len(items)+len(market_items)>2000:raise HTTPException(409,'本任务目录条目预算已达上限')
                            next_page=parsed.get('nextCursor')
                            if next_page is None or source['provider']=='companiesmarketcap' and len(market_items)>=300:break
                        items.extend(market_items);metadata_pages.update(market_pages);coverage.extend(market_coverage)
                    except UnknownOutcome:raise
                    except (HTTPException,ValueError,TypeError,KeyError):
                        coverage.append({'market':chosen['market'],'targetId':chosen['id'],'state':'unavailable','reason':'source_observation_unavailable','partial':True})
            elif action=='add' and selection.get('type','stock')=='stock':
                choices=[target]
                for chosen in job['inputs'].get('iconTargets',[]):
                    source=self.sources.target(job['owner_id'],chosen['id'],'add',member=job['subject']['member'])
                    if fingerprint(source)!=chosen['fingerprint']:raise HTTPException(409,'图标来源许可已变化')
                    if source['id'] not in {value['id'] for value in choices}:choices.append(source)
                items=[{key:selection[key] for key in ('type','market','code','name') if key in selection}]
                if 'type' not in items[0]:items[0]['type']='stock'
                images[fingerprint(items[0])]=await self.image_fallback(task,job,choices,items[0],pages)
                cursor=None
            elif action=='cleanup' or action=='check-delisted' and options.get('phase')=='execute':pass
            elif action=='check-delisted':
                async with self.db.connection() as conn:
                    if selection.get('code'):
                        checks=await(await conn.execute("SELECT id,type,market,code,name FROM asset_catalog_entries WHERE type='stock' AND market=%s AND code=%s AND NOT EXISTS(SELECT 1 FROM asset_catalog_tombstones t WHERE t.asset_id=asset_catalog_entries.id AND t.restored_at IS NULL)",(selection.get('market'),selection['code']))).fetchall()
                    else:
                        checks=await(await conn.execute("SELECT id,type,market,code,name FROM asset_catalog_entries WHERE type='stock' AND market IN ('US','HK','CN') AND (%s::text IS NULL OR market=%s) AND NOT EXISTS(SELECT 1 FROM asset_catalog_tombstones t WHERE t.asset_id=asset_catalog_entries.id AND t.restored_at IS NULL) AND (%s::text IS NULL OR id>%s) ORDER BY id LIMIT 41",(selection.get('market'),selection.get('market'),options.get('afterAssetId'),options.get('afterAssetId')))).fetchall()
                if len(checks)>40:next_asset=checks[39]['id']
                for security in checks[:40]:
                    from .asset_source_evidence import creation_origin
                    async with self.db.connection() as conn:
                        origin=await creation_origin(conn,security)
                    if origin['source']!='auto' or not origin['sourceKnown']:
                        check_candidates.append({'id':security['id'],'eligible':False,'evidence':'manual_or_unknown_creation_not_auto_retirement','source':origin['source'],'sourcePageIds':[],'securityDelistedKnown':False})
                        continue
                    observations=[];evidence=[]
                    for observation in (1,2):
                        request=plan(target,'check-delisted',dict(security))
                        page=await self.page(task,job,target,request,'security:'+security['id']+':'+str(observation))
                        pages.append(str(page['id']));evidence.append(str(page['id']));decoded=parse(bytes(page['raw']),request)
                        observations.append(decoded.get('missingEvidence'))
                    known=len(observations)==2 and all(isinstance(value,dict) and value.get('providerResponseMissing') is True for value in observations)
                    check_candidates.append({'id':security['id'],'eligible':known,'evidence':'provider_missing_twice_not_exchange_delisting','securityDelistedKnown':False,'observations':observations,'sourcePageIds':evidence})
            else:
                cursor=options.get('cursor');decoded={}
                while True:
                    source_options={**options}
                    if action=='add' and selection.get('candidateRequestId') and selection.get('iconUrl'):source_options.update(stage='image',url=selection['iconUrl'])
                    request=plan(target,'list' if action=='backfill' else action,selection,source_options,cursor)
                    page=await self.page(task,job,target,request,'source:'+fingerprint(asdict(request)))
                    pages.append(str(page['id']));decoded=parse(bytes(page['raw']),request);coverage.append(decoded.get('coverage',{}))
                    items.extend(decoded.get('items',[]))
                    for observed_item in decoded.get('items',[]):metadata_pages[fingerprint(observed_item)]=page
                    if action=='add' and not items:items=[{key:selection[key] for key in ('type','market','code','name') if key in selection}]
                    if action=='add':
                        for item in items[:1]:
                            images[fingerprint(item)]=(page,bytes(page['raw']),request) if request.representation=='image_http_response_body' else await self.images(task,job,target,item,decoded,pages)
                    cursor=decoded.get('nextCursor')
                    if cursor is None or action in ('search','add'):break
                    if len(items)>2000:raise HTTPException(409,'本任务目录条目预算已达上限')
            if action=='sync':
                icon_selections=job['inputs'].get('iconTargets',[])
                identities=[('stock:'+item['market']+':'+item['code']) if item['type']=='stock' else item['type']+':'+item['code'] for item in items]
                async with self.db.connection() as conn:
                    existing=await(await conn.execute('SELECT id,light_version FROM asset_catalog_entries WHERE id=ANY(%s)',(identities,))).fetchall()
                present={row['id'] for row in existing if row['light_version'] is not None}
                eligible=[item for item,aid in zip(items,identities,strict=True) if aid not in present]
                image_remaining=max(0,(local_icon_total if local_icon_total is not None else len(eligible))-40)
                for item in eligible[:40]:
                    for selected in icon_selections:
                        icon_target=self.sources.target(job['owner_id'],selected['id'],'add',member=job['subject']['member'])
                        if fingerprint(icon_target)!=selected['fingerprint']:raise HTTPException(409,'图标来源许可已变化')
                        image=await self.image_fallback(task,job,[icon_target],item,pages)
                        if image:images[fingerprint(item)]=image;break
                    if not images.get(fingerprint(item)):image_missing.append({'market':item['market'],'code':item['code'],'reason':'licensed_icon_observation_unavailable'})
                coverage.append({'imagePartial':bool(image_remaining or image_missing),'imageEligibleItems':local_icon_total if local_icon_total is not None else len(eligible),'imageProcessedItems':min(40,len(eligible)),'imageRemainingItems':image_remaining,'nextImageSecurities':[{'type':item['type'],'market':item['market'],'code':item['code']} for item in eligible[40:80]],'continuation':'submit_new_uuid_with_current_revision_icons_mode'})
            async with self.db.connection() as conn,conn.transaction():
                await self.lock(conn,task);await self.active(conn,job)
                await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('asset-lookup-catalog',0))")
                current=(await(await conn.execute('SELECT revision FROM asset_catalog_scope FOR UPDATE')).fetchone())['revision']
                if current!=job['expected_revision']:raise HTTPException(409,'目录已变化，原采集不能覆盖新修订')
                for selected in job['inputs'].get('iconTargets',[]):
                    icon_target=self.sources.target(job['owner_id'],selected['id'],'add',member=job['subject']['member'])
                    if fingerprint(icon_target)!=selected['fingerprint']:raise HTTPException(409,'图标来源许可已变化')
                who=self.who(job);catalog=MemberCatalog(Bound(conn,self.db.settings)) if job['subject']['member'] else AssetCatalog(Bound(conn,self.db.settings));management=AssetManagement(catalog)
                outcomes=[]
                if action in ('cleanup','check-delisted'):
                    if options.get('phase','plan')=='execute':
                        candidates=selection['plannedCandidates']
                        if action=='cleanup':
                            rechecked=await self.cleanup_plan(conn,{'ids':[row['id'] for row in candidates]})
                            if fingerprint(rechecked)!=fingerprint(candidates):raise HTTPException(409,'目录引用图已变化，请重做计划')
                        for candidate in candidates:
                            if candidate.get('eligible') is not True:continue
                            if action=='check-delisted':
                                from .asset_source_evidence import creation_origin, source_page
                                current_asset=await(await conn.execute('SELECT * FROM asset_catalog_entries WHERE id=%s',(candidate['id'],))).fetchone()
                                if not current_asset or (await creation_origin(conn,current_asset))['source']!='auto':raise HTTPException(409,'自动创建来源已无法证实')
                                plan_job=await(await conn.execute('SELECT id FROM asset_source_jobs WHERE owner_id=%s AND request_id=%s',(who.id,selection['planRequestId']))).fetchone()
                                ids=candidate.get('sourcePageIds',[])
                                if not plan_job or len(ids)!=2 or len(set(ids))!=2:raise HTTPException(409,'退市检查须两次独立原件')
                                for index,pid in enumerate(ids,1):
                                    proof,parsed,_target=await source_page(conn,self.db,who.id,pid,job_id=plan_job['id'])
                                    missing=parsed.get('missingEvidence')
                                    if proof['request_key']!='security:'+candidate['id']+':'+str(index) or not missing or missing.get('providerResponseMissing') is not True:
                                        raise HTTPException(409,'原提供方缺失观察已无法核实')
                            child=uuid5(job['request_id'],'asset-delete:'+candidate['id'])
                            result=await management.delete(who,child,current,candidate['id'],connection=conn);current=result['revision'];outcomes.append(result)
                        output={'state':'completed','phase':'execute','operations':outcomes,'filesDeleted':False,'revision':current,'sourcePageIds':pages}
                    else:
                        if action=='cleanup':
                            if 'ids' not in selection:
                                registered=await(await conn.execute('SELECT id FROM asset_catalog_entries e WHERE (%s::text IS NULL OR id>%s) AND NOT EXISTS(SELECT 1 FROM asset_catalog_tombstones t WHERE t.asset_id=e.id AND t.restored_at IS NULL) ORDER BY id LIMIT 201',(options.get('afterAssetId'),options.get('afterAssetId')))).fetchall()
                                if len(registered)>200:next_asset=registered[199]['id']
                                selection={'ids':[row['id'] for row in registered[:200]]}
                            candidates=await self.cleanup_plan(conn,selection) if selection['ids'] else []
                        else:candidates=check_candidates
                        output={'state':'completed','phase':'plan','candidates':candidates,'filesWillBeDeleted':False,'revision':current,'sourcePageIds':pages,'coverage':{'partial':next_asset is not None,'nextAssetId':next_asset}}
                elif action=='search':output={'state':'completed','candidates':items,'coverage':coverage,'nextCursor':cursor,'sourcePageIds':pages,'revision':current}
                else:
                    for index,item in enumerate(items):
                        kind=item.get('type','stock');market=item.get('market','');code=item.get('code');name=item.get('name') or code
                        aid=('stock:'+market+':'+code) if kind=='stock' else kind+':'+code
                        old=await(await conn.execute('SELECT * FROM asset_catalog_entries WHERE id=%s FOR UPDATE',(aid,))).fetchone()
                        if action=='backfill' and old is None:
                            outcomes.append({'id':aid,'state':'not_registered_no_backfill'});continue
                        member=job['subject']['member'];only_missing=member or options.get('onlyIfMissing') is True
                        if member and (kind!='stock' or not await(await conn.execute('SELECT id FROM portfolio_records WHERE owner_id=%s AND market=%s AND code=%s AND deleted_at IS NULL FOR SHARE',(who.id,market,code))).fetchone()):raise HTTPException(403,'此证券已不属于本人当前记录')
                        if only_missing and old and old['light_version']:outcomes.append({'id':aid,'state':'already_present'});continue
                        update={'id':aid,'type':kind,'market':market,'code':code,'name':old['name'] if old and (member or options.get('mode')=='icons' or action=='backfill') else code if member else name}
                        image=images.get(fingerprint(item))
                        if image is None and (member or options.get('mode')=='icons' or action=='add'):
                            image_missing.append({'market':market,'code':code,'reason':'verified_image_unavailable'});outcomes.append({'id':aid,'state':'image_unavailable'});continue
                        if image:
                            page,raw,request=image
                            mime=raw[:12]
                            ext='png' if mime.startswith(b'\x89PNG') else 'jpg' if mime.startswith(b'\xff\xd8') else 'gif' if mime.startswith(b'GIF') else 'webp' if mime.startswith(b'RIFF') else 'svg'
                            fields={'kind':'asset','folder':kind,'name':name,'code':code,'market':market}
                            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('system-public-assets',0))")
                            asset=await SystemAssets(Bound(conn,self.db.settings)).apply(conn,who.id,fields,code+'.'+ext,raw)
                            await conn.execute("UPDATE system_asset_scope SET revision=revision+1 WHERE namespace='system_public'")
                            update['imageVersion']=asset['version']
                        child=uuid5(job['request_id'],'asset-write:'+str(index)+':'+aid)
                        from .asset_source_evidence import creation_origin
                        origin=({'source':'auto' if action=='sync' or only_missing else 'manual'} if old is None else await creation_origin(conn,old))
                        catalog.publication_origin=origin['source']
                        result=await management.write(who,child,current,update,connection=conn);current=result['revision']
                        outcomes.append({**result,'creationOrigin':origin['source'] if old is None else 'preserved'})
                        if action in ('sync','backfill') and fingerprint(item) in metadata_pages:
                            from .asset_source_metadata import project as project_metadata
                            from .asset_source_metadata import save as save_metadata
                            await save_metadata(conn,self.db,job,aid,item,metadata_pages[fingerprint(item)],child)
                            outcomes[-1]={**outcomes[-1],'observedMetadata':await project_metadata(conn,self.db,aid)}
                    output={'state':'partial' if image_missing or image_remaining or any(value.get('partial') or value.get('state')=='unavailable' for value in coverage) else 'completed','imageMissing':image_missing,'operations':outcomes,'appliedCount':sum('requestId' in outcome for outcome in outcomes),'processedCount':len(items),'revision':current,'coverage':coverage,'sourcePageIds':pages,'financialWrites':False}
                await conn.execute('UPDATE asset_source_jobs SET result=%s WHERE owner_id=%s AND id=%s AND result IS NULL',(Jsonb(output),job['owner_id'],job['id']))
        except UnknownOutcome as exc:output={'state':'unknown','reason':str(exc),'sourcePageIds':pages,'willRetryAutomatically':False}
        except HTTPException as exc:output={'state':'unavailable','reason':str(exc.detail),'httpStatus':exc.status_code,'sourcePageIds':pages,'willRetryAutomatically':False}
        except (ValueError,TypeError,KeyError,IndexError):output={'state':'unavailable','reason':'source_observation_or_catalogue_identity_invalid','sourcePageIds':pages,'willRetryAutomatically':False}
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('UPDATE asset_source_jobs SET result=%s WHERE owner_id=%s AND id=%s AND result IS NULL',(Jsonb(output),job['owner_id'],job['id']))
        return await finish(self.db,task,output,error_code=None if output['state']=='completed' else 'asset_source_'+output['state'])
