from source_window_fixture import active_window
import asyncio
import copy
import hashlib
import json
from pathlib import Path
from uuid import UUID,uuid4

import httpx
import psycopg
import pytest
from pgserver.postgres_server import POSTGRES_BIN_PATH
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict,make_conninfo
from pydantic import SecretStr

from alcor_api import backups
from alcor_api.backups import target_connection
from alcor_api.cli import create_user
from alcor_api.config import RestoreTarget
from alcor_api.main import create_app
from alcor_api.worker import claim,finish
from alcor_api.source_registry import load_registry,RegistryError
from alcor_api.source_snapshot import canonical,schema_digest
from .synthetic_legacy import OWNER
from .test_source_authority import authorized,export,target
from .test_source_concurrency import ready


@pytest.mark.asyncio
async def test_registry_is_instance_and_private_file_bound_and_not_enabled_by_environment(settings):
    assert settings.environment=='local' and load_registry(settings)
    file=settings.legacy_source_registry_path;original=file.read_bytes()
    file.chmod(0o644)
    with pytest.raises(RegistryError):load_registry(settings)
    file.chmod(0o600)
    data=json.loads(original);data['platformInstance']=str(uuid4());file.write_text(json.dumps(data))
    with pytest.raises(RegistryError):load_registry(settings)
    file.write_bytes(original)
    app=create_app(settings.model_copy(update={'legacy_source_registry_path':None}))
    assert app.state.source_authority.registry=={}




@pytest.mark.asyncio
async def test_lost_export_response_restarts_actual_create_app_and_recovers_original_uuid(client,admin,old_pg,settings):
    grant=await authorized(client,admin,old_pg)
    command={'requestId':str(uuid4()),'grantRevision':grant['grantRevision'],'predecessorHash':None}
    path='/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots'
    # Read the actual committed HTTP response, then simulate transport loss.
    class DropResponse(httpx.AsyncBaseTransport):
        def __init__(self,app):self.inner=httpx.ASGITransport(app=app)
        async def handle_async_request(self,request):
            response=await self.inner.handle_async_request(request)
            await response.aread();raise httpx.ReadError('synthetic response lost after server commit')
    first=create_app(settings)
    async with first.router.lifespan_context(first):
        async with httpx.AsyncClient(transport=DropResponse(first),base_url='http://testserver',cookies=client.cookies,headers=dict(client.headers)) as broken:
            with pytest.raises(httpx.ReadError):await broken.post(path,json=command)
    restarted=create_app(settings)
    async with restarted.router.lifespan_context(restarted):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=restarted),base_url='http://testserver',cookies=client.cookies,headers=dict(client.headers)) as recovered:
            response=await recovered.get('/api/legacy-financial/operations/'+command['requestId'])
            assert response.status_code==200 and response.json()['state']=='completed'
            receipt=response.json();assert (await recovered.post(path,json=command)).json()==receipt
            async with restarted.state.db.connection() as conn:
                assert (await(await conn.execute('SELECT count(*) n FROM legacy_source_manifests')).fetchone())['n']==1


@pytest.mark.asyncio
async def test_encrypted_product_backup_restore_retains_one_manifest_ledger_and_revokes_cross_instance_authority(settings,old_pg,pg,tmp_path):
    settings.backup_dir=tmp_path/'capsules';settings.backup_secret_dir=tmp_path/'capsule-key';settings.file_root=tmp_path/'files';settings.file_root.mkdir(mode=0o700);settings.pg_tools_dir=POSTGRES_BIN_PATH
    with psycopg.connect(settings.database_url.get_secret_value()) as conn:
        directory=Path(conn.execute('SHOW data_directory').fetchone()[0]);user=conn.execute('SELECT current_user').fetchone()[0]
    info=conninfo_to_dict(settings.database_url.get_secret_value());info['user']=user
    settings.database_url=SecretStr(make_conninfo(**info))
    name='alcor_restore_'+uuid4().hex
    with psycopg.connect(pg.get_uri(),autocommit=True) as conn:conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    info['dbname']=name
    restore=RestoreTarget(id='isolated-source-qa',name='Isolated synthetic source recovery',database_url=make_conninfo(**info),instance_id=uuid4(),data_directory=directory,recovery_directory=tmp_path/'recovered')
    settings.restore_targets=[restore]
    conn=await target_connection(restore,enroll=True);await conn.close()
    async def task(client,app,kind,**data):
        response=await client.post('/api/tasks',json={'kind':kind,'request_id':str(uuid4()),**data});assert response.status_code==202,response.text
        identifier=UUID(response.json()['id']);job=await claim(app.state.db,uuid4());assert job and job['id']==identifier
        result=await backups.run_job(settings,app.state.db,job);assert await finish(app.state.db,job,result)
        return str(identifier),result
    try:
        owner=await create_user(settings,'SourceRecoveryOwner','Synthetic9Pass')
        app=create_app(settings)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app,raise_app_exceptions=False),base_url='http://testserver',headers={'origin':'http://testserver'}) as client:
                login=await client.post('/api/session/login',json={'login':'SourceRecoveryOwner','password':'Synthetic9Pass'});client.headers['x-csrf-token']=login.json()['csrf']
                grant,source,data,proof=await ready(client,owner,old_pg)
                posted=await client.post('/api/financial-import/operations',json={'data':data,'preview':proof});assert posted.status_code==200 and posted.json()['financialApplied'],posted.text
                async def state(db):
                    async with db.connection() as conn:
                        return {table:await(await conn.execute('SELECT * FROM '+table+' ORDER BY 1,2')).fetchall() for table in ('legacy_source_grants','legacy_source_owner_claims','legacy_source_manifests','legacy_source_view_bindings','legacy_source_heads','legacy_source_operations','financial_import_sources','financial_import_links','financial_import_operations','fee_legacy_inventory_snapshots','fee_legacy_inventory_orders','trade_ledger','cash_ledger_entries','portfolio_records')}
                before=await state(app.state.db)
                capsule,_=await task(client,app,'backup.create')
                encrypted=(settings.backup_dir/(capsule+'.enc')).read_bytes()
                assert not encrypted.startswith(b'PGDMP') and b'legacy-owner-A' not in encrypted
                response=await client.get('/api/backups/'+capsule+'/restore-preview',params={'target_id':restore.id});assert response.status_code==200,response.text
                _,result=await task(client,app,'backup.restore',backup_id=capsule,target_id=restore.id,restore_ticket=response.json()['restore_ticket'])
                assert result['sessions_revoked']
                restored_settings=settings.model_copy(update={'database_url':restore.database_url,'instance_id':restore.instance_id,'environment':'test','file_root':restore.recovery_directory/'files','connection_secret_dir':restore.recovery_directory/'connection-secrets','legacy_source_registry_path':None})
                recovered=create_app(restored_settings)
                async with recovered.router.lifespan_context(recovered):
                    assert await state(recovered.state.db)==before
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=recovered),base_url='http://testserver',headers={'origin':'http://testserver'}) as restored_client:
                        login=await restored_client.post('/api/session/login',json={'login':'SourceRecoveryOwner','password':'Synthetic9Pass'});assert login.status_code==200,login.text
                        restored_client.headers['x-csrf-token']=login.json()['csrf']
                        response=await restored_client.get('/api/financial-import/operations/'+data['requestId']);assert response.json()==posted.json()
                        response=await restored_client.get('/api/legacy-financial/manifests/'+source['manifestId']);assert response.status_code==200 and response.json()['manifestSha256']==source['manifestSha256']
                        expected_raw=bytes(before['legacy_source_manifests'][0]['raw'])
                        response=await restored_client.get('/api/legacy-financial/manifests/'+source['manifestId']+'/raw');assert response.status_code==200 and response.content==expected_raw
                        response=await restored_client.get('/api/legacy-financial/authorizations');assert response.json()['items'][0]['effectiveState']=='instance_reenrollment_required'
                        response=await restored_client.post('/api/financial-import/preview',json={**data,'requestId':str(uuid4())});assert response.status_code==409
                assert await state(app.state.db)==before
    finally:
        with psycopg.connect(pg.get_uri(),autocommit=True) as conn:conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
