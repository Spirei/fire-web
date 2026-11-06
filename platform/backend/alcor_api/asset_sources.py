"""Durable, explicitly licensed public catalogue source requests."""

import hashlib
import json
from uuid import UUID, uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .security import lock_mutation_identity

ACTIONS={'search','add','sync','backfill','check-delisted','cleanup'}


def fingerprint(value):return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,default=str,separators=(',',':')).encode()).hexdigest()


class AssetSources:
    def __init__(self,db):self.db=db

    def target(self,owner,target_id,action,*,member=False):
        if target_id=='local-catalogue' and action in ('cleanup','sync') and not member:
            return {'id':target_id,'provider':'local-catalogue','ownerId':owner,'instanceId':str(self.db.settings.instance_id),'publicDisplay':True,'licenseRevision':'local-reference-graph-v1','actions':['cleanup','sync'],'syncModes':['icons']}
        from .asset_source_protocol import validate_target
        configured=[row for row in self.db.settings.asset_source_targets if row.get('id')==target_id]
        if len(configured)!=1:raise HTTPException(503,'素材来源尚未明确安装')
        raw=configured[0]
        try:
            allowed_member=member and action in ('search','add') and raw.get('memberAdd') is True
            value=validate_target(raw,owner_id=raw.get('ownerId') if allowed_member else owner,instance_id=str(self.db.settings.instance_id))
            value=raw if value is None else value
            if value.get('publicDisplay') is not True:raise ValueError('source_not_public')
            actions=value.get('actions')
            purpose={'search':'asset.icon' if value['provider']=='companiesmarketcap' else 'asset.search','add':'asset.icon','sync':'asset.list','backfill':'asset.list','check-delisted':'asset.delisting'}[action]
            supported={'search':{'coingecko','companiesmarketcap'},'add':{'coingecko','companiesmarketcap','tradingview','webull','parqet'},'sync':{'eastmoney','companiesmarketcap'},'backfill':{'eastmoney','companiesmarketcap'},'check-delisted':{'eastmoney'}}
            if value['provider'] not in supported[action]:raise ValueError('provider_action_not_installed')
            if actions is not None and action not in actions or purpose not in value.get('purposes',[]):raise ValueError('action_not_licensed')
            if member and not allowed_member:raise ValueError('member_add_not_licensed')
            return value
        except (ValueError,TypeError,KeyError):raise HTTPException(503,'素材来源、公开展示或动作许可不可用') from None

    def installed(self,owner,action,*,member=False):
        found=[]
        for configured in self.db.settings.asset_source_targets:
            try:found.append(self.target(owner,configured.get('id'),action,member=member))
            except HTTPException:continue
        return found

    def default_target(self,owner,action,selection,options,*,member=False):
        if action=='cleanup' or action=='sync' and options.get('mode')=='icons':return 'local-catalogue'
        choices=self.installed(owner,action,member=member)
        preferred=('eastmoney','companiesmarketcap') if action in ('sync','backfill','check-delisted') else ('coingecko',) if selection.get('type')=='crypto' else ('companiesmarketcap',) if selection.get('type')=='metal' else ('tradingview','webull','parqet')
        for provider in preferred:
            matching=[row for row in choices if row['provider']==provider]
            if len(matching)>1:raise HTTPException(409,'同一来源有多个当前许可目标，请明确选择')
            if matching:return matching[0]['id']
        raise HTTPException(503,'来源尚未明确安装')

    def list_graph(self,owner,action,selection,options,primary):
        markets=[selection['market']] if selection.get('market') else ['US','HK','CN','JP','KR']
        if any(market not in ('US','HK','CN','JP','KR') for market in markets):raise HTTPException(400,'同步市场无效')
        ids=options.get('listTargetIds')
        if ids is not None and (not isinstance(ids,list) or len(ids)>6 or any(not isinstance(key,str) for key in ids) or len(ids)!=len(set(ids))):raise HTTPException(400,'清单来源选择无效')
        available=self.installed(owner,action)
        graph=[];missing=[]
        for market in markets:
            provider='eastmoney' if market in ('US','HK','CN') else 'companiesmarketcap'
            choices=[row for row in available if row['provider']==provider and (ids is None or row['id'] in ids or row['id']==primary['id'])]
            if primary['provider']==provider:chosen=primary
            elif len(choices)==1:chosen=choices[0]
            elif len(choices)>1:raise HTTPException(409,'此市场有多个当前来源，请明确listTargetIds')
            else:missing.append(market);continue
            graph.append({'market':market,'id':chosen['id'],'fingerprint':fingerprint(chosen)})
        return graph,missing

    async def lock(self,conn,who,*,member=False):
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+who.id,))
        await lock_mutation_identity(conn,who,require_admin=not member)

    async def targets(self,who):
        member=who.role!='admin'
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who,member=member)
            values=[]
            for configured in self.db.settings.asset_source_targets:
                allowed=[];current=None
                for action in sorted(ACTIONS-{'cleanup'}):
                    try:current=self.target(who.id,configured.get('id'),action,member=member);allowed.append(action)
                    except HTTPException:continue
                if current:values.append({key:current[key] for key in ('id','provider','licenseRevision','expiresAt') if key in current}|{'actions':allowed,'memberAdd':current.get('memberAdd') is True})
            if not member:values.append({'id':'local-catalogue','provider':'local-catalogue','licenseRevision':'local-reference-graph-v1','actions':['cleanup','sync'],'syncModes':['icons']})
            return {'targets':values,'state':'available' if values else 'unavailable','collectionOnRead':False}

    async def project(self,conn,row):
        task=await(await conn.execute('SELECT status,error_code FROM tasks WHERE id=%s',(row['task_id'],))).fetchone()
        pages=await(await conn.execute('SELECT id,raw_sha256,http_status,complete FROM asset_source_pages WHERE owner_id=%s AND job_id=%s ORDER BY received_at,id LIMIT 120',(row['owner_id'],row['id']))).fetchall()
        return {'requestId':str(row['request_id']),'jobId':str(row['id']),'taskId':str(row['task_id']),'action':row['action'],'expectedRevision':row['expected_revision'],
                'state':row['result'].get('state','unknown') if row['result'] else 'unknown' if task['error_code'] else task['status'],'result':row['result'],
                'sourcePages':[{'id':str(page['id']),'sha256':page['raw_sha256'],'httpStatus':page['http_status'],'complete':page['complete'],'originalPath':'/api/asset-sources/originals/'+str(page['id'])} for page in pages],
                'errorCode':task['error_code'],'willRetryAutomatically':False,'createdAt':row['created_at'].isoformat()}

    async def search(self,who,raw):
        if not isinstance(raw,dict):raise HTTPException(400,'素材搜索字段无效')
        if set(raw)<={'requestId','targetId','type','query','expectedRevision'}:
            raw={key:value for key,value in raw.items() if key not in ('type','query')}|{'selection':{'type':raw.get('type','stock'),'q':raw.get('query','')},'options':{}}
        return await self._create(who,{**raw,'action':'search'},search=True)

    async def submit(self,who,raw):return await self._create(who,raw)

    async def submit_legacy(self,who,raw,input_hash):return await self._create(who,raw,legacy_hash=input_hash)

    async def _create(self,who,raw,search=False,*,legacy_hash=None):
        if not isinstance(raw,dict) or set(raw)-{'requestId','action','expectedRevision','targetId','selection','options'} or not {'requestId','action','targetId'}<=set(raw) or raw['action'] not in ACTIONS:raise HTTPException(400,'素材来源请求字段无效')
        try:rid=str(UUID(raw['requestId']))
        except (ValueError,TypeError,AttributeError):raise HTTPException(400,'原请求UUID无效') from None
        selection=raw.get('selection',{});options=raw.get('options',{})
        if not isinstance(selection,dict) or not isinstance(options,dict) or len(json.dumps([selection,options],default=str).encode())>65536:raise HTTPException(400,'来源范围过大或无效')
        member=who.role!='admin';action=raw['action']
        if raw['targetId']=='local-catalogue' and action=='sync' and options.get('mode')!='icons':raise HTTPException(400,'本地目录同步仅用于补缺失图标')
        if member and (action not in ('search','add') or action=='add' and options.get('onlyIfMissing') is not True):raise HTTPException(403,'普通成员仅可为本人记录补缺失素材')
        hashed=fingerprint(raw) if legacy_hash is None else fingerprint(['legacy-source',legacy_hash])
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who,member=member)
            prior=await(await conn.execute('SELECT * FROM asset_source_jobs WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if prior:
                if prior['request_hash']!=hashed:raise HTTPException(409,'原UUID已用于不同来源操作')
                return await self.project(conn,prior)
            target_id=raw['targetId'] or self.default_target(who.id,action,selection,options,member=member)
            target=self.target(who.id,target_id,action,member=member)
            icon_ids=options.get('iconTargetIds')
            if icon_ids is None:
                icon_ids=[]
                if action in ('sync','add'):
                    available=self.installed(who.id,'add',member=member)
                    for provider in ('tradingview','webull','parqet'):
                        choices=[row for row in available if row['provider']==provider]
                        if len(choices)>1:raise HTTPException(409,'图标来源有多个当前目标，请明确iconTargetIds')
                        if choices:icon_ids.append(choices[0]['id'])
            if not isinstance(icon_ids,list) or len(icon_ids)>6 or any(not isinstance(value,str) for value in icon_ids) or len(set(icon_ids))!=len(icon_ids):raise HTTPException(400,'图标来源许可列表无效')
            icon_targets=[{'id':key,'fingerprint':fingerprint(self.target(who.id,key,'add',member=member))} for key in icon_ids]
            current=(await(await conn.execute('SELECT revision FROM asset_catalog_scope')).fetchone())['revision']
            expected=raw.get('expectedRevision',current if search else None)
            if type(expected) is not int or expected!=current:raise HTTPException(409,'公共素材目录已变化，请重新读取')
            if action=='add' and 'candidateRequestId' in selection:
                try:search_id=UUID(selection['candidateRequestId']);index=selection['candidateIndex']
                except (ValueError,TypeError,KeyError):raise HTTPException(400,'搜索候选标识无效') from None
                source=await(await conn.execute("SELECT * FROM asset_source_jobs WHERE owner_id=%s AND request_id=%s AND action='search'",(who.id,search_id))).fetchone()
                candidates=source['result'].get('candidates',[]) if source and source['result'] and source['result'].get('state')=='completed' else []
                if type(index) is not int or not 0<=index<len(candidates) or source['target_id']!=target['id'] or source['target_fingerprint']!=fingerprint(target):raise HTTPException(409,'搜索候选尚未确认或许可已变化')
                selection={**candidates[index],'candidateRequestId':str(search_id),'candidateIndex':index}
            if action=='add' and member:
                if selection.get('type','stock')!='stock':raise HTTPException(403,'成员仅可补本人证券图标')
                record=await(await conn.execute('SELECT id FROM portfolio_records WHERE owner_id=%s AND market=%s AND code=%s AND deleted_at IS NULL LIMIT 1',(who.id,selection.get('market'),selection.get('code')))).fetchone()
                if not record:raise HTTPException(403,'此公开证券不是本人的当前记录')
            if action in ('check-delisted','cleanup'):
                phase=options.get('phase','plan')
                if phase not in ('plan','execute'):raise HTTPException(400,'清理阶段无效')
                if phase=='execute':
                    if options.get('confirm') is not True:raise HTTPException(400,'须明确确认原清理计划')
                    try:plan_id=UUID(options['planRequestId'])
                    except (ValueError,TypeError,KeyError):raise HTTPException(400,'需要原计划UUID') from None
                    plan=await(await conn.execute('SELECT * FROM asset_source_jobs WHERE owner_id=%s AND request_id=%s AND action=%s',(who.id,plan_id,action))).fetchone()
                    if not plan or not plan['result'] or plan['result'].get('state')!='completed' or plan['result'].get('phase')!='plan' or plan['expected_revision']!=current or plan['target_id']!=target['id'] or plan['target_fingerprint']!=fingerprint(target):raise HTTPException(409,'清理计划缺失或目录已变化')
                    selection={'plannedCandidates':plan['result'].get('candidates',[]),'planRequestId':str(plan_id)}
            session=await(await conn.execute('SELECT s.client_id,u.session_version FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.user_id=%s AND s.token_hash=%s AND s.client_id=ANY(%s) AND s.expires_at>clock_timestamp() AND s.session_version=u.session_version',(who.id,who.token_hash,['new-web','legacy-web']))).fetchone()
            if not session:raise HTTPException(403,'来源操作需要本人有效Web会话')
            pending=await(await conn.execute("SELECT count(*) AS n FROM tasks WHERE owner_id=%s AND status IN ('queued','running','cancel_requested')",(who.id,))).fetchone()
            if pending['n']>=100:raise HTTPException(429,'待处理来源任务过多')
            jid,tid=uuid4(),uuid4()
            subject={'sessionHash':who.token_hash,'sessionClient':session['client_id'],'sessionVersion':session['session_version'],'instanceId':str(self.db.settings.instance_id),'member':member}
            graph,missing=self.list_graph(who.id,action,selection,options,target) if action in ('sync','backfill') and options.get('mode')!='icons' else ([],[])
            inputs={'selection':selection,'options':options,'iconTargets':icon_targets,'listTargets':graph,'missingMarkets':missing}
            await conn.execute("INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,%s,'asset.source','queued',%s)",(tid,who.id,rid,hashed,Jsonb({'assetSourceJobId':str(jid)})))
            row=await(await conn.execute('INSERT INTO asset_source_jobs(owner_id,id,request_id,task_id,action,expected_revision,target_id,target_fingerprint,subject,inputs,request_hash) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *',(who.id,jid,rid,tid,action,expected,target['id'],fingerprint(target),Jsonb(subject),Jsonb(inputs),hashed))).fetchone()
            await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'queued')",(tid,))
            return await self.project(conn,row)

    async def operation(self,who,rid):
        try:rid=UUID(str(rid))
        except (ValueError,TypeError):raise HTTPException(400,'请求UUID无效') from None
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who,member=who.role!='admin')
            row=await(await conn.execute('SELECT * FROM asset_source_jobs WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if not row:raise HTTPException(404,'来源回执尚未找到')
            return await self.project(conn,row)

    async def original(self,who,pageid):
        try:pageid=UUID(str(pageid))
        except (ValueError,TypeError):raise HTTPException(400,'原页UUID无效') from None
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who,member=who.role!='admin')
            row=await(await conn.execute('SELECT * FROM asset_source_pages WHERE owner_id=%s AND id=%s',(who.id,pageid))).fetchone()
            if not row:raise HTTPException(404,'来源原件不存在')
            raw=bytes(row['raw'])
            if hashlib.sha256(raw).hexdigest()!=row['raw_sha256']:raise HTTPException(503,'来源原件校验失败')
            return row,raw

    async def status(self,who):
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who,member=who.role!='admin')
            current=(await(await conn.execute('SELECT revision FROM asset_catalog_scope')).fetchone())['revision']
            rows=await(await conn.execute('SELECT * FROM asset_source_jobs WHERE owner_id=%s ORDER BY created_at DESC,id DESC LIMIT 21',(who.id,))).fetchall()
            return {'revision':current,'jobs':[await self.project(conn,row) for row in rows[:20]],'partial':len(rows)>20,'collectionOnRead':False}

    async def public_status(self):
        status={'running':False,'total':0,'done':0,'current':'','error':'','lastSyncAt':''}
        async with self.db.connection() as conn:
            row=await(await conn.execute('SELECT revision FROM asset_catalog_scope')).fetchone()
            jobs=await(await conn.execute("SELECT j.*,t.status AS task_status,t.finished_at FROM asset_source_jobs j JOIN tasks t ON t.id=j.task_id JOIN users u ON u.id=j.owner_id WHERE j.action='sync' AND u.active AND u.deleted_at IS NULL AND u.role='admin' ORDER BY j.created_at DESC,j.id DESC LIMIT 100")).fetchall()
            for job in jobs:
                try:
                    target=self.target(job['owner_id'],job['target_id'],'sync')
                    if job['target_fingerprint']!=fingerprint(target):continue
                except HTTPException:continue
                outcome=job['result'] or {}
                running=job['task_status'] in ('queued','running','cancel_requested')
                status={'running':running,'total':None if running else outcome.get('appliedCount',0),
                        'done':None if running else outcome.get('appliedCount',0),'current':'同步排队中' if job['task_status']=='queued' else '来源采集中' if running else '',
                        'error':'' if running or outcome.get('state')=='completed' else '同步结果暂不可验证',
                        'lastSyncAt':job['finished_at'].isoformat() if job['finished_at'] and outcome.get('state')=='completed' else ''}
                break
        return {'revision':row['revision'],'state':'stored_public_catalogue','collectionOnRead':False,'workerState':'running' if status['running'] else 'idle','status':status}

    async def public_search(self,raw):
        from .asset_source_protocol import metal_candidates
        if not isinstance(raw,dict):raise HTTPException(400,'搜索参数无效')
        kind=raw.get('type','crypto');query=raw.get('query',raw.get('q',''))
        if not isinstance(query,str) or not 1<=len(query)<=50 or kind not in ('stock','crypto','metal'):raise HTTPException(400,'搜索类型或文字无效')
        if kind=='metal':return {'candidates':metal_candidates(query),'state':'observed','collectionOnRead':False,'source':'registered_metal_identifiers'}
        found=[]
        async with self.db.connection() as conn,conn.transaction():
            for configured in self.db.settings.asset_source_targets:
                try:target=self.target(configured.get('ownerId'),configured.get('id'),'search')
                except HTTPException:continue
                active=await(await conn.execute('SELECT 1 FROM users WHERE id=%s AND active AND deleted_at IS NULL',(configured.get('ownerId'),))).fetchone()
                if not active:continue
                rows=await(await conn.execute("SELECT id,owner_id,result FROM asset_source_jobs WHERE target_id=%s AND target_fingerprint=%s AND action='search' AND inputs->'selection'->>'q'=%s AND result->>'state'='completed' ORDER BY created_at DESC,id DESC LIMIT 1",(target['id'],fingerprint(target),query))).fetchall()
                for row in rows:
                    from .asset_source_evidence import source_page
                    try:
                        candidates=[]
                        for page_id in row['result'].get('sourcePageIds',[]):
                            _page,parsed,_target=await source_page(conn,self.db,row['owner_id'],UUID(page_id),job_id=row['id'])
                            candidates.extend(parsed.get('candidates',[]))
                        if not row['result'].get('sourcePageIds') or fingerprint(candidates)!=fingerprint(row['result'].get('candidates',[])):
                            continue
                        found.extend(value for value in candidates if value.get('type')==kind)
                    except (HTTPException,ValueError,TypeError,KeyError):continue
        unique={ (row.get('type'),row.get('market'),row.get('code')):row for row in found }
        return {'candidates':list(unique.values())[:8],'state':'observed' if found else 'unavailable','collectionOnRead':False,'source':'retained_current_licensed_observations'}
