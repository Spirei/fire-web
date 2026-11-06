"""Complete legacy settings requests own preflight and all configuration commits.

Only the fixture's identity-checked isolated PostgreSQL is probed; no provider,
SMTP server, external database or production setting is contacted.
"""
import asyncio
from uuid import UUID, uuid4, uuid5

import httpx
import test_backups as backup_support
from alcor_api.connections import Connections, current_config
from alcor_api.main import create_app
from psycopg import sql

configured=backup_support.configured
backup_app=backup_support.backup_app
bc=backup_support.bc
PASSWORD='Synthetic9Pass'


async def command(client,settings,*,rid=None,title='Synthetic atomic settings'):
    view=await client.get('/api/settings')
    assert view.status_code==200,view.text
    config,password=current_config(settings,'postgresql')
    body={'requestId':str(rid or uuid4()),'revision':view.json()['revision'],
        'privateRevision':view.json()['privateRevision'],'currentPassword':PASSWORD,
        'pgHost':config.host,'pgPort':str(config.port),'pgDatabase':config.database,'pgUser':config.username,
        'title':title,'smtpEnabled':False,'smtpHost':'smtp.synthetic.invalid','smtpPort':'465','smtpSecure':True}
    if password:body['pgPassword']=password
    return body


async def configuration_rows(db):
    """Every authority head and committed configuration receipt, not telemetry/admission."""
    names=('connection_settings','site_settings','site_settings_operations','private_runtime_scope',
        'private_runtime_heads','private_runtime_versions','private_runtime_operations',
        'shared_broker_directory','shared_broker_directory_operations')
    async with db.connection()as conn:
        result={}
        for name in names:
            row=await(await conn.execute(sql.SQL("SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS bytes FROM {} t").format(sql.Identifier(name)))).fetchone()
            result[name]=row['bytes']
        return result


async def disable_apply(service,monkeypatch):
    # A watcher applying an already committed setting is a separate operation;
    # these vectors inspect pending configuration, never change a live pool.
    async def no_apply():pass
    monkeypatch.setattr(service,'refresh',no_apply)


async def test_parent_admission_same_body_unknown_cannot_steal_success_and_different_body_conflicts(client,admin,app,db,settings,monkeypatch):
    service=app.state.connections
    await disable_apply(service,monkeypatch)
    original=service.check;entered=asyncio.Event();release=asyncio.Event();calls=[]
    async def check(config,password,probe,require_current=False):
        calls.append(probe);entered.set()
        await asyncio.wait_for(release.wait(),4)
        return await original(config,password,probe,require_current)
    monkeypatch.setattr(service,'check',check)
    body=await command(client,settings)
    before=await configuration_rows(db)
    first=asyncio.create_task(client.put('/api/settings',json=body))
    try:
        await asyncio.wait_for(entered.wait(),3)
        second=await client.put('/api/settings',json=body)
        assert second.status_code==202 and second.json()['state']=='unknown',second.text
        assert second.json()['settingsApplied']is False
        assert second.json()['childRequestId']==str(uuid5(UUID(body['requestId']),'legacy-settings-postgresql'))
        changed=await client.put('/api/settings',json={**body,'title':'Different complete intent'})
        assert changed.status_code==409,changed.text
        assert await configuration_rows(db)==before
        async with db.connection()as conn:
            admission=await(await conn.execute('SELECT * FROM legacy_settings_admissions WHERE actor_id=%s AND request_id=%s',(admin,body['requestId']))).fetchone()
            assert admission['origin_instance']==settings.instance_id
            assert admission['child_request_id']==uuid5(UUID(body['requestId']),'legacy-settings-postgresql')
            assert not await(await conn.execute('SELECT 1 FROM legacy_settings_receipts WHERE actor_id=%s AND request_id=%s',(admin,body['requestId']))).fetchone()
    finally:release.set()
    saved=await first
    assert saved.status_code==200 and saved.json()['state']=='completed',saved.text
    assert len(calls)==1
    receipt=await client.get('/api/settings/operations/'+body['requestId'])
    assert receipt.status_code==200 and receipt.json()==saved.json(),receipt.text
    assert (await client.put('/api/settings',json=body)).json()==saved.json()
    assert len(calls)==1
    async with db.connection()as conn:
        config=await(await conn.execute("SELECT config FROM connection_settings WHERE kind='postgresql'")).fetchone()
        assert config['config']['database']==body['pgDatabase']
        assert (await(await conn.execute('SELECT count(*)AS n FROM legacy_settings_admissions WHERE actor_id=%s AND request_id=%s',(admin,body['requestId']))).fetchone())['n']==1
    current=(await client.get('/api/settings')).json()
    assert current['settings']['title']==body['title'] and current['settings']['smtpHost']==body['smtpHost']


async def test_late_private_validation_failure_rolls_back_connection_and_public_and_private_config(client,admin,app,db,settings,monkeypatch):
    service=app.state.connections
    await disable_apply(service,monkeypatch)
    original=service.check;calls=[]
    async def check(*args,**kwargs):calls.append(1);return await original(*args,**kwargs)
    monkeypatch.setattr(service,'check',check)
    body=await command(client,settings)
    before=await configuration_rows(db)
    response=await client.put('/api/settings',json={**body,'smtpPort':'not-a-port'})
    assert response.status_code==422,response.text
    assert await configuration_rows(db)==before
    assert len(calls)==1
    async with db.connection()as conn:
        final=await(await conn.execute('SELECT result FROM legacy_settings_receipts WHERE actor_id=%s AND request_id=%s',(admin,body['requestId']))).fetchone()
        assert final and final['result']['state']=='rejected'
        assert final['result']['transactionRolledBack'] is True and final['result']['settingsApplied'] is False
        child=await(await conn.execute('SELECT result FROM connection_receipts WHERE owner_id=%s AND request_id=%s',(admin,str(uuid5(UUID(body['requestId']),'legacy-settings-postgresql'))))).fetchone()
        assert child and child['result']['status']=='unknown'
        assert child['result']['originInstance']==str(settings.instance_id) and child['result']['admissionId']
        assert child['result']['preflightObserved']['status']=='passed'
        admitted=await(await conn.execute('SELECT * FROM legacy_settings_admissions WHERE actor_id=%s AND request_id=%s',(admin,body['requestId']))).fetchone()
        assert admitted and admitted['origin_instance']==settings.instance_id
    replay=await client.put('/api/settings',json={**body,'smtpPort':'not-a-port'})
    assert replay.status_code==422 and replay.json()==final['result'],replay.text
    assert len(calls)==1 and await configuration_rows(db)==before


async def test_closed_directory_child_cannot_mark_mixed_parent_completed_or_write_other_domains(client,admin,app,db,settings,monkeypatch):
    body=await command(client,settings)
    # This vector requires no PostgreSQL probe; isolate the groups child's state.
    body={key:value for key,value in body.items()if not key.startswith('pg')}
    body['groups']=[{'id':'synthetic','name':'Must not be committed'}]
    child=uuid5(UUID(body['requestId']),'shared-broker-directory')
    closed=await client.post('/api/admin/shared-brokers/operations/'+str(child)+'/close',json={})
    assert closed.status_code==200 and closed.json()['state']=='closed',closed.text
    before=await configuration_rows(db)
    response=await client.put('/api/settings',json=body)
    assert response.status_code==409,response.text
    assert await configuration_rows(db)==before
    async with db.connection()as conn:
        parent=await(await conn.execute('SELECT result FROM legacy_settings_receipts WHERE actor_id=%s AND request_id=%s',(admin,body['requestId']))).fetchone()
        assert parent is None or parent['result']['state']!='completed'


async def test_actual_capsule_restores_parent_child_admission_bytes_without_reprobing_or_reapplying(bc,backup_app,configured,monkeypatch):
    service=backup_app.state.connections
    apply_saved_settings=service.refresh
    await disable_apply(service,monkeypatch)
    original=service.check;calls=[]
    async def check(*args,**kwargs):calls.append(1);return await original(*args,**kwargs)
    monkeypatch.setattr(service,'check',check)
    body=await command(bc,configured,title='Original instance settings')
    saved=await bc.put('/api/settings',json=body)
    assert saved.status_code==200 and saved.json()['state']=='completed',saved.text
    child=uuid5(UUID(body['requestId']),'legacy-settings-postgresql')
    owner=saved.json().get('userId')
    async with backup_app.state.db.connection()as conn:
        rows=await(await conn.execute('SELECT actor_id,result::text AS bytes FROM legacy_settings_receipts WHERE request_id=%s',(body['requestId'],))).fetchall()
        assert len(rows)==1;owner=rows[0]['actor_id'];parent_bytes=rows[0]['bytes']
        child_row=await(await conn.execute('SELECT result::text AS bytes,result FROM connection_receipts WHERE owner_id=%s AND request_id=%s',(owner,child))).fetchone()
        assert child_row['result']['originInstance']==str(configured.instance_id)
        admission=await(await conn.execute("SELECT actor_id,request_id,fingerprint,origin_instance,admission_id,child_request_id,extract(epoch from created_at)::text AS created_epoch FROM legacy_settings_admissions WHERE actor_id=%s AND request_id=%s",(owner,body['requestId']))).fetchone()
    assert len(calls)==1
    # Real backup refuses a saved PG head without its matching applied bootstrap.
    # Apply once to this same isolated PG using the real existing consumer; do
    # not forge a bootstrap or disable the backup's revision guard.
    await apply_saved_settings()
    assert len(calls)==2
    backup,_=await backup_support.create_capsule(bc,backup_app,configured)
    preview=await bc.get('/api/backups/'+backup+'/restore-preview',params={'target_id':'isolated-qa'})
    assert preview.status_code==200,preview.text
    job,_=await backup_support.submit(bc,'backup.restore',backup_id=backup,target_id='isolated-qa',restore_ticket=preview.json()['restore_ticket'])
    await backup_support.execute(backup_app,configured,UUID(job['id']))
    target=configured.restore_targets[0]
    restored=configured.model_copy(update={'database_url':target.database_url,'instance_id':target.instance_id,'file_root':target.recovery_directory/'files','connection_secret_dir':target.recovery_directory/'connection-secrets','restore_targets':[]})
    async def forbidden(*args,**kwargs):raise AssertionError('Restored receipt read/replay must never probe or apply the old target')
    monkeypatch.setattr(Connections,'check',forbidden)
    recovered_app=create_app(restored)
    async with recovered_app.router.lifespan_context(recovered_app),httpx.AsyncClient(transport=httpx.ASGITransport(app=recovered_app),base_url='http://testserver',headers={'origin':'http://testserver'})as recovered:
        login=await recovered.post('/api/session/login',json={'login':'BackupQA','password':PASSWORD})
        assert login.status_code==200,login.text
        recovered.headers['x-csrf-token']=login.json()['csrf']
        read=await recovered.get('/api/settings/operations/'+body['requestId'])
        assert read.status_code==200 and read.json()==saved.json(),read.text
        replay=await recovered.put('/api/settings',json=body)
        assert replay.status_code==200 and replay.json()==saved.json(),replay.text
        async with recovered_app.state.db.connection()as conn:
            parent=await(await conn.execute('SELECT result::text AS bytes FROM legacy_settings_receipts WHERE actor_id=%s AND request_id=%s',(owner,body['requestId']))).fetchone()
            restored_child=await(await conn.execute('SELECT result::text AS bytes FROM connection_receipts WHERE owner_id=%s AND request_id=%s',(owner,child))).fetchone()
            restored_admission=await(await conn.execute("SELECT actor_id,request_id,fingerprint,origin_instance,admission_id,child_request_id,extract(epoch from created_at)::text AS created_epoch FROM legacy_settings_admissions WHERE actor_id=%s AND request_id=%s",(owner,body['requestId']))).fetchone()
            assert parent['bytes']==parent_bytes and restored_child['bytes']==child_row['bytes'] and restored_admission==admission
            assert restored_admission['origin_instance']==configured.instance_id and configured.instance_id!=restored.instance_id
            assert (await(await conn.execute('SELECT count(*)AS n FROM connection_settings')).fetchone())['n']==0
    assert len(calls)==2
