"""Explicit retries reuse sealed snapshots and completed restore proofs, never live capture."""
import asyncio
import hashlib
import json
import os
import re
import stat
import threading
from datetime import UTC,datetime
from uuid import UUID,uuid4

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from . import __version__
from .backups import BackupFailure,private_dir,private_read,tools,write_private
from .backup_stream_storage import existing_directory
from .backup_stream_codec import StreamFailure
from .connection_access import require_connection_verification
from .connections import Vault
from .database_migration_capture import CaptureBudget,canonical,file_sha,sha,sync_directory
from .database_migration_connections import MigrationConnections,fingerprint
from .database_migration_rehearsal import completed_receipt,rehearse,verify_manifest
from .models import InputModel
from .security import lock_mutation_identity


class PreparationRetry(InputModel):
    request_id:UUID


def attempt_path(settings,identifier,attempt):
    identifier=str(UUID(str(identifier)))
    if type(attempt) is not int or not 1<=attempt<=3:raise BackupFailure('原迁移尝试编号无效')
    try:
        base=existing_directory(settings.backup_dir)
        root=existing_directory(existing_directory(base/'database-migrations')/identifier)
        return existing_directory(root/('attempt-'+str(attempt)))
    except StreamFailure:raise BackupFailure('原迁移归档目录不可用') from None


def sealed_state(settings,archive_task,archive_attempt,proof_task,proof_attempt,identities,*,cancel=None,budget=None):
    root=attempt_path(settings,archive_task,archive_attempt)
    proof=attempt_path(settings,proof_task,proof_attempt)
    cluster=proof/'rehearsal-cluster'
    if cluster.is_symlink() or (cluster/'postmaster.pid').exists():raise BackupFailure('原隔离实例尚未确认停止')
    summaries={};completed={};cancel=cancel or threading.Event()
    budget=budget or CaptureBudget(settings.backup_stream_max_bytes,settings.backup_stream_disk_reserve_bytes,settings.backup_stream_seconds,settings.backup_stream_max_objects)
    def account(path):
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077:
            raise BackupFailure('原迁移归档权限无效')
        budget.object(root,cancel);budget.account(root,cancel,info.st_size)
    for label in ('source','target'):
        folder=existing_directory(root/label);existing_directory(folder/'rows')
        for name in ('manifest.json','database.dump','schema.sql'):account(folder/name)
        raw=private_read(folder/'manifest.json',16*1024**2);manifest=json.loads(raw)
        if manifest.get('format')!='database-migration-snapshot/1' or manifest['archive'].get('integrity_verified') is not True:
            raise BackupFailure('原迁移归档格式或校验状态无效')
        captured={key:manifest['identity'][key] for key in ('database','address','port','oid','role','system_identifier')}
        if sha(canonical(captured|{'schema':manifest['selected_schema']}))!=identities[label]:
            raise BackupFailure('原迁移归档与原数据库身份不一致')
        tables=manifest['tables']
        if not isinstance(tables,list) or not 1<=len(tables)<=2000:raise BackupFailure('原迁移表范围无效')
        table_identities=set()
        for table in tables:
            identity=(table['schema'],table['name'])
            if identity in table_identities or not all(isinstance(v,str) and v for v in identity):raise BackupFailure('原迁移表身份无效')
            table_identities.add(identity)
            key=sha(json.dumps(list(identity),ensure_ascii=False,separators=(',',':')).encode())
            if (table['file']!='rows/'+key+'.jsonl' or type(table['rows']) is not int or table['rows']<0
                or not re.fullmatch('[a-f0-9]{64}',table['multiset_sha256'])):raise BackupFailure('原迁移表副本无效')
            path=folder/table['file'];account(path)
            if file_sha(path,cancel)!=table['file_sha256']:raise BackupFailure('原迁移表副本已变化')
        summary={'tables':len(tables),'rows':sum(t['rows'] for t in tables),'archive_sha256':manifest['archive']['sha256'],
                 'manifest_sha256':sha(raw),'bytes':manifest['archive']['bytes'],'archive_integrity_verified':True,'restore_verified':False,'files_included':False}
        verify_manifest(root,label,summary,cancel);summaries[label]=summary
        if (proof/label/'restore-receipt.json').exists():
            existing_directory(proof/label)
            completed[label]=completed_receipt(proof/label,manifest,summary)
    seal={'summaries':summaries,'completed':{label:sha(raw) for label,raw in completed.items()}}
    return root,seal,completed


async def submit_retry(db,who,parent_id,data):
    from .database_migration_jobs import public_task
    service=MigrationConnections(db)
    async with db.connection() as conn,conn.transaction():
        await lock_mutation_identity(conn,who)
        await require_connection_verification(conn,who)
        await conn.execute('SELECT pg_advisory_xact_lock(67132153)')
        parent=await(await conn.execute("SELECT * FROM tasks WHERE id=%s AND owner_id=%s AND kind='database.migration.prepare' FOR SHARE",(parent_id,who.id))).fetchone()
        if not parent:raise HTTPException(404,'未找到原迁移准备任务')
        intent={'kind':'database.migration.prepare','source_revision':parent['payload'].get('source_revision'),'runtime_binding':service.runtime_binding(),'retry_of':str(parent_id)}
        hashed=fingerprint(intent)
        prior=await(await conn.execute('SELECT * FROM tasks WHERE owner_id=%s AND request_id=%s',(who.id,data.request_id))).fetchone()
        if prior:
            if prior['kind']!='database.migration.prepare':raise HTTPException(409,'此请求编号已用于其他操作')
            if prior['payload'].get('_admission_cancelled'):return public_task(prior)
            if prior['fingerprint']!=hashed:raise HTTPException(409,'此请求编号已用于不同操作')
            return public_task(prior)
        if parent['status']!='failed':raise HTTPException(409,'只有失败的准备任务可以重试')
        source=await(await conn.execute('SELECT revision,password_ciphertext FROM database_migration_source WHERE singleton FOR SHARE')).fetchone()
        if not source or str(source['revision'])!=intent['source_revision']:raise HTTPException(409,'旧库配置已变化，请重新准备')
        if await(await conn.execute("SELECT 1 FROM tasks WHERE kind LIKE 'database.migration.%' AND status IN ('queued','running','cancel_requested') LIMIT 1")).fetchone():
            raise HTTPException(409,'已有迁移准备任务，请先核对原任务')
        previous=parent['payload'].get('_retry',{})
        archive_task=previous.get('archive_task',str(parent_id));archive_attempt=previous.get('archive_attempt',parent['attempts'])
        proof_task=str(parent_id);proof_attempt=parent['attempts']
        if previous:
            try:
                parent_folder=attempt_path(db.settings,parent_id,parent['attempts'])
                if (parent_folder/'rehearsal-cluster'/'postmaster.pid').exists():raise HTTPException(409,'原隔离实例尚未确认停止')
                has_proof=any((parent_folder/label/'restore-receipt.json').exists() for label in ('source','target'))
            except FileNotFoundError:has_proof=False
            except (BackupFailure,StreamFailure,OSError):raise HTTPException(422,'原重试目录不可用，请核对权限') from None
            if not has_proof:
                proof_task=previous['proof_task'];proof_attempt=previous['proof_attempt']
        origin=await(await conn.execute("SELECT payload,created_at FROM tasks WHERE id=%s AND owner_id=%s AND kind='database.migration.prepare' FOR SHARE",(UUID(archive_task),who.id))).fetchone()
        if not origin:raise HTTPException(409,'原归档不属于当前管理员')
        if await(await conn.execute("SELECT 1 FROM tasks WHERE owner_id=%s AND kind='database.migration.prepare' AND status='succeeded' AND payload->'_retry'->>'archive_task'=%s LIMIT 1",(who.id,archive_task))).fetchone():
            raise HTTPException(409,'原归档已恢复核对通过，请查看完成记录')
        try:
            identities={label:origin['payload']['_'+label+'_identity'] for label in ('source','target')}
            for name in ('pg_restore','initdb','pg_ctl','postgres'):tools(db.settings,name)
            _,seal,_=await asyncio.to_thread(sealed_state,db.settings,archive_task,archive_attempt,proof_task,proof_attempt,identities)
        except (BackupFailure,StreamFailure,OSError,KeyError,TypeError,ValueError):
            raise HTTPException(422,'原归档或已完成记录不可复用，请核对后重新准备') from None
        client='legacy-web' if getattr(who,'legacy_client',False) and not getattr(who,'legacy_platform',False) else 'new-web'
        intent.update(_session_hash=who.token_hash,_session_client=client,
            _vault_fingerprint=hashlib.sha256(Vault(db.settings.connection_secret_dir,read_only=True).key()).hexdigest() if source['password_ciphertext'] else None,
            _retry={'archive_task':archive_task,'archive_attempt':archive_attempt,'proof_task':proof_task,'proof_attempt':proof_attempt,
                    'archive_created_at':origin['created_at'].isoformat(),'identities':identities,'seal':seal})
        phase='target_restore' if 'source' in seal['completed'] else 'source_restore'
        result={'phase':phase,'progress':{'phase':phase,'processed':0,'total':None,'unit':'archive'},'business_written':False,'cutover_ready':False,'source_revision':intent['source_revision']}
        identifier=uuid4()
        row=await(await conn.execute("INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload,result) VALUES(%s,%s,%s,%s,'database.migration.prepare','queued',%s,%s) RETURNING *",
            (identifier,who.id,data.request_id,hashed,Jsonb(intent),Jsonb(result)))).fetchone()
        await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,%s)",(identifier,phase))
        await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'database-migration.preparation.retried',%s,%s)",(who.id,str(identifier),data.request_id))
        return public_task(row)


async def execute_retry(db,task):
    from .database_migration_jobs import guard,run_preparation
    await guard(db,task)
    settings=db.settings;retry=task['payload']['_retry']
    root=private_dir(private_dir(private_dir(settings.backup_dir)/'database-migrations')/str(task['id']))
    attempt=root/('attempt-'+str(task['attempts']))
    if attempt.exists():raise BackupFailure('此迁移尝试已存在，不能覆盖原归档')
    private_dir(attempt)
    budget=CaptureBudget(settings.backup_stream_max_bytes,settings.backup_stream_disk_reserve_bytes,settings.backup_stream_seconds,settings.backup_stream_max_objects)
    def restore(cancel,publish):
        archive,seal,completed=sealed_state(settings,retry['archive_task'],retry['archive_attempt'],retry['proof_task'],retry['proof_attempt'],retry['identities'],cancel=cancel,budget=budget)
        if seal!=retry['seal']:raise BackupFailure('原迁移归档或已完成记录已变化')
        restored=rehearse(settings,attempt,seal['summaries'],budget,cancel,publish,archive_root=archive,completed=completed)
        result={'phase':'awaiting_mapping','source':restored['source'],'target':restored['target'],'business_written':False,'cutover_ready':False,
            'build_sha':settings.source_revision or None,'software_version':__version__,'runtime_binding':task['payload']['runtime_binding'],
            'files_included':False,'source_revision':task['payload']['source_revision'],'archive_id':retry['archive_task'],'archive_attempt':retry['archive_attempt'],
            'attempt':task['attempts'],'resumed_from':task['payload']['retry_of'],'verified_proof_from':retry['proof_task'],'capture_reused':True,'archive_created_at':retry['archive_created_at'],'created_at':datetime.now(UTC).isoformat()}
        encoded=canonical(result);budget.object(attempt,cancel);budget.account(attempt,cancel,len(encoded));write_private(attempt/'receipt.json',encoded)
        for directory in (attempt,root,root.parent,settings.backup_dir):sync_directory(directory)
        return result
    await run_preparation(db,task,attempt,budget,restore)
