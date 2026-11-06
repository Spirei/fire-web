"""Actual encrypted capsule restores alias/byte/UUID history but not a live host action."""
# ruff: noqa: F811 -- existing isolated backup fixtures injected by pytest names
from uuid import UUID, uuid4

import httpx
from alcor_api.main import create_app
from test_backups import backup_app, bc, configured, create_capsule, execute, submit  # noqa: F401
from f28_media_candidate.test_clipboard import png
from test_financial_reports import RAW
from test_financial_reports import upload as report_upload
from f28_media_candidate.test_upload import gif


async def test_restore_retains_private_alias_avatar_original_uuid_and_only_historical_host_effect(bc,backup_app,configured,monkeypatch):
    login=await bc.post('/api/auth/login',json={'username':'BackupQA','password':'Synthetic9Pass'})
    assert login.status_code==200,login.text
    uploaded=await bc.post('/api/upload',data={'requestId':str(uuid4())},files={'file':('synthetic.gif',gif(),'image/gif')})
    assert uploaded.status_code==200,uploaded.text
    assert (await bc.post('/api/upload',files={'file':('new.gif',gif('green'),'image/gif')})).status_code==200
    report=await report_upload(bc)
    assert report.status_code==201,report.text
    alias=await bc.post('/api/media-aliases',json={'requestId':str(uuid4()),'expectedRevision':0,'scope':'admin','legacyPath':'/uploads/reports/kept.pdf','targetKind':'report','targetId':report.json()['report']['id']})
    assert alias.status_code==200,alias.text
    service=backup_app.state.local_host_clipboard
    monkeypatch.setattr(service,'installed',lambda who:True)
    calls=[]
    class Process:
        returncode=0
        async def communicate(self):return b'ok',b''
    async def spawn(*args,**kwargs):calls.append(1);return Process()
    import asyncio
    original_spawn=asyncio.create_subprocess_exec
    monkeypatch.setattr('alcor_api.local_host_clipboard.asyncio.create_subprocess_exec',spawn)
    rid=str(uuid4())
    copied=await bc.post('/api/clipboard',json={'requestId':rid,'image':png()})
    assert copied.status_code==200 and copied.json()['ok'] is True,copied.text
    monkeypatch.setattr('alcor_api.local_host_clipboard.asyncio.create_subprocess_exec',original_spawn)
    backup,_=await create_capsule(bc,backup_app,configured)
    preview=await bc.get('/api/backups/'+backup+'/restore-preview',params={'target_id':'isolated-qa'})
    assert preview.status_code==200,preview.text
    job,_=await submit(bc,'backup.restore',backup_id=backup,target_id='isolated-qa',restore_ticket=preview.json()['restore_ticket'])
    await execute(backup_app,configured,UUID(job['id']))
    target=configured.restore_targets[0]
    settings=configured.model_copy(update={'database_url':target.database_url,'instance_id':target.instance_id,'file_root':target.recovery_directory/'files','connection_secret_dir':target.recovery_directory/'connection-secrets','restore_targets':[]})
    app=create_app(settings)
    async with app.router.lifespan_context(app),httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as recovered:
        login=await recovered.post('/api/session/login',json={'login':'BackupQA','password':'Synthetic9Pass'})
        assert login.status_code==200,login.text
        recovered.headers['x-csrf-token']=login.json()['csrf']
        assert (await recovered.post('/api/auth/login',json={'username':'BackupQA','password':'Synthetic9Pass'})).status_code==200
        assert (await recovered.get(uploaded.json()['url'])).content==gif()
        assert (await recovered.get('/api/private-reports/kept.pdf')).content==RAW
        receipt=await recovered.get('/api/clipboard/operations/'+rid)
        assert receipt.status_code==200 and receipt.json()['state']=='completed',receipt.text
        assert receipt.json()['currentInstanceMatches'] is False and receipt.json()['currentHostEffectKnown'] is False
        assert receipt.json()['originInstance']==str(configured.instance_id)
        assert len(calls)==1
