"""One resumable migration command: backup, history, originals, personal data, identity."""
import asyncio
import json
import threading
from uuid import UUID

from psycopg.types.json import Jsonb

from .backups import BackupFailure,private_dir,private_read,write_private
from .database_migration_capture import CaptureBudget,canonical,capture_database,file_sha,sha
from .database_migration_connections import MigrationConnections
from .database_migration_jobs import guard,public_task
from .database_migration_portfolio import read_plan,source_connection,complete_on_connection
from .database_migration_retry import attempt_path
from .database_migration_transform import FrozenTables
from .security import Identity


async def submit(db,who,conversion_id,data):
    from .database_migration_history import submit as enqueue
    # Required media/key inputs are validated again by the worker. Admission is
    # kept on the same explicit, recent administrator proof as other migration writes.
    return await enqueue(db,who,conversion_id,data,kind='database.migration.complete')


async def committed(db,task):
    async with db.connection() as conn,conn.transaction():
        current=await(await conn.execute('SELECT * FROM tasks WHERE id=%s FOR UPDATE',(task['id'],))).fetchone()
        row=await(await conn.execute('SELECT fingerprint,result FROM database_migration_completion_imports WHERE owner_id=%s AND request_id=%s',(task['owner_id'],task['request_id']))).fetchone()
        if row:
            if not current or current['fingerprint']!=task['fingerprint'] or row['fingerprint']!=task['fingerprint'] or current['owner_id']!=task['owner_id']:raise BackupFailure('原迁移请求不一致')
            if current['status']!='succeeded':await complete_on_connection(conn,task,row['result'])
            return row['result']


async def incomplete(db,task,message):
    """Failure is separate from committed domain checkpoints, including UI state."""
    async with db.connection() as conn:
        current=await(await conn.execute('SELECT result FROM tasks WHERE id=%s AND owner_id=%s',(task['id'],task['owner_id']))).fetchone()
        result=(current or {}).get('result') or {}
        history=await(await conn.execute('SELECT 1 FROM database_migration_history_imports WHERE owner_id=%s AND conversion_id=%s',(task['owner_id'],UUID(task['payload']['conversion_id'])))).fetchone()
        assets=await(await conn.execute('SELECT 1 FROM database_migration_asset_imports WHERE task_id=%s LIMIT 1',(task['id'],))).fetchone()
    domains=list(dict.fromkeys([*result.get('completed_domains',[]),*(['orders','cash','pnl'] if history else [])]))
    return {'phase':'completion_incomplete','failed_phase':result.get('phase'),'progress':result.get('progress'),
            'business_written':bool(history or assets),'history_imported':bool(history),'completed_domains':domains,
            'cutover_ready':False,'message':message,'completed_stages_retained':True}


async def backup_target(db,task):
    settings=db.settings
    root=private_dir(private_dir(private_dir(settings.backup_dir)/'database-migration-cutovers')/str(task['id']))
    receipt=root/'backup-receipt.json'
    if receipt.exists():
        value=json.loads(private_read(receipt,1024**2))
        if value.get('instance_id')!=str(settings.instance_id) or value.get('archive_sha256')!=await asyncio.to_thread(file_sha,root/'target/database.dump',threading.Event()):raise BackupFailure('迁移前的新库备份已变化')
        return value
    if (root/'target').exists():
        # Never overwrite a partially written archive. Keep it and make a new,
        # explicit worker attempt folder without repeating completed imports.
        # Reuse the same successful attempt if the worker is resumed after its
        # backup finished. A partial attempt is never overwritten.
        candidate=private_dir(root/('attempt-'+str(task['attempts'])))
        if (candidate/'backup-receipt.json').exists():
            value=json.loads(private_read(candidate/'backup-receipt.json',1024**2))
            if value.get('instance_id')!=str(settings.instance_id) or value.get('archive_sha256')!=await asyncio.to_thread(file_sha,candidate/'target/database.dump',threading.Event()):raise BackupFailure('迁移前的新库备份已变化')
            return value
        root=candidate
        receipt=root/'backup-receipt.json'
    budget=CaptureBudget(settings.backup_stream_max_bytes,settings.backup_stream_disk_reserve_bytes,settings.backup_stream_seconds,settings.backup_stream_max_objects)
    cancel=threading.Event();loop=asyncio.get_running_loop();events=asyncio.Queue()
    def progress(value):loop.call_soon_threadsafe(events.put_nowait,value)
    work=asyncio.create_task(asyncio.to_thread(capture_database,settings,settings.database_url.get_secret_value(),root,'target',budget,cancel,progress,expected_identity=task['payload']['_archive']['identities']['target'],schema='public'))
    try:
        while not work.done():
            await asyncio.wait({work},timeout=.5)
            latest=None
            while not events.empty():latest=events.get_nowait()
            await guard(db,task,{'phase':'completion_backup','processed':latest.get('processed',0) if latest else 0,'total':latest.get('total') if latest else None,'unit':latest.get('unit') if latest else 'archive'})
        value=await work
    except BaseException:
        cancel.set();await asyncio.shield(asyncio.gather(work,return_exceptions=True));raise
    from .connections import Vault
    # The database references encrypted identity material. Retain its original
    # Vault key next to this owner-only recovery archive, never in task output.
    write_private(root/'target-vault.key',Vault(settings.connection_secret_dir,read_only=True).key())
    value.update(instance_id=str(settings.instance_id),scope='before_identity_cutover',private_files_retained=True,vault_key_retained=True)
    write_private(receipt,canonical(value));return value


async def execute(db,task):
    if await committed(db,task):return
    source=await guard(db,task)
    async with db.connection() as conn:
        conversion=await(await conn.execute("SELECT * FROM tasks WHERE id=%s AND owner_id=%s AND kind='database.migration.convert'",(UUID(task['payload']['conversion_id']),task['owner_id']))).fetchone()
        imported=await(await conn.execute('SELECT * FROM database_migration_portfolio_imports WHERE owner_id=%s AND conversion_id=%s',(task['owner_id'],UUID(task['payload']['conversion_id'])))).fetchone()
        actor=await(await conn.execute('SELECT u.id,u.username,u.role,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=%s AND s.token_hash=%s',(task['owner_id'],task['payload']['_session_hash']))).fetchone()
    if not conversion or not imported or not actor:raise BackupFailure('原转换、持仓导入或授权不存在')
    who=Identity(**actor,token_hash=task['payload']['_session_hash'],csrf='')
    if task['payload']['_session_client']=='legacy-web':who.legacy_client=True
    plan=await asyncio.to_thread(read_plan,db.settings,conversion)
    if conversion['result']['plan_sha256']!=task['payload']['plan_sha256']:raise BackupFailure('转换计划已变化')
    root=attempt_path(db.settings,task['payload']['_archive']['archive_task'],task['payload']['_archive']['archive_attempt'])/'source'
    raw=private_read(root/'manifest.json',16*1024**2)
    if sha(raw)!=plan['source_manifest_sha256']:raise BackupFailure('原归档清单已变化')
    manifest=json.loads(raw);frozen=FrozenTables(root,manifest,threading.Event(),CaptureBudget(256*1024**2,0,600))
    from .database_migration_assets import input_manifest
    from .database_migration_identity import validated
    inputs,_,_=input_manifest(db.settings,plan)
    if len(private_read(inputs/'source-data.key',128))!=32:raise BackupFailure('原身份密钥不可用')
    schema=plan['portfolio']['source_schema']
    personal_tables=('user_settings','activities','card_holdings','custom_cards','price_alert_rules','feed_groups','feed_preferences','feed_group_preferences','feed_posts','feed_messages')
    for name in ('assets','users','personal_profiles','passkeys','passkey_config',*personal_tables):frozen.rows(schema,name)
    # Decryption and RP binding are checked before writing any new domain.
    identity_values={name:[row for row in frozen.rows(schema,name) if name=='passkey_config' or str(row.get('id' if name=='users' else 'user_id'))==plan['source_owner']]
        for name in ('users','personal_profiles','passkeys','passkey_config','verified_emails')}
    validated(db.settings,plan,identity_values)
    names=set(plan['raw_snapshot']['tables'])|{'watch_groups','assets','personal_profiles',*personal_tables}
    guarded={**plan['portfolio'],'source_tables':[{key:t[key] for key in ('schema','name','rows','multiset_sha256')} for t in manifest['tables'] if t['schema']==schema and t['name'] in names]}
    old=await source_connection(db,task,source,guarded)
    try:
        backup=await backup_target(db,task)
        from .database_migration_history import execute as import_history,packet
        async with db.connection() as conn:
            previous=await(await conn.execute('SELECT originals,result FROM database_migration_history_imports WHERE owner_id=%s AND source_instance=%s AND source_owner=%s',(who.id,plan['portfolio']['source_instance'],plan['source_owner']))).fetchone()
        if previous:
            if previous['originals']!=packet(plan,imported['result']):raise BackupFailure('已迁入历史与本次来源不一致')
            history=previous['result']
        else:
            await import_history(db,task,finalize=False)
            async with db.connection() as conn:history=(await(await conn.execute('SELECT result FROM database_migration_history_imports WHERE owner_id=%s AND request_id=%s',(who.id,task['request_id']))).fetchone())['result']
        from .database_migration_assets import execute as import_assets
        assets=await import_assets(db,task,who,plan,frozen)
        from .database_migration_personal import execute as import_personal
        personal=await import_personal(db,task,who,plan,frozen)
        await guard(db,task,{'phase':'completion_identity','processed':0,'total':1,'unit':'accounts','business_written':True,'completed_domains':['accounts','positions','orders','cash','pnl','assets']})
        from .database_migration_identity import execute as import_identity
        await import_identity(db,task,who,plan,frozen,old,{'history':history,'assets':assets,'personal':personal},backup)
    finally:await old.rollback();await old.close()
