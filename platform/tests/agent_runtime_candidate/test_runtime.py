"""Isolated Agent protocol proofs; transport is always controlled, never network IO."""
import base64
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi import HTTPException

from alcor_api.agent_runtime_service import AgentRuntime
from alcor_api.agent_runtime_worker import AgentRuntimeWorker
from alcor_api.worker import claim


def approval(settings, owner, host, path, purpose):
    return {'host':host,'port':443,'path':path,'addresses':['8.8.8.8'],
            'approvedAccess':True,'licenseRevision':'synthetic-license-1',
            'expiresAt':(datetime.now(UTC)+timedelta(days=1)).isoformat(),
            'ownerId':owner,'instanceId':str(settings.instance_id),purpose[0]:purpose[1]}


def model(settings, owner, *, key='SyntheticModelCredential9', custom=False):
    host='proxy.example.invalid' if custom else 'api.openai.com'
    return {'id':'custom' if custom else 'official','name':'Synthetic model',
            'provider':'custom' if custom else 'openai','apiUrl':'https://'+host+'/v1/chat/completions',
            'models':['synthetic-model'],'selectedModel':'synthetic-model','apiKey':key,
            'approval':approval(settings,owner,host,'/v1/chat/completions',('purpose','provider.model.test'))}


async def save_models(client, settings, owner, *, revision=0, key='SyntheticModelCredential9'):
    services=[model(settings,owner,key=key),model(settings,owner,custom=True)]
    actions={}
    for item in services:
        actions['modelServices.'+item['id']+'.apiKey']={'action':'set','value':item.pop('apiKey')}
    result=await client.post('/api/admin/private-runtime-settings',json={
        'requestId':str(uuid4()),'expectedRevision':revision,'group':'models',
        'patch':{'modelServices':services,'activeModelServiceId':'official'},
        'secretActions':actions,'password':'Synthetic9Pass'})
    assert result.status_code==200,result.text
    return result.json()


async def install(client, settings, owner):
    await save_models(client,settings,owner)
    cid=str(uuid4())
    result=await client.post('/api/agent-runtime/connections',json={
        'requestId':str(uuid4()),'connectionId':cid,'expectedRevision':0,'enabled':True,
        'values':{'name':'Synthetic Agent','url':'https://agent.example.invalid','agentInstanceId':'synthetic-agent',
                  'approval':approval(settings,owner,'agent.example.invalid','',('purposes',['agent.runtime']))},
        'tokenAction':{'action':'set','value':'SyntheticAgentCredential9'},'password':'Synthetic9Pass'})
    assert result.status_code==200,result.text
    return cid


def response(value,status=200):
    return {'raw':json.dumps(value).encode(),'status':status,'complete':True}


async def perform(client, db, cid, action, *, extra=None):
    raw={'requestId':str(uuid4()),'connectionId':cid,'connectionRevision':1,'action':action,**(extra or {})}
    submitted=await client.post('/api/agent-runtime/operations',json=raw)
    assert submitted.status_code==200,submitted.text
    task=await claim(db,uuid4())
    assert task and str(task['request_id'])==raw['requestId']
    await AgentRuntimeWorker(db).execute(task)
    receipt=await client.get('/api/agent-runtime/operations/'+raw['requestId'])
    assert receipt.status_code==200,receipt.text
    return raw,task,receipt.json()


async def probe(client, db, cid, monkeypatch):
    async def transport(target,method,path,payload,authorize):
        await authorize()
        assert method=='GET' and path=='/v1/capabilities' and payload is None
        return response({'version':1,'durableRuns':True,'instanceBinding':True,'instanceID':'synthetic-agent','shell':False,'financialAPI':False})
    monkeypatch.setattr('alcor_api.agent_runtime_worker.read',transport)
    _,_,result=await perform(client,db,cid,'probe')
    assert result['state']=='completed',result


def start():
    return {'modelServiceId':'official','confirmModelCredentialDelegation':True,
            'messages':[{'role':'system','content':'Synthetic controlled test'},{'role':'user','content':'Hello'}]}


async def test_official_endpoint_normalizes_after_exact_license_and_custom_never_inherits_adapter(client,admin,settings,db):
    await save_models(client,settings,admin)
    service=AgentRuntime(db)
    from types import SimpleNamespace
    who=SimpleNamespace(id=admin)
    async with db.connection() as conn:
        config,binding=await service.model(conn,who,'official')
        assert config['baseURL']=='https://api.openai.com/v1' and config['apiProtocol']=='chat'
        assert config['apiKey']=='SyntheticModelCredential9' and binding
        with pytest.raises(HTTPException) as rejected:
            await service.model(conn,who,'custom')
        assert rejected.value.status_code==422


@pytest.mark.parametrize('change',['credential','license'])
async def test_queued_model_change_cannot_send_original_credential(client,admin,settings,db,monkeypatch,change):
    cid=await install(client,settings,admin)
    await probe(client,db,cid,monkeypatch)
    raw={'requestId':str(uuid4()),'connectionId':cid,'connectionRevision':1,'action':'start',**start()}
    queued=await client.post('/api/agent-runtime/operations',json=raw)
    assert queued.status_code==200,queued.text
    if change=='credential':
        await save_models(client,settings,admin,revision=1,key='SyntheticReplacementCredential9')
    else:
        import alcor_api.private_runtime_settings as registry
        class ExpiredClock(datetime):
            @classmethod
            def now(cls,tz=None):
                return datetime.now(tz)+timedelta(days=2)
        monkeypatch.setattr(registry,'datetime',ExpiredClock)
    calls=[]
    async def never(*args,**kwargs):
        calls.append(True)
        raise AssertionError('a changed delegation must never reach transport')
    monkeypatch.setattr('alcor_api.agent_runtime_worker.read',never)
    task=await claim(db,uuid4());assert task
    await AgentRuntimeWorker(db).execute(task)
    result=(await client.get('/api/agent-runtime/operations/'+raw['requestId'])).json()
    assert result['state']=='unavailable' and not calls,result
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM agent_runtime_admissions WHERE job_id=(SELECT id FROM agent_runtime_jobs WHERE owner_id=%s AND request_id=%s)',(admin,raw['requestId']))).fetchone()


async def test_admitted_transport_unknown_is_durable_and_original_uuid_never_reissues(client,admin,settings,db,monkeypatch):
    cid=await install(client,settings,admin)
    await probe(client,db,cid,monkeypatch)
    calls=[]
    async def timeout(target,method,path,payload,authorize):
        await authorize();calls.append(path)
        raise TimeoutError('synthetic response loss after admission')
    monkeypatch.setattr('alcor_api.agent_runtime_worker.read',timeout)
    raw,task,result=await perform(client,db,cid,'start',extra=start())
    assert result['state']=='unknown' and len(calls)==1,result
    replay=await client.post('/api/agent-runtime/operations',json=raw)
    assert replay.status_code==200 and replay.json()==result
    await AgentRuntimeWorker(db).execute(task)
    assert len(calls)==1
    closed=await client.post('/api/agent-runtime/operations/'+raw['requestId']+'/close',json={})
    assert closed.status_code==200 and closed.json()['state']=='unknown'
    assert len(calls)==1


async def test_remote_200_requires_actual_run_or_vault_shape_and_running_is_not_finished(client,admin,settings,db,monkeypatch):
    cid=await install(client,settings,admin)
    await probe(client,db,cid,monkeypatch)
    mode={'value':'invalid'}
    async def transport(target,method,path,payload,authorize):
        await authorize()
        if mode['value']=='invalid':return response({'ok':True})
        if mode['value']=='run':return response({'id':payload['id'],'state':'running','revision':0,'text':'','tools':[]})
        return response({'revision':payload['expectedRevision']+1,'keyID':payload['keyID'],'ciphertext':payload['ciphertext']})
    monkeypatch.setattr('alcor_api.agent_runtime_worker.read',transport)
    _,_,bad_run=await perform(client,db,cid,'start',extra=start())
    assert bad_run['state']=='unknown'
    mode['value']='run'
    _,_,running=await perform(client,db,cid,'start',extra=start())
    assert running['state']=='completed' and running['result']['remoteRunState']=='running'
    assert running['result']['remoteExecutionComplete'] is False
    mode['value']='invalid'
    _,_,bad_vault=await perform(client,db,cid,'config-read')
    assert bad_vault['state']=='unknown'
    mode['value']='vault'
    _,_,vault=await perform(client,db,cid,'config-write',extra={
        'confirmConfigurationTransfer':True,'expectedRemoteRevision':0,'keyID':'a'*64,
        'ciphertext':base64.b64encode(b'synthetic-opaque-device-ciphertext-32bytes').decode()})
    assert vault['state']=='completed' and vault['result']['remote']['revision']==1
    async with db.connection() as conn:
        pages=await(await conn.execute('SELECT raw,sha256 FROM agent_runtime_pages WHERE owner_id=%s',(admin,))).fetchall()
    import hashlib
    assert len(pages)==5 and all(hashlib.sha256(bytes(page['raw'])).hexdigest()==page['sha256'] for page in pages)
