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
from alcor_api.config import RestoreTarget
from alcor_api.main import create_app
from alcor_api.worker import claim,finish
from .helpers import export
from .test_financial_continuation import append_tail
from .test_financial_mapping import imported,mapping_command,preview


@pytest.mark.asyncio
async def test_actual_encrypted_backup_restore_keeps_two_source_versions_tail_and_derived_mappings(client,admin,old_pg,app,settings,pg,tmp_path):
    settings.backup_dir=tmp_path/'capsules';settings.backup_secret_dir=tmp_path/'capsule-key';settings.file_root=tmp_path/'files';settings.file_root.mkdir(mode=0o700);settings.pg_tools_dir=POSTGRES_BIN_PATH
    with psycopg.connect(settings.database_url.get_secret_value()) as conn:
        directory=Path(conn.execute('SHOW data_directory').fetchone()[0]);user=conn.execute('SELECT current_user').fetchone()[0]
    info=conninfo_to_dict(settings.database_url.get_secret_value());info['user']=user
    settings.database_url=SecretStr(make_conninfo(**info))
    name='alcor_restore_'+uuid4().hex
    with psycopg.connect(pg.get_uri(),autocommit=True) as conn:conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    info['dbname']=name
    restore=RestoreTarget(id='isolated-mapping-qa',name='Isolated synthetic mapping recovery',database_url=make_conninfo(**info),instance_id=uuid4(),data_directory=directory,recovery_directory=tmp_path/'recovered')
    settings.restore_targets=[restore]
    conn=await target_connection(restore,enroll=True);await conn.close()
    async def task(kind,**data):
        response=await client.post('/api/tasks',json={'kind':kind,'request_id':str(uuid4()),**data});assert response.status_code==202,response.text
        identifier=UUID(response.json()['id']);job=await claim(app.state.db,uuid4());assert job and job['id']==identifier
        result=await backups.run_job(settings,app.state.db,job);assert await finish(app.state.db,job,result)
        return str(identifier),result
    async def state(db):
        async with db.connection() as conn:
            return {table:await(await conn.execute('SELECT * FROM '+table+' ORDER BY 1,2')).fetchall() for table in ('legacy_source_manifests','legacy_source_owner_claims','financial_import_links','financial_import_operations','trade_ledger','cash_ledger_entries','legacy_financial_mapping_versions','legacy_financial_mapping_items','legacy_financial_mapping_heads','legacy_financial_mapping_receipts')}
    try:
        grant,first,account,record,finance=await imported(client,admin,old_pg)
        firstmap=mapping_command(admin,first,finance);proof=await preview(client,firstmap)
        assert (await client.post('/api/legacy-financial/mappings/operations',json={'data':firstmap,'preview':proof})).json()['state']=='completed'
        await append_tail(pg,old_pg);second,*_=await export(client,grant,predecessor=first['manifestSha256'])
        command={**finance,'requestId':str(uuid4()),'sourceId':second['sourceId'],'sourceHash':second['financialSha256']}
        p=(await client.post('/api/financial-import/preview',json=command)).json();assert p['ready']
        posted=(await client.post('/api/financial-import/operations',json={'data':command,'preview':p['preview']})).json();assert posted['financialApplied']
        secondmap=mapping_command(admin,second,command,1);proof=await preview(client,secondmap)
        mapped=(await client.post('/api/legacy-financial/mappings/operations',json={'data':secondmap,'preview':proof})).json();assert mapped['state']=='completed'
        before=await state(app.state.db)
        capsule,_=await task('backup.create')
        encrypted=(settings.backup_dir/(capsule+'.enc')).read_bytes();assert not encrypted.startswith(b'PGDMP') and OWNER_BYTES not in encrypted
        response=await client.get('/api/backups/'+capsule+'/restore-preview',params={'target_id':restore.id});assert response.status_code==200,response.text
        _,result=await task('backup.restore',backup_id=capsule,target_id=restore.id,restore_ticket=response.json()['restore_ticket']);assert result['sessions_revoked']
        recovered_settings=settings.model_copy(update={'database_url':restore.database_url,'instance_id':restore.instance_id,'environment':'test','file_root':restore.recovery_directory/'files','connection_secret_dir':restore.recovery_directory/'connection-secrets','legacy_source_registry_path':None})
        recovered=create_app(recovered_settings)
        async with recovered.router.lifespan_context(recovered):
            assert await state(recovered.state.db)==before
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=recovered),base_url='http://testserver',headers={'origin':'http://testserver'}) as restored:
                login=await restored.post('/api/session/login',json={'login':'SourceAdministrator','password':'Synthetic9Pass'});assert login.status_code==200,login.text
                restored.headers['x-csrf-token']=login.json()['csrf']
                assert (await restored.get('/api/financial-import/operations/'+command['requestId'])).json()==posted
                assert (await restored.get('/api/legacy-financial/mappings/operations/'+secondmap['requestId'])).json()==mapped
                assert (await restored.get('/api/legacy-financial/mappings')).json()['content']['manifestId']==second['manifestId']
                assert (await restored.post('/api/legacy-financial/mappings/preview',json=mapping_command(admin,second,command,2))).status_code==409
        assert await state(app.state.db)==before
    finally:
        with psycopg.connect(pg.get_uri(),autocommit=True) as conn:conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))

OWNER_BYTES=b'legacy-owner-A'
