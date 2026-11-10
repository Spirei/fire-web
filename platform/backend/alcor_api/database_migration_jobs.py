"""Durable preparation with isolated restore; never writes either business database."""
import asyncio
import hashlib
import json
import threading
from datetime import UTC,datetime
from uuid import UUID,uuid4

from fastapi import HTTPException
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb

from .backups import BackupFailure,private_dir,tools,write_private
from .connection_access import require_connection_verification
from .connections import Connections,Vault
from .database_migration_connections import MigrationConnections,SourceConfig,fingerprint
from .database_migration_capture import CaptureBudget,capture_database,canonical,sync_directory
from .models import InputModel
from .security import lock_mutation_identity
from . import __version__


class PreparationInput(InputModel):
    request_id:UUID
    source_revision:UUID


class PreparationCancellation(InputModel):
    request_id:UUID


async def submit(db,who,data):
    service=MigrationConnections(db)
    intent={'kind':'database.migration.prepare','source_revision':str(data.source_revision),'runtime_binding':service.runtime_binding()}
    hashed=fingerprint(intent)
    async with db.connection() as conn,conn.transaction():
        await lock_mutation_identity(conn,who)
        await require_connection_verification(conn,who)
        await conn.execute('SELECT pg_advisory_xact_lock(67132153)')
        prior=await(await conn.execute('SELECT * FROM tasks WHERE owner_id=%s AND request_id=%s',(who.id,data.request_id))).fetchone()
        if prior:
            if prior['kind']!='database.migration.prepare':raise HTTPException(409,'此请求编号已用于其他操作')
            if prior['payload'].get('_admission_cancelled'):return public_task(prior)
            if prior['fingerprint']!=hashed:raise HTTPException(409,'此请求编号已用于不同操作')
            return public_task(prior)
        source=await(await conn.execute('SELECT * FROM database_migration_source WHERE singleton FOR SHARE')).fetchone()
        if not source or source['revision']!=data.source_revision:raise HTTPException(409,'旧库配置已变化，请重新读取')
        verified=await(await conn.execute("""SELECT 1 FROM tasks WHERE owner_id=%s AND kind='database.migration.prepare'
            AND payload->>'source_revision'=%s AND status='succeeded' AND result->>'phase'='awaiting_mapping'
            AND result->'source'->>'restore_verified'='true' AND result->'target'->>'restore_verified'='true' LIMIT 1""",
            (who.id,str(data.source_revision)))).fetchone()
        if verified:raise HTTPException(409,'已有恢复核对通过的记录，请继续原迁移，无需重新准备')
        for scope in ('source','target'):
            checked=await(await conn.execute('''SELECT result,created_at>clock_timestamp()-interval '2 minutes' AS fresh FROM database_migration_connection_observations
                WHERE scope=%s AND runtime_binding=%s AND source_revision IS NOT DISTINCT FROM %s ORDER BY id DESC LIMIT 1''',
                (scope,service.runtime_binding(),data.source_revision if scope=='source' else None))).fetchone()
            if not checked or not checked['fresh'] or checked['result'].get('state')!='connected':raise HTTPException(409,'请先重新测试两边的连接')
            if not checked['result'].get('persistent_identity_verified'):raise HTTPException(409,('旧库' if scope=='source' else '新库')+'的持久身份尚未核对，暂不能创建迁移快照')
            intent['_'+scope+'_identity']=checked['result']['identity_fingerprint']
        if await(await conn.execute("SELECT 1 FROM tasks WHERE kind LIKE 'database.migration.%' AND status IN ('queued','running','cancel_requested') LIMIT 1")).fetchone():
            raise HTTPException(409,'已有迁移准备任务，请先核对原任务')
        try:
            for name in ('pg_dump','pg_restore','initdb','pg_ctl','postgres'):tools(db.settings,name)
            private_dir(db.settings.backup_dir)
        except (BackupFailure,OSError):raise HTTPException(422,'迁移备份目录或PostgreSQL工具不可用') from None
        client='legacy-web' if getattr(who,'legacy_client',False) and not getattr(who,'legacy_platform',False) else 'new-web'
        intent.update(_session_hash=who.token_hash,_session_client=client,_vault_fingerprint=hashlib.sha256(service.vault.key()).hexdigest() if source['password_ciphertext'] else None)
        identifier=uuid4()
        row=await(await conn.execute("INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,%s,'database.migration.prepare','queued',%s) RETURNING *",
                                    (identifier,who.id,data.request_id,hashed,Jsonb(intent)))).fetchone()
        await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'queued')",(identifier,))
        await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'database-migration.preparation.submitted',%s,%s)",(who.id,str(identifier),data.request_id))
        return public_task(row)


def public_task(row):
    return {**{key:str(row[key]) if key in ('id','request_id') else row[key] for key in ('id','request_id','kind','status','result','error_code')},
            'source_revision':row['payload']['source_revision'],'created_at':row['created_at'].isoformat(),'retry_of':row['payload'].get('retry_of'),'conversion_id':row['payload'].get('conversion_id'),'has_imports':bool(row.get('has_imports',False))}


async def cancel_request(db,who,request_id,*,kind='database.migration.prepare'):
    async with db.connection() as conn,conn.transaction():
        await lock_mutation_identity(conn,who)
        await conn.execute('SELECT pg_advisory_xact_lock(67132153)')
        prior=await(await conn.execute('SELECT * FROM tasks WHERE owner_id=%s AND request_id=%s FOR UPDATE',(who.id,request_id))).fetchone()
        if prior and prior['kind']!=kind:raise HTTPException(409,'此请求编号不属于迁移准备')
        if prior:
            if prior['status'] not in ('queued','running'):return public_task(prior)
            status='cancelled' if prior['status']=='queued' else 'cancel_requested'
            row=await(await conn.execute("UPDATE tasks SET status=%s,finished_at=CASE WHEN %s='cancelled' THEN clock_timestamp() ELSE NULL END WHERE id=%s RETURNING *",(status,status,prior['id']))).fetchone()
        else:
            payload={'source_revision':None,'_admission_cancelled':True}
            row=await(await conn.execute("INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload,result,finished_at) VALUES(%s,%s,%s,%s,%s,'cancelled',%s,%s,clock_timestamp()) RETURNING *",
                (uuid4(),who.id,request_id,fingerprint({'cancelled_request':str(request_id)}),kind,Jsonb(payload),Jsonb({'phase':'cancelled','business_written':False,'cutover_ready':False})))).fetchone()
            status='cancelled'
        await conn.execute('INSERT INTO task_events(task_id,phase) VALUES(%s,%s)',(row['id'],status))
        await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",(who.id,'database-migration.conversion.cancelled' if kind=='database.migration.convert' else 'database-migration.preparation.cancelled',str(row['id']),request_id))
        return public_task(row)


async def listing(db,who):
    async with db.connection() as conn,conn.transaction():
        await lock_mutation_identity(conn,who)
        rows=await(await conn.execute("""SELECT t.*,EXISTS(SELECT 1 FROM tasks child WHERE child.owner_id=t.owner_id
            AND child.kind IN ('database.migration.portfolio','database.migration.history','database.migration.complete')
            AND child.payload->>'preparation_id'=t.id::text AND child.status='succeeded' AND child.result->>'business_written'='true') AS has_imports
            FROM tasks t WHERE t.owner_id=%s AND t.kind='database.migration.prepare'
            ORDER BY has_imports DESC,t.created_at DESC,t.id DESC LIMIT 20""",(who.id,))).fetchall()
    return {'items':[public_task(row) for row in rows]}


async def guard(db,task,progress=None):
    from .worker import owned_row
    service=MigrationConnections(db)
    async with db.connection() as conn,conn.transaction():
        row=await owned_row(conn,task)
        if not row or row['status']!='running':raise BackupFailure('迁移准备已停止或执行权已变化')
        valid=await(await conn.execute('''SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=%s AND s.user_id=%s AND s.client_id=%s AND s.expires_at>clock_timestamp()
            AND u.active AND u.role='admin' AND s.session_version=u.session_version FOR SHARE OF u,s''',
            (task['payload'].get('_session_hash'),task['owner_id'],task['payload'].get('_session_client') if task['payload'].get('_session_client') in ('new-web','legacy-web') else 'invalid'))).fetchone()
        if not valid:raise BackupFailure('迁移准备授权已失效')
        source=await(await conn.execute('SELECT * FROM database_migration_source WHERE singleton FOR SHARE')).fetchone()
        if not source or str(source['revision'])!=task['payload']['source_revision'] or service.runtime_binding()!=task['payload']['runtime_binding']:
            raise BackupFailure('连接配置已变化，原迁移准备已停止')
        key=task['payload'].get('_vault_fingerprint')
        if key and hashlib.sha256(Vault(db.settings.connection_secret_dir,read_only=True).key()).hexdigest()!=key:raise BackupFailure('迁移凭据密钥已变化')
        if progress is not None:
            retained={}
            if task['kind']=='database.migration.complete':
                history=await(await conn.execute('SELECT 1 FROM database_migration_history_imports WHERE owner_id=%s AND conversion_id=%s',(task['owner_id'],UUID(task['payload']['conversion_id'])))).fetchone()
                domains=list(dict.fromkeys([*(row.get('result') or {}).get('completed_domains',[]),*progress.get('completed_domains',[]),'accounts','positions',*(['orders','cash','pnl'] if history else [])]))
                retained={'history_imported':bool(history),'business_written':True,'completed_domains':domains}
            await conn.execute('UPDATE tasks SET result=%s WHERE id=%s',(Jsonb({'phase':progress['phase'],'progress':progress,'business_written':progress.get('business_written',False),'completed_domains':progress.get('completed_domains',[]),'cutover_ready':False,'source_revision':task['payload']['source_revision'],**retained}),task['id']))
            last=await(await conn.execute('SELECT phase FROM task_events WHERE task_id=%s ORDER BY id DESC LIMIT 1',(task['id'],))).fetchone()
            if not last or last['phase']!=progress['phase']:await conn.execute('INSERT INTO task_events(task_id,phase) VALUES(%s,%s)',(task['id'],progress['phase']))
        await conn.execute('UPDATE tasks SET lease_until=clock_timestamp()+make_interval(secs=>%s) WHERE id=%s',(db.settings.lease_seconds,task['id']))
        return source


async def execute(db,task):
    if task['payload'].get('_retry'):
        from .database_migration_retry import execute_retry
        return await execute_retry(db,task)
    settings=db.settings
    source=await guard(db,task)
    config=SourceConfig.model_validate(source['config'])
    password=Vault(settings.connection_secret_dir,read_only=True).decrypt(source['password_ciphertext'],'database-migration-source',settings.instance_id)
    address=await Connections(settings,db,None).address(config)
    values={'host':config.host,'port':config.port,'dbname':config.database,'user':config.username,'password':password,'sslmode':config.ssl_mode}
    if not config.host.startswith('/'):values['hostaddr']=address
    root=private_dir(private_dir(private_dir(settings.backup_dir)/'database-migrations')/str(task['id']))
    attempt=root/('attempt-'+str(task['attempts']))
    if attempt.exists():raise BackupFailure('此迁移尝试已存在，不能覆盖原归档')
    private_dir(attempt)
    budget=CaptureBudget(settings.backup_stream_max_bytes,settings.backup_stream_disk_reserve_bytes,settings.backup_stream_seconds,settings.backup_stream_max_objects)
    def capture(cancel,publish):
        old=capture_database(settings,make_conninfo(**values),attempt,'source',budget,cancel,publish,expected_identity=task['payload']['_source_identity'],schema=config.schema_name)
        new=capture_database(settings,settings.database_url.get_secret_value(),attempt,'target',budget,cancel,publish,expected_identity=task['payload']['_target_identity'],schema='public')
        from .database_migration_rehearsal import rehearse
        restored=rehearse(settings,attempt,{'source':old,'target':new},budget,cancel,publish)
        result={'phase':'awaiting_mapping','source':restored['source'],'target':restored['target'],'business_written':False,'cutover_ready':False,
                'build_sha':settings.source_revision or None,'software_version':__version__,'runtime_binding':task['payload']['runtime_binding'],
                'files_included':False,'source_revision':task['payload']['source_revision'],'archive_id':str(task['id']),'attempt':task['attempts'],'created_at':datetime.now(UTC).isoformat()}
        encoded=canonical(result);budget.object(attempt,cancel);budget.account(attempt,cancel,len(encoded));write_private(attempt/'receipt.json',encoded)
        for directory in (attempt,root,root.parent,settings.backup_dir):sync_directory(directory)
        return result
    await run_preparation(db,task,attempt,budget,capture)


async def run_preparation(db,task,attempt,budget,capture):
    from .worker import finish
    cancel=threading.Event();loop=asyncio.get_running_loop();queue=asyncio.Queue()
    def publish(event):loop.call_soon_threadsafe(queue.put_nowait,event)
    work=asyncio.create_task(asyncio.to_thread(capture,cancel,publish))
    try:
        while not work.done():
            await asyncio.wait({work},timeout=.5)
            budget.check(attempt,cancel)
            events=[]
            while not queue.empty():
                event=queue.get_nowait()
                if events and events[-1]['phase']==event['phase']:events[-1]=event
                else:events.append(event)
            if not events:await guard(db,task)
            for event in events:await guard(db,task,event)
        result=await work
        await guard(db,task)
        await finish(db,task,result)
    except BaseException:
        cancel.set();await asyncio.shield(asyncio.gather(work,return_exceptions=True));raise
