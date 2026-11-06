"""Explicit owner-bound delegation to an independently installed Agent instance."""
import json
from uuid import UUID, uuid4, uuid5

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .agent_runtime_protocol import ACTIONS, encoded, fingerprint, validate
from .connections import Vault
from .notification_security import NotificationSecurity
from .security import lock_mutation_identity


def uid(value):
    try:return str(UUID(str(value)))
    except (ValueError,TypeError):raise HTTPException(422,'原操作编号无效') from None


class AgentRuntime:
    def __init__(self,db):self.db=db

    def seal(self,kind,value):
        return Fernet(Vault(self.db.settings.connection_secret_dir).key()).encrypt(encoded({'instance':str(self.db.settings.instance_id),'kind':kind,'value':value})).decode()

    def open(self,kind,cipher):
        try:
            value=json.loads(Fernet(NotificationSecurity(self.db).existing_key()).decrypt(cipher.encode()))
            if value['instance']!=str(self.db.settings.instance_id) or value['kind']!=kind:raise ValueError()
            return value['value']
        except (InvalidToken,ValueError,TypeError,KeyError,UnicodeError,HTTPException):raise HTTPException(503,'Agent私有配置不可用，请在当前实例重新批准') from None

    async def lock(self,conn,who):
        await conn.execute('SELECT pg_advisory_xact_lock(67132005)')
        await conn.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',('identity-management:'+who.id,))
        await lock_mutation_identity(conn,who)

    async def connection(self,conn,owner,cid,*,active=False):
        row=await(await conn.execute('SELECT * FROM agent_runtime_connections WHERE owner_id=%s AND id=%s',(owner,cid))).fetchone()
        if not row:raise HTTPException(404,'本人的Agent连接不存在')
        if active and (not row['enabled'] or str(row['origin_instance'])!=str(self.db.settings.instance_id)):raise HTTPException(409,'Agent连接已停用或实例已恢复')
        value=self.open('agent-connection:'+str(row['id']),row['ciphertext'])
        if active:validate(value,owner,self.db.settings.instance_id)
        return row,value

    async def read(self,who):
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            rows=await(await conn.execute('SELECT * FROM agent_runtime_connections WHERE owner_id=%s ORDER BY created_at,id LIMIT 101',(who.id,))).fetchall();items=[]
            for row in rows[:100]:
                try:
                    value=self.open('agent-connection:'+str(row['id']),row['ciphertext']);view={k:v for k,v in value.items() if k!='token'};view['tokenState']='configured' if value.get('token') else 'unset';state='saved_not_connection_health'
                    if row['enabled']:
                        try:validate(value,who.id,self.db.settings.instance_id)
                        except HTTPException:state='unavailable_requires_reapproval'
                except HTTPException:view={};state='unavailable_requires_reapproval'
                items.append({'id':str(row['id']),'revision':row['revision'],'enabled':row['enabled'],'state':state,'values':view})
            operations=await(await conn.execute('SELECT * FROM agent_runtime_jobs WHERE owner_id=%s ORDER BY created_at DESC,id DESC LIMIT 20',(who.id,))).fetchall()
            return {'items':items,'recentOperations':[self.project(item) for item in operations],'partial':len(rows)>100,'iosConfigurationChanged':False,'automaticDelegation':False,'financialExecution':False}

    async def save(self,who,raw):
        if not isinstance(raw,dict) or set(raw)-{'requestId','connectionId','expectedRevision','enabled','values','tokenAction','password','code'}:raise HTTPException(422,'Agent连接请求无效')
        rid=uid(raw.get('requestId'));cid=uid(raw.get('connectionId'));expected=raw.get('expectedRevision');enabled=raw.get('enabled')
        if type(expected) is not int or expected<0 or type(enabled) is not bool:raise HTTPException(422,'Agent修订与启用状态无效')
        hashed=fingerprint({k:v for k,v in raw.items() if k not in ('password','code')})
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            prior=await(await conn.execute('SELECT fingerprint,result FROM agent_runtime_connection_operations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if prior:
                if prior['fingerprint'] not in ('closed',hashed):raise HTTPException(409,'原UUID内容不同')
                return prior['result']
            if await(await conn.execute('SELECT 1 FROM agent_runtime_jobs WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone():raise HTTPException(409,'原UUID已用于Agent委派，请查询原回执')
            await NotificationSecurity(self.db).passkeys.step_up(conn,who,raw.get('password'),raw.get('code',''))
            old=await(await conn.execute('SELECT * FROM agent_runtime_connections WHERE owner_id=%s AND id=%s FOR UPDATE',(who.id,cid))).fetchone()
            if expected!=(old['revision'] if old else 0):raise HTTPException(409,'Agent连接修订已变化')
            values=dict(raw.get('values',{}))
            if 'token' in values:raise HTTPException(422,'连接凭据须显式保留、替换或清除')
            action=raw.get('tokenAction',{'action':'keep'})
            if not isinstance(action,dict) or action.get('action') not in ('keep','set','clear') or set(action)-{'action','value'}:raise HTTPException(422,'凭据动作无效')
            old_values=self.open('agent-connection:'+cid,old['ciphertext']) if old and action['action']=='keep' else {}
            if action['action']=='keep':values['token']=old_values.get('token','')
            elif action['action']=='set':values['token']=action.get('value')
            else:values['token']=''
            if action['action']=='keep' and old_values and any(old_values.get(k)!=values.get(k) for k in ('url','approval','agentInstanceId')):raise HTTPException(422,'目标绑定变化须重新提供凭据或清除，不能转发旧密钥')
            if enabled:validate(values,who.id,self.db.settings.instance_id)
            elif set(values)-{'name','url','approval','agentInstanceId','token'}:raise HTTPException(422,'连接字段无效')
            revision=expected+1;cipher=self.seal('agent-connection:'+cid,values)
            await conn.execute('INSERT INTO agent_runtime_connections(owner_id,id,revision,ciphertext,origin_instance,enabled) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(owner_id,id) DO UPDATE SET revision=excluded.revision,ciphertext=excluded.ciphertext,origin_instance=excluded.origin_instance,enabled=excluded.enabled',(who.id,cid,revision,cipher,self.db.settings.instance_id,enabled))
            await conn.execute('INSERT INTO agent_runtime_connection_versions(owner_id,id,revision,ciphertext,enabled,request_id) VALUES(%s,%s,%s,%s,%s,%s)',(who.id,cid,revision,cipher,enabled,rid))
            result={'requestId':rid,'connectionId':cid,'revision':revision,'state':'completed','enabled':enabled,'iosConfigurationChanged':False}
            await conn.execute('INSERT INTO agent_runtime_connection_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,rid,hashed,Jsonb(result)))
            return result

    async def model(self,conn,who,service_id):
        from .private_runtime_settings import PrivateRuntimeSettings, validate_models
        _revision,raw=await PrivateRuntimeSettings(self.db).private_on_connection(conn)
        validate_models({'modelServices':raw.get('modelServices',[]),'activeModelServiceId':raw.get('activeModelServiceId','')},who,self.db.settings)
        matches=[item for item in raw.get('modelServices',[]) if item['id']==service_id]
        if len(matches)!=1:raise HTTPException(409,'请明确当前已批准模型服务')
        value=matches[0];base=value['apiUrl'].rstrip('/');model=value.get('selectedModel');key=value.get('apiKey')
        # These are the runtime's actual installed adapters, not arbitrary compatible endpoints.
        allowed={'deepseek':('https://api.deepseek.com','https://api.deepseek.com/v1'),'openai':('https://api.openai.com/v1',),'gemini':('https://generativelanguage.googleapis.com/v1beta/openai',),'openrouter':('https://openrouter.ai/api/v1',),'qwen':('https://dashscope.aliyuncs.com/compatible-mode/v1','https://dashscope-intl.aliyuncs.com/compatible-mode/v1','https://dashscope-us.aliyuncs.com/compatible-mode/v1','https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1')}
        # Registry validates the original endpoint and exact approval path
        # above. The independent runtime expects its official provider base,
        # whereas the same registry also permits a concrete chat endpoint.
        # Normalize only the exact official endpoint for this provider; never
        # trim an arbitrary custom URL into an approved-looking origin.
        for official in allowed.get(value['provider'],()):
            if base==official+'/chat/completions':
                base=official
                break
        if base not in allowed.get(value['provider'],()) or not key or not model:raise HTTPException(422,'此模型服务不在独立Agent实际适配范围')
        config={'baseURL':base,'model':model,'apiKey':key,'apiProtocol':'chat'}
        return config,fingerprint(config)

    async def submit(self,who,raw):
        allowed={'requestId','connectionId','connectionRevision','action','runId','modelServiceId','messages','threadId','confirmModelCredentialDelegation','expectedRemoteRevision','ciphertext','keyID','confirmConfigurationTransfer'}
        if not isinstance(raw,dict) or set(raw)-allowed or raw.get('action') not in ACTIONS:raise HTTPException(422,'Agent动作无效')
        rid=uid(raw.get('requestId'));cid=uid(raw.get('connectionId'));hashed=fingerprint(raw);action=raw['action']
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            prior=await(await conn.execute('SELECT * FROM agent_runtime_jobs WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if prior:
                if prior['fingerprint']!=hashed:raise HTTPException(409,'原UUID已用于其他委派')
                return self.project(prior)
            reserved=await(await conn.execute('SELECT result FROM agent_runtime_connection_operations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if reserved:
                if reserved['result'].get('state')=='closed':return reserved['result']
                raise HTTPException(409,'原UUID已用于连接配置，请只查询原回执')
            row,target=await self.connection(conn,who.id,cid,active=True)
            if type(raw.get('connectionRevision')) is not int or row['revision']!=raw['connectionRevision']:raise HTTPException(409,'Agent配置已变化')
            if action!='probe':
                if not target.get('agentInstanceId'):raise HTTPException(409,'请先探测并明确绑定独立Agent实例')
                probe=await(await conn.execute("SELECT result FROM agent_runtime_jobs WHERE owner_id=%s AND connection_id=%s AND connection_revision=%s AND action='probe' AND status='completed' ORDER BY created_at DESC LIMIT 1",(who.id,cid,row['revision']))).fetchone()
                if not probe or probe['result'].get('remote',{}).get('instanceID')!=target['agentInstanceId']:raise HTTPException(409,'当前连接修订须有明确核验的Agent能力探测')
            inputs={k:v for k,v in raw.items() if k not in ('requestId','connectionId','connectionRevision')}
            if action in ('start','continue'):
                if raw.get('confirmModelCredentialDelegation') is not True:raise HTTPException(428,'须明确允许把选定模型凭据发送给此Agent')
                _config,binding=await self.model(conn,who,raw.get('modelServiceId'));inputs['modelBinding']=binding
            if action=='start':
                messages=raw.get('messages')
                if not isinstance(messages,list) or not 2<=len(messages)<=64 or any(not isinstance(m,dict) or set(m)!={'role','content'} or m['role'] not in ('system','user','assistant') or not isinstance(m['content'],str) for m in messages) or len(encoded(messages))>262144:raise HTTPException(422,'请明确提供本次对话内容，不自动复制客户端聊天')
                run_id=str(uuid5(UUID(rid),'agent-run'));remote='alcor-'+fingerprint([str(self.db.settings.instance_id),who.id,cid,run_id])[:48]
                await conn.execute('INSERT INTO agent_runtime_runs(owner_id,id,connection_id,agent_instance,remote_id,model_binding,model_service,start_request_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(who.id,run_id,cid,target['agentInstanceId'],remote,inputs['modelBinding'],raw['modelServiceId'],rid));inputs['runId']=run_id;inputs['remoteId']=remote
                inputs['remoteThread']='alcor-'+fingerprint([str(self.db.settings.instance_id),who.id,cid,raw.get('threadId') or run_id])[:48]
            elif action in ('query','continue','stop'):
                run=await(await conn.execute('SELECT * FROM agent_runtime_runs WHERE owner_id=%s AND id=%s AND connection_id=%s',(who.id,uid(raw.get('runId')),cid))).fetchone()
                if not run or run['agent_instance']!=target['agentInstanceId']:raise HTTPException(409,'本人原Agent任务或实例不匹配')
                if action=='continue' and (run['model_binding']!=inputs['modelBinding'] or run['model_service']!=raw.get('modelServiceId') or type(raw.get('expectedRemoteRevision')) is not int or raw['expectedRemoteRevision']<0):raise HTTPException(409,'延续须保留原模型绑定和远端修订')
                inputs['remoteId']=run['remote_id']
            elif action=='config-write':
                import re
                if raw.get('confirmConfigurationTransfer') is not True or type(raw.get('expectedRemoteRevision')) is not int or raw['expectedRemoteRevision']<0 or not isinstance(raw.get('keyID'),str) or not re.fullmatch('[a-f0-9]{64}',raw['keyID']) or not isinstance(raw.get('ciphertext'),str) or not 40<=len(raw['ciphertext'])<=180000:raise HTTPException(422,'仅允许显式同步设备加密的配置包与远端CAS')
            session=await(await conn.execute("SELECT s.client_id,u.session_version FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.user_id=%s AND s.token_hash=%s AND s.client_id='new-web' AND s.expires_at>clock_timestamp() AND s.session_version=u.session_version",(who.id,who.token_hash))).fetchone()
            if not session:raise HTTPException(403,'委派需要本人当前Web会话')
            count=await(await conn.execute("SELECT count(*) AS n FROM tasks WHERE owner_id=%s AND status IN ('queued','running','cancel_requested')",(who.id,))).fetchone()
            if count['n']>=100:raise HTTPException(429,'本人待处理任务过多')
            job,task=uuid4(),uuid4();subject={'sessionHash':who.token_hash,'sessionVersion':session['session_version'],'instanceId':str(self.db.settings.instance_id)}
            await conn.execute("INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,%s,'agent.runtime','queued',%s)",(task,who.id,rid,hashed,Jsonb({'agentJobId':str(job)})))
            result=await(await conn.execute('INSERT INTO agent_runtime_jobs(owner_id,id,request_id,task_id,connection_id,connection_revision,action,subject,ciphertext,fingerprint) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *',(who.id,job,rid,task,cid,row['revision'],action,Jsonb(subject),self.seal('agent-job:'+str(job),inputs),hashed))).fetchone()
            await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'queued')",(task,))
            return self.project(result)

    def project(self,row):return {'requestId':str(row['request_id']),'taskId':str(row['task_id']),'connectionId':str(row['connection_id']),'state':row['status'],'action':row['action'],'result':row['result'],'runId':str(uuid5(UUID(str(row['request_id'])),'agent-run')) if row['action']=='start' else None,'automaticRetry':False,'iosConfigurationChanged':False}

    async def operation(self,who,rid):
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            row=await(await conn.execute('SELECT * FROM agent_runtime_jobs WHERE owner_id=%s AND request_id=%s',(who.id,uid(rid)))).fetchone()
            if row:return self.project(row)
            config=await(await conn.execute('SELECT result FROM agent_runtime_connection_operations WHERE owner_id=%s AND request_id=%s',(who.id,uid(rid)))).fetchone()
            if config:return config['result']
            raise HTTPException(404,'本人原UUID尚无回执')


    async def close(self,who,rid):
        rid=uid(rid)
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            saved=await(await conn.execute('SELECT result FROM agent_runtime_connection_operations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if saved:return saved['result']
            job=await(await conn.execute('SELECT * FROM agent_runtime_jobs WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if job:
                if job['result']:return self.project(job)
                await conn.execute('SELECT id FROM tasks WHERE id=%s FOR UPDATE',(job['task_id'],))
                if await(await conn.execute('SELECT 1 FROM agent_runtime_admissions WHERE owner_id=%s AND job_id=%s',(who.id,job['id']))).fetchone():return {**self.project(job),'state':'unknown','automaticRetry':False,'closureEffect':'cannot_assert_remote_not_executed'}
                result={'requestId':rid,'state':'closed','executed':False}
                await conn.execute("UPDATE tasks SET status='cancelled',finished_at=clock_timestamp(),lease_until=NULL WHERE id=%s",(job['task_id'],))
                await conn.execute("UPDATE agent_runtime_jobs SET status='closed',result=%s WHERE owner_id=%s AND id=%s",(Jsonb(result),who.id,job['id']))
                return result
            result={'requestId':rid,'state':'closed','executed':False}
            await conn.execute('INSERT INTO agent_runtime_connection_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,rid,'closed',Jsonb(result)))
            return result

    async def original(self,who,page_id,password,code=''):
        async with self.db.connection() as conn,conn.transaction():
            await self.lock(conn,who)
            await NotificationSecurity(self.db).passkeys.step_up(conn,who,password,code)
            page=await(await conn.execute('SELECT raw,sha256,complete,status FROM agent_runtime_pages WHERE owner_id=%s AND id=%s',(who.id,uid(page_id)))).fetchone()
            if not page:raise HTTPException(404,'本人Agent原件不存在')
            return {'raw':bytes(page['raw']),'sha256':page['sha256'],'complete':page['complete'],'remoteStatus':page['status']}
