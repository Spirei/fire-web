"""Real worker archives, isolated restore, exact numbers, source changes and cancellation."""
import hashlib
import json
import subprocess
import threading
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
import pytest_asyncio
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict,make_conninfo
from pydantic import SecretStr
from pgserver.postgres_server import POSTGRES_BIN_PATH

from alcor_api.backups import BackupFailure
from alcor_api.database_migration_capture import CaptureBudget,capture_database
from alcor_api.database_migration_jobs import execute
from alcor_api.worker import claim,finish
from test_fire_web import fire_login


@pytest_asyncio.fixture
async def migration_source(client,admin,settings,pg,tmp_path):
    name='alcor_migration_fixture_'+uuid4().hex
    with psycopg.connect(pg.get_uri(),autocommit=True) as conn:
        user=conn.execute('SELECT current_user').fetchone()[0]
        conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    with psycopg.connect(pg.get_uri(database=name),autocommit=True) as conn:
        conn.execute('CREATE SCHEMA ledger')
        conn.execute('CREATE TABLE ledger.originals(id text PRIMARY KEY,amount numeric,large_id bigint,note text)')
        conn.execute("INSERT INTO ledger.originals VALUES('retained-source',123.000000000000000001,9007199254740993,'原始文字')")
        conn.execute('CREATE TABLE ledger.partitioned(id integer,amount numeric) PARTITION BY RANGE(id)')
        conn.execute('CREATE TABLE ledger.partition_a PARTITION OF ledger.partitioned FOR VALUES FROM (0) TO (10)')
        conn.execute('CREATE TABLE ledger.partition_b PARTITION OF ledger.partitioned FOR VALUES FROM (10) TO (20)')
        conn.execute('INSERT INTO ledger.partitioned VALUES(1,1.000000000000000001),(11,9007199254740993)')
    current=conninfo_to_dict(settings.database_url.get_secret_value());current['user']=user
    settings.database_url=SecretStr(make_conninfo(**current))
    settings.source_revision='a'*40
    settings.backup_dir=tmp_path/'backups';settings.pg_tools_dir=POSTGRES_BIN_PATH
    settings.backup_stream_disk_reserve_bytes=16*1024**2
    config={'host':current['host'],'port':int(current.get('port',5432)),'username':user,'database':name,'schema_name':'ledger'}
    settings.connection_targets.append({'kind':'postgresql','host':config['host'],'port':config['port'],'database':name})
    await fire_login(client)
    saved=await client.put('/api/fire/database-migration/source',json={'request_id':str(uuid4()),'expected_revision':None,'config':config,'password_mode':'clear'})
    assert saved.status_code==200,saved.text
    revision=saved.json()['source']['revision']
    for path,payload in [('/source/test',{'revision':revision}),('/target/test',None)]:
        response=await client.post('/api/fire/database-migration'+path,json=payload)
        assert response.status_code==200,response.text
    try:yield config,revision
    finally:
        async with await psycopg.AsyncConnection.connect(pg.get_uri(),autocommit=True) as conn:
            await conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))


async def test_fire_worker_preparation_archives_both_databases_with_true_scope_and_restores_source(client,db,settings,pg,migration_source):
    config,revision=migration_source
    # Exercise shared lock pressure through a real restored CHECK function.
    # Advisory and relation locks share the same bounded PostgreSQL lock pool.
    with psycopg.connect(pg.get_uri(database=config['database'])) as conn:
        conn.execute('''CREATE FUNCTION ledger.restore_lock_budget() RETURNS boolean LANGUAGE plpgsql AS $$
            BEGIN
                FOR lock_id IN 1..4096 LOOP PERFORM pg_catalog.pg_advisory_xact_lock(903173,lock_id); END LOOP;
                RETURN true;
            END $$''')
        conn.execute('ALTER TABLE ledger.originals ADD CONSTRAINT restore_lock_budget CHECK (ledger.restore_lock_budget())')
    payload={'request_id':str(uuid4()),'source_revision':revision}
    started=await client.post('/api/fire/database-migration/preparations',json=payload)
    assert started.status_code==202,started.text
    assert (await client.post('/api/fire/database-migration/preparations',json=payload)).json()['id']==started.json()['id']
    assert (await client.post('/api/fire/database-migration/preparations',json=payload|{'request_id':str(uuid4())})).status_code==409
    task=await claim(db,uuid4())
    assert str(task['id'])==started.json()['id']
    assert task['payload']['_session_client']=='legacy-web'
    await execute(db,task)
    response=await client.get('/api/fire/tasks/'+str(task['id']))
    assert response.status_code==200,response.text
    result=response.json();assert result['status']=='succeeded',result
    assert result['result']['business_written'] is False and result['result']['cutover_ready'] is False
    assert result['result']['phase']=='awaiting_mapping' and result['result']['files_included'] is False
    assert result['result']['source']['archive_integrity_verified'] and result['result']['source']['restore_verified'] is True
    assert result['result']['target']['restore_verified'] is True
    assert '_session_hash' not in response.text and str(settings.backup_dir) not in response.text
    directory=settings.backup_dir/'database-migrations'/str(task['id'])/'attempt-1'
    manifest=json.loads((directory/'source/manifest.json').read_bytes())
    assert manifest['format']=='database-migration-snapshot/1' and manifest['selected_schema']=='ledger'
    assert manifest['build_sha']=='a'*40 and manifest['driver_version']==psycopg.__version__
    assert result['result']['build_sha']=='a'*40
    counts={item['name']:item['rows'] for item in manifest['tables'] if item['schema']=='ledger'}
    assert counts=={'originals':1,'partitioned':0,'partition_a':1,'partition_b':1}
    assert result['result']['source']['rows']==3
    table=next(t for t in manifest['tables'] if t['schema']=='ledger' and t['name']=='originals')
    raw=(directory/'source'/table['file']).read_bytes()
    assert b'123.000000000000000001' in raw and b'9007199254740993' in raw
    assert hashlib.sha256(raw).hexdigest()==table['file_sha256']
    assert not list(directory.rglob('pgpass'))
    source_bytes=(directory/'source/database.dump').read_bytes()
    assert hashlib.sha256(source_bytes).hexdigest()==manifest['archive']['sha256']
    # Independently restore the source once more to check exact numeric lexemes.
    target='alcor_migration_restored_'+uuid4().hex
    with psycopg.connect(pg.get_uri(),autocommit=True) as conn:
        conn.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(target)))
    try:
        run=subprocess.run([str(Path(POSTGRES_BIN_PATH)/'pg_restore'),'--no-owner','--no-privileges','--exit-on-error','--single-transaction','--dbname='+pg.get_uri(database=target),str(directory/'source/database.dump')],capture_output=True)
        assert run.returncode==0,run.stderr.decode()
        for database in (config['database'],target):
            with psycopg.connect(pg.get_uri(database=database)) as conn:
                assert conn.execute('SELECT amount::text,large_id::text,note FROM ledger.originals').fetchone()==('123.000000000000000001','9007199254740993','原始文字')
        async with db.connection() as conn:
            assert (await(await conn.execute('SELECT count(*) AS n FROM portfolio_records')).fetchone())['n']==0
    finally:
        async with await psycopg.AsyncConnection.connect(pg.get_uri(),autocommit=True) as conn:
            await conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(target)))


async def test_source_edit_stops_admitted_job_before_export_and_queued_cancel_is_terminal(client,db,settings,migration_source):
    config,revision=migration_source
    payload={'request_id':str(uuid4()),'source_revision':revision}
    first=await client.post('/api/fire/database-migration/preparations',json=payload)
    assert first.status_code==202,first.text
    changed=await client.put('/api/fire/database-migration/source',json={'request_id':str(uuid4()),'expected_revision':revision,'config':config|{'schema_name':'changed'},'password_mode':'keep'})
    assert changed.status_code==200,changed.text
    task=await claim(db,uuid4())
    with pytest.raises(BackupFailure,match='配置已变化'):await execute(db,task)
    assert not (settings.backup_dir/'database-migrations'/str(task['id'])).exists()
    await finish(db,task,{'business_written':False},error_code='database_migration_preparation_failed')
    # The old successful observation cannot authorize the new source revision.
    refused=await client.post('/api/fire/database-migration/preparations',json={'request_id':str(uuid4()),'source_revision':changed.json()['source']['revision']})
    assert refused.status_code==409
    restored=await client.put('/api/fire/database-migration/source',json={'request_id':str(uuid4()),'expected_revision':changed.json()['source']['revision'],'config':config,'password_mode':'keep'})
    latest=restored.json()['source']['revision']
    assert (await client.post('/api/fire/database-migration/source/test',json={'revision':latest})).status_code==200
    assert (await client.post('/api/fire/database-migration/target/test')).status_code==200
    queued=await client.post('/api/fire/database-migration/preparations',json={'request_id':str(uuid4()),'source_revision':latest})
    assert queued.status_code==202,queued.text
    cancelled=await client.post('/api/fire/tasks/'+queued.json()['id']+'/cancel')
    assert cancelled.json()['status']=='cancelled'
    assert await claim(db,uuid4()) is None
    assert not (settings.backup_dir/'database-migrations'/queued.json()['id']).exists()


def test_cancelled_capture_never_opens_source_or_leaves_password_file(tmp_path):
    cancel=threading.Event();cancel.set()
    budget=CaptureBudget(1024**2,0,120)
    with pytest.raises(BackupFailure,match='停止'):
        capture_database(None,'must-not-open',tmp_path,'source',budget,cancel,lambda event:None)
    assert not list(tmp_path.iterdir())


async def test_cancel_unknown_preparation_prevents_late_admission(client,db,migration_source):
    _,revision=migration_source
    identifier=str(uuid4())
    stopped=await client.post('/api/fire/database-migration/preparations/cancel',json={'request_id':identifier})
    assert stopped.status_code==200 and stopped.json()['status']=='cancelled',stopped.text
    late=await client.post('/api/fire/database-migration/preparations',json={'request_id':identifier,'source_revision':revision})
    assert late.status_code==202 and late.json()['id']==stopped.json()['id'] and late.json()['status']=='cancelled'
    assert await claim(db,uuid4()) is None
    assert (await client.post('/api/fire/database-migration/preparations/cancel',json={'request_id':identifier})).json()==stopped.json()


async def test_changed_target_identity_stops_before_export(pg,settings,tmp_path):
    root=tmp_path/'identity-check';root.mkdir()
    budget=CaptureBudget(1024**2,0,120)
    with pytest.raises(BackupFailure,match='新库身份已变化'):
        capture_database(settings,pg.get_uri(),root,'target',budget,threading.Event(),lambda event:None,expected_identity='0'*64,schema='public')
    assert not (root/'target/database.dump').exists()
    assert not list(root.rglob('pgpass'))


async def test_changed_build_rejects_old_checks_and_queued_preparation(client,db,settings,migration_source):
    _,revision=migration_source
    started=await client.post('/api/fire/database-migration/preparations',json={'request_id':str(uuid4()),'source_revision':revision})
    assert started.status_code==202,started.text
    settings.source_revision='1'*40
    task=await claim(db,uuid4())
    with pytest.raises(BackupFailure,match='配置已变化'):await execute(db,task)
    assert not (settings.backup_dir/'database-migrations'/str(task['id'])).exists()
    assert (await client.get('/api/fire/database-migration/connections')).json()['checks']=={'source':None,'target':None}


@pytest_asyncio.fixture
async def failed_target_restore(client,db,settings,migration_source,monkeypatch):
    import alcor_api.database_migration_rehearsal as module
    _,revision=migration_source
    response=await client.post('/api/fire/database-migration/preparations',json={'request_id':str(uuid4()),'source_revision':revision})
    assert response.status_code==202,response.text
    task=await claim(db,uuid4());original=module.run
    def fail_target(settings,name,args,*rest,**kwargs):
        if name=='pg_restore' and '--dbname=target_snapshot' in args:raise BackupFailure('synthetic target restore failure')
        return original(settings,name,args,*rest,**kwargs)
    monkeypatch.setattr(module,'run',fail_target)
    with pytest.raises(BackupFailure,match='synthetic target'):await execute(db,task)
    assert await finish(db,task,{'message':'synthetic target restore failure','business_written':False},error_code='database_migration_preparation_failed')
    monkeypatch.setattr(module,'run',original)
    folder=settings.backup_dir/'database-migrations'/str(task['id'])/'attempt-1'
    assert (folder/'source/restore-receipt.json').exists() and not (folder/'target/restore-receipt.json').exists()
    return task,folder


async def test_retry_reuses_snapshots_and_completed_source_only_restores_target_across_builds(client,db,settings,failed_target_restore,monkeypatch):
    import alcor_api.database_migration_jobs as jobs
    import alcor_api.database_migration_rehearsal as module
    parent,folder=failed_target_restore
    before={str(p.relative_to(folder)):hashlib.sha256(p.read_bytes()).hexdigest() for label in ('source','target') for p in (folder/label).rglob('*') if p.is_file()}
    # A published repair can resume the prior immutable archives explicitly.
    settings.source_revision='b'*40
    payload={'request_id':str(uuid4())};path='/api/fire/database-migration/preparations/'+str(parent['id'])+'/retry'
    response=await client.post(path,json=payload);assert response.status_code==202,response.text
    assert response.json()['result']['progress']['phase']=='target_restore'
    assert (await client.post(path,json=payload)).json()['id']==response.json()['id']
    assert (await client.post(path,json={'request_id':str(uuid4())})).status_code==409
    def forbidden_capture(*args,**kwargs):raise AssertionError('retry must never capture either live database')
    monkeypatch.setattr(jobs,'capture_database',forbidden_capture)
    original=module.run;restores=[]
    def record(settings,name,args,*rest,**kwargs):
        if name=='pg_restore':restores.append(next(a for a in args if a.startswith('--dbname=')))
        return original(settings,name,args,*rest,**kwargs)
    monkeypatch.setattr(module,'run',record)
    task=await claim(db,uuid4());assert str(task['id'])==response.json()['id']
    await execute(db,task)
    detail=(await client.get('/api/fire/tasks/'+str(task['id']))).json()
    assert detail['status']=='succeeded',detail
    result=detail['result'];assert result['capture_reused'] is True and result['business_written'] is False and result['cutover_ready'] is False
    assert result['source']['restore_reused'] is True and result['source']['restore_verified'] is True and result['target']['restore_verified'] is True
    assert restores==['--dbname=target_snapshot']
    assert result['archive_id']==str(parent['id']) and result['resumed_from']==str(parent['id'])
    assert before=={str(p.relative_to(folder)):hashlib.sha256(p.read_bytes()).hexdigest() for label in ('source','target') for p in (folder/label).rglob('*') if p.is_file()}
    assert (await client.post(path,json=payload)).json()['status']=='succeeded'
    assert (await client.post(path,json={'request_id':str(uuid4())})).status_code==409
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) AS n FROM portfolio_records')).fetchone())['n']==0


async def test_retry_stops_if_retained_rows_change_after_admission(client,db,settings,failed_target_restore):
    parent,folder=failed_target_restore
    response=await client.post('/api/fire/database-migration/preparations/'+str(parent['id'])+'/retry',json={'request_id':str(uuid4())})
    assert response.status_code==202,response.text
    manifest=json.loads((folder/'source/manifest.json').read_bytes())
    sidecar=folder/'source'/manifest['tables'][0]['file']
    sidecar.write_bytes(sidecar.read_bytes()+b'\n')
    task=await claim(db,uuid4())
    with pytest.raises(BackupFailure,match='副本已变化'):await execute(db,task)
    attempt=settings.backup_dir/'database-migrations'/str(task['id'])/'attempt-1'
    assert not (attempt/'rehearsal-cluster').exists()
    assert (await client.post('/api/fire/database-migration/preparations/'+str(parent['id'])+'/retry',json={'request_id':str(uuid4())})).status_code==409


async def test_retry_cancelled_request_and_invalid_proof_never_restart(client,db,failed_target_restore):
    parent,folder=failed_target_restore;identifier=str(uuid4())
    path='/api/fire/database-migration/preparations/'+str(parent['id'])+'/retry'
    cancelled=await client.post('/api/fire/database-migration/preparations/cancel',json={'request_id':identifier})
    assert cancelled.status_code==200
    late=await client.post(path,json={'request_id':identifier})
    assert late.status_code==202 and late.json()['status']=='cancelled'
    assert await claim(db,uuid4()) is None
    manifest_path=folder/'target/manifest.json';original_manifest=manifest_path.read_bytes()
    manifest=json.loads(original_manifest);manifest['identity']['database']='changed-source'
    manifest_path.write_text(json.dumps(manifest))
    assert (await client.post(path,json={'request_id':str(uuid4())})).status_code==422
    manifest_path.write_bytes(original_manifest)
    proof=folder/'source/restore-receipt.json';value=json.loads(proof.read_bytes());value['tables'][0]['rows']+=1
    proof.write_text(json.dumps(value))
    rejected=await client.post(path,json={'request_id':str(uuid4())})
    assert rejected.status_code==422,rejected.text
    assert await claim(db,uuid4()) is None
