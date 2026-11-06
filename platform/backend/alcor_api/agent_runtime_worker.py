"""Durable at-most-once Agent admissions; raw responses precede projection."""
import hashlib
import json
from types import SimpleNamespace
from uuid import uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .agent_runtime_protocol import fingerprint, read
from .agent_runtime_service import AgentRuntime
from .feed_worker import FeedWorker
from .worker import finish, owned_row


class AgentRuntimeWorker:
    def __init__(self,db):self.db=db;self.service=AgentRuntime(db)

    async def active(self,conn,job,task):
        owned=await owned_row(conn,task)
        if not owned or owned['status']!='running':raise HTTPException(409,'Agent任务执行租约已失效或撤销')
        subject=job['subject']
        if subject['instanceId']!=str(self.db.settings.instance_id):raise HTTPException(409,'平台实例已恢复，委派已失效')
        from .fx_reference import external_delivery_blocked
        if await external_delivery_blocked(conn):raise HTTPException(409,'恢复实例未重新批准外发')
        row=await(await conn.execute("SELECT u.id,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=%s AND u.active AND u.deleted_at IS NULL AND u.role='admin' AND s.token_hash=%s AND s.client_id='new-web' AND s.session_version=u.session_version AND s.expires_at>clock_timestamp() AND u.session_version=%s FOR SHARE OF u,s",(job['owner_id'],subject['sessionHash'],subject['sessionVersion']))).fetchone()
        if not row:raise HTTPException(403,'原委派当前会话或权限已撤回')
        who=SimpleNamespace(id=job['owner_id'],role='admin',token_hash=subject['sessionHash'])
        connection,target=await self.service.connection(conn,who.id,job['connection_id'],active=True)
        if connection['revision']!=job['connection_revision']:raise HTTPException(409,'Agent目标或凭据已换代')
        return who,target

    async def model_current(self,conn,who,action,inputs,body):
        if action in ('start','continue'):
            config,binding=await self.service.model(conn,who,inputs['modelServiceId'])
            if binding!=inputs['modelBinding'] or fingerprint(config)!=fingerprint(body['configuration']):
                raise HTTPException(409,'选定模型许可或凭据已变化，已停止发送')

    async def execute(self,task):
        async with self.db.connection() as conn:
            job=await(await conn.execute('SELECT * FROM agent_runtime_jobs WHERE owner_id=%s AND task_id=%s',(task['owner_id'],task['id']))).fetchone()
        if not job:return await finish(self.db,task,{'state':'unavailable'},error_code='agent_job_missing')
        if job['result']:return await finish(self.db,task,job['result'],error_code=None if job['status']=='completed' else 'agent_'+job['status'])
        async with self.db.connection() as conn:
            existing=await(await conn.execute('SELECT 1 FROM agent_runtime_admissions WHERE owner_id=%s AND job_id=%s',(job['owner_id'],job['id']))).fetchone()
        admitted=bool(existing);page_id=None;response=None;secrets=[]
        try:
            async with self.db.connection() as conn,conn.transaction():
                who,target=await self.active(conn,job,task)
                prior=await(await conn.execute('SELECT 1 FROM agent_runtime_admissions WHERE owner_id=%s AND job_id=%s',(job['owner_id'],job['id']))).fetchone()
                if prior:
                    admitted=True
                    raise HTTPException(409,'原请求已入场，未知结果不得重新外发')
                inputs=self.service.open('agent-job:'+str(job['id']),job['ciphertext']);action=job['action'];body=None
                namespace=fingerprint(['alcor-platform-vault',str(self.db.settings.instance_id),who.id,str(job['connection_id'])])
                if action=='probe':method,path='GET','/v1/capabilities'
                elif action=='start':
                    config,binding=await self.service.model(conn,who,inputs['modelServiceId'])
                    if binding!=inputs['modelBinding']:raise HTTPException(409,'选定模型或凭据已变化')
                    method,path='POST','/v1/runs';body={'id':inputs['remoteId'],'threadID':inputs['remoteThread'],'configuration':config,'messages':inputs['messages'],'tools':[],'attachments':[],'requiredDocumentTool':False};secrets.append(config['apiKey'])
                elif action in ('query','stop','continue'):
                    path='/v1/runs/'+inputs['remoteId'];method='GET'
                    if action=='stop':method='POST';path+='/stop'
                    elif action=='continue':
                        config,binding=await self.service.model(conn,who,inputs['modelServiceId'])
                        if binding!=inputs['modelBinding']:raise HTTPException(409,'原模型绑定已变化')
                        method='POST';path+='/advance';body={'configuration':config,'results':{},'continueRun':True,'revision':inputs['expectedRemoteRevision']};secrets.append(config['apiKey'])
                else:
                    path='/v1/config/vaults/'+namespace;method='GET'
                    if action=='config-write':method='PUT';body={'requestID':str(job['request_id']),'expectedRevision':inputs['expectedRemoteRevision'],'keyID':inputs['keyID'],'ciphertext':inputs['ciphertext']}
                secrets.append(target['token'])
                await conn.execute('INSERT INTO agent_runtime_admissions(owner_id,job_id,request_id,connection_revision) VALUES(%s,%s,%s,%s)',(who.id,job['id'],job['request_id'],job['connection_revision']))
                await conn.execute("UPDATE agent_runtime_jobs SET status='admitted' WHERE owner_id=%s AND id=%s",(who.id,job['id']))
            admitted=True
            async def perform():
                async with self.db.connection() as conn,conn.transaction():
                    _who,current=await self.active(conn,job,task)
                    if fingerprint(current)!=fingerprint(target):raise HTTPException(409,'Agent目标已变化')
                    async def authorize():
                        current_who,current_target=await self.active(conn,job,task)
                        if fingerprint(current_target)!=fingerprint(target):raise HTTPException(409,'Agent目标已变化')
                        await self.model_current(conn,current_who,action,inputs,body)
                    return await read(current,method,path,body,authorize)
            response=await FeedWorker(self.db).pulse(task,perform)
            page_id=uuid4()
            async with self.db.connection() as conn,conn.transaction():
                await conn.execute('INSERT INTO agent_runtime_pages(owner_id,id,job_id,status,raw,complete,sha256) VALUES(%s,%s,%s,%s,%s,%s,%s)',(job['owner_id'],page_id,job['id'],response['status'],response['raw'],response['complete'],hashlib.sha256(response['raw']).hexdigest()))
            if action=='config-read' and response['complete'] and response['status']==404:
                # A missing remote vault is a known absence, not a synchronized
                # configuration or an unknown write. Its exact body is archived.
                raise HTTPException(404,'远端当前命名空间未登记配置')
            if not response['complete'] or response['status']!=200:raise ValueError('agent_response_unavailable')
            from .fx_provider_parser import unique
            remote=json.loads(response['raw'],object_pairs_hook=unique,parse_constant=lambda value:(_ for _ in ()).throw(ValueError(value)))
            if not isinstance(remote,dict):raise TypeError('agent_response_shape')
            if action=='probe' and (remote.get('version')!=1 or remote.get('durableRuns') is not True or remote.get('instanceBinding') is not True or remote.get('shell') is not False or remote.get('financialAPI') is not False or not isinstance(remote.get('instanceID'),str) or target.get('agentInstanceId') and remote['instanceID']!=target['agentInstanceId']):raise ValueError('agent_capability_binding')
            if action in ('start','query','stop','continue'):
                if (remote.get('id')!=inputs['remoteId'] or remote.get('state') not in ('running','needs_tools','interrupted','failed','complete')
                    or type(remote.get('revision')) is not int or remote['revision']<0
                    or not isinstance(remote.get('text'),str) or not isinstance(remote.get('tools'),list)):
                    raise ValueError('agent_run_snapshot_invalid')
                if action=='continue' and remote['revision']<=inputs['expectedRemoteRevision']:
                    raise ValueError('agent_advance_revision_invalid')
            elif action in ('config-read','config-write'):
                import base64
                import re
                if (type(remote.get('revision')) is not int or remote['revision']<1
                    or not isinstance(remote.get('keyID'),str) or not re.fullmatch('[a-f0-9]{64}',remote['keyID'])
                    or not isinstance(remote.get('ciphertext'),str)):
                    raise ValueError('agent_vault_snapshot_invalid')
                sealed=base64.b64decode(remote['ciphertext'],validate=True)
                if not 29<=len(sealed)<=128*1024:raise ValueError('agent_vault_ciphertext_invalid')
                if action=='config-write' and (remote['revision']!=inputs['expectedRemoteRevision']+1
                    or remote['keyID']!=inputs['keyID'] or remote['ciphertext']!=inputs['ciphertext']):
                    raise ValueError('agent_vault_write_receipt_mismatch')
            def redact(value):
                if isinstance(value,str):
                    for secret in secrets:
                        if secret:value=value.replace(secret,'[redacted]')
                    return value
                if isinstance(value,list):return [redact(item) for item in value]
                if isinstance(value,dict):return {key:redact(item) for key,item in value.items() if key.lower() not in ('apikey','authorization','token','configuration')}
                return value
            output={'state':'completed','remote':redact(remote),'sourcePageId':str(page_id),'automaticRetry':False,'deviceToolsExecuted':False,'financialExecution':False,'iosConfigurationChanged':False}
            if action=='start':output['runId']=inputs['runId']
            if action in ('start','query','stop','continue'):
                output['remoteRunState']=remote['state']
                output['remoteExecutionComplete']=remote['state']=='complete'
                output['operationAuthority']='observed_remote_snapshot_not_implicit_model_completion'
            async with self.db.connection() as conn,conn.transaction():
                current_who,_current_target=await self.active(conn,job,task)
                await self.model_current(conn,current_who,action,inputs,body)
        except HTTPException as exc:
            output={'state':'unavailable' if job['action']=='config-read' and exc.status_code==404 and page_id else 'unknown' if admitted else 'unavailable','reason':str(exc.detail),'sourcePageId':str(page_id) if page_id else None,'automaticRetry':False}
        except Exception:  # noqa: BLE001 - an admitted transport failure is unknown, never replayed
            output={'state':'unknown' if admitted else 'unavailable','reason':'agent_response_not_confirmed','sourcePageId':str(page_id) if page_id else None,'automaticRetry':False}
        if job['action']=='start':
            from uuid import UUID, uuid5
            output['runId']=str(uuid5(UUID(str(job['request_id'])),'agent-run'))
        async with self.db.connection() as conn,conn.transaction():
            await conn.execute('UPDATE agent_runtime_jobs SET status=%s,result=%s WHERE owner_id=%s AND id=%s AND result IS NULL',(output['state'],Jsonb(output),job['owner_id'],job['id']))
        return await finish(self.db,task,output,error_code=None if output['state']=='completed' else 'agent_'+output['state'])
