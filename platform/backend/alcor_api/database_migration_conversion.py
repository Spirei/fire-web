"""Explicit asynchronous conversion plans bound to a verified preparation and owner."""
import asyncio
import hashlib
import json
import threading
from datetime import UTC,datetime
from uuid import UUID,uuid4
from zoneinfo import ZoneInfo,ZoneInfoNotFoundError

from fastapi import HTTPException
from pydantic import Field,field_validator
from psycopg.types.json import Jsonb

from .backups import BackupFailure,private_dir,private_read,write_private
from .connection_access import require_connection_verification
from .connections import Vault
from .database_migration_connections import MigrationConnections,fingerprint
from .database_migration_capture import CaptureBudget,canonical,sha,sync_directory
from .database_migration_jobs import guard,run_preparation,public_task
from .database_migration_retry import attempt_path,sealed_state
from .database_migration_transform import FrozenTables,transform
from .models import InputModel
from .security import lock_mutation_identity


class ConversionInput(InputModel):
    request_id:UUID
    source_owner:str=Field(min_length=1,max_length=128)
    timezone:str=Field(min_length=1,max_length=80)
    account_kinds:dict[str,str]=Field(default_factory=dict,max_length=100)
    broker_labels:dict[str,str]=Field(default_factory=dict,max_length=100)
    order_accounts:dict[str,str]=Field(default_factory=dict,max_length=20000)
    market_accounts:dict[str,str]=Field(default_factory=dict,max_length=8)
    @field_validator('timezone')
    @classmethod
    def known_timezone(cls,value):
        try:ZoneInfo(value)
        except (ValueError,ZoneInfoNotFoundError):raise ValueError('来源时区无效') from None
        return value
    @field_validator('account_kinds')
    @classmethod
    def kinds(cls,value):
        if any(not 1<=len(key)<=128 or item not in ('real','simulated') for key,item in value.items()):raise ValueError('账户分类无效')
        return value
    @field_validator('broker_labels','market_accounts','order_accounts')
    @classmethod
    def labels(cls,value):
        if any(not 1<=len(key)<=100 or not 1<=len(item)<=128 for key,item in value.items()):raise ValueError('原券商映射无效')
        return value


async def parent_on_connection(conn,who,parent_id):
    parent=await(await conn.execute("SELECT * FROM tasks WHERE id=%s AND owner_id=%s AND kind='database.migration.prepare' FOR SHARE",(parent_id,who.id))).fetchone()
    if not parent:raise HTTPException(404,'原迁移准备记录不存在')
    result=parent['result'] or {}
    if parent['status']!='succeeded' or result.get('phase')!='awaiting_mapping' or not all(result.get(label,{}).get('restore_verified') is True for label in ('source','target')):
        raise HTTPException(409,'须先完成双库恢复核对')
    origin_id=parent['payload'].get('_retry',{}).get('archive_task',str(parent_id))
    origin=await(await conn.execute("SELECT * FROM tasks WHERE id=%s AND owner_id=%s AND kind='database.migration.prepare' FOR SHARE",(UUID(origin_id),who.id))).fetchone()
    if not origin:raise HTTPException(409,'原归档记录不属于当前管理员')
    return parent,origin


def binding(parent,origin):
    retry=parent['payload'].get('_retry',{})
    return {'archive_task':str(origin['id']),'archive_attempt':retry.get('archive_attempt',origin['attempts']),
        'proof_task':str(parent['id']),'proof_attempt':parent['attempts'],
        'identities':{label:origin['payload']['_'+label+'_identity'] for label in ('source','target')}}


async def context(db,who,parent_id):
    async with db.connection() as conn,conn.transaction():
        await lock_mutation_identity(conn,who)
        parent,origin=await parent_on_connection(conn,who,parent_id)
        bound=binding(parent,origin)
        root=attempt_path(db.settings,bound['archive_task'],bound['archive_attempt'])/'source'
        manifest=json.loads(private_read(root/'manifest.json',16*1024**2));cancel=threading.Event()
        tables=FrozenTables(root,manifest,cancel,CaptureBudget(64*1024**2,0,30))
        schema=manifest['selected_schema']
        users=[{'id':str(row['id']),'username':row['username']} for row in tables.rows(schema,'users')]
        accounts=[{'id':str(row['id']),'owner_id':str(row['user_id']),'name':row['name'],'kind':row.get('account_kind') if row.get('account_kind') in ('real','simulated') else None} for row in tables.rows(schema,'broker_accounts')]
        labels={}
        for row in tables.rows(schema,'trade_orders'):
            key=str(row.get('broker') or '')
            if key:labels[key]=labels.get(key,0)+1
        conversions=await(await conn.execute("SELECT * FROM tasks WHERE owner_id=%s AND kind='database.migration.convert' AND payload->>'preparation_id'=%s ORDER BY created_at DESC,id DESC LIMIT 10",(who.id,str(parent_id)))).fetchall()
        imports=await(await conn.execute("SELECT * FROM tasks WHERE owner_id=%s AND kind='database.migration.portfolio' AND payload->>'preparation_id'=%s ORDER BY created_at DESC,id DESC LIMIT 20",(who.id,str(parent_id)))).fetchall()
        history=await(await conn.execute("SELECT * FROM tasks WHERE owner_id=%s AND kind IN ('database.migration.history','database.migration.complete') AND payload->>'preparation_id'=%s ORDER BY created_at DESC,id DESC LIMIT 20",(who.id,str(parent_id)))).fetchall()
        previous=await(await conn.execute("""SELECT payload FROM tasks WHERE owner_id=%s AND kind='database.migration.convert'
            AND payload->>'source_revision'=%s AND status='succeeded' ORDER BY created_at DESC,id DESC LIMIT 1""",
            (who.id,parent['payload']['source_revision']))).fetchone()
        previous_input={key:previous['payload'].get(key) for key in ('source_owner','account_kinds','broker_labels','market_accounts','order_accounts')} if previous else None
        existing=await(await conn.execute("""SELECT p.*,c.request_id AS conversion_request,i.request_id AS portfolio_request,
            (SELECT h.request_id FROM tasks h WHERE h.owner_id=i.owner_id AND h.kind IN ('database.migration.history','database.migration.complete')
             AND h.payload->>'conversion_id'=c.id::text ORDER BY h.created_at DESC,h.id DESC LIMIT 1) AS history_request
            FROM tasks i JOIN tasks c ON c.owner_id=i.owner_id AND c.id::text=i.payload->>'conversion_id'
            JOIN tasks p ON p.owner_id=i.owner_id AND p.id::text=c.payload->>'preparation_id'
            WHERE i.owner_id=%s AND i.kind='database.migration.portfolio' AND i.status='succeeded' AND i.result->>'business_written'='true'
            AND c.payload->'_archive'->'identities'->>'source'=%s ORDER BY i.created_at DESC,i.id DESC LIMIT 1""",
            (who.id,bound['identities']['source']))).fetchone()
        resume={'preparation':public_task(existing)|{'has_imports':True},'conversion_request_id':str(existing['conversion_request']),'portfolio_request_id':str(existing['portfolio_request']),
                'history_request_id':str(existing['history_request']) if existing['history_request'] else None} if existing else None
        return {'resume':resume,'previous_input':previous_input,'history_imports':[public_task(row) for row in history],'imports':[public_task(row) for row in imports],'preparation_id':str(parent_id),'users':users,'accounts':accounts,'broker_labels':[{'label':key,'rows':value} for key,value in sorted(labels.items())],
            'orders':[{'id':str(row['id']),'owner_id':str(row['user_id']),'market':row['market'],'code':row['code'],'name':row['name'],'broker':row.get('broker') or ''} for row in tables.rows(schema,'trade_orders')],
            'items':[public_task(row)|{'input':{key:row['payload'].get(key) for key in ('source_owner','account_kinds','broker_labels','market_accounts','order_accounts','timezone')}} for row in conversions]}


async def submit(db,who,parent_id,data):
    service=MigrationConnections(db)
    intent={'kind':'database.migration.convert','preparation_id':str(parent_id),**data.model_dump(mode='json',exclude={'request_id'}),'runtime_binding':service.runtime_binding()}
    hashed=fingerprint(intent)
    async with db.connection() as conn,conn.transaction():
        await lock_mutation_identity(conn,who);await require_connection_verification(conn,who)
        await conn.execute('SELECT pg_advisory_xact_lock(67132153)')
        prior=await(await conn.execute('SELECT * FROM tasks WHERE owner_id=%s AND request_id=%s',(who.id,data.request_id))).fetchone()
        if prior:
            if prior['kind']=='database.migration.convert' and prior['payload'].get('_admission_cancelled'):return public_task(prior)
            if prior['fingerprint']!=hashed:raise HTTPException(409,'原请求编号已用于其他操作')
            return public_task(prior)
        parent,origin=await parent_on_connection(conn,who,parent_id)
        source=await(await conn.execute('SELECT revision,password_ciphertext FROM database_migration_source WHERE singleton FOR SHARE')).fetchone()
        if not source or str(source['revision'])!=parent['payload']['source_revision']:raise HTTPException(409,'旧库配置已变化，请重新核对来源')
        if await(await conn.execute("SELECT 1 FROM tasks WHERE kind LIKE 'database.migration.%' AND status IN ('queued','running','cancel_requested') LIMIT 1")).fetchone():raise HTTPException(409,'已有迁移任务正在执行，请核对原任务')
        bound=binding(parent,origin)
        try:
            _,seal,completed=await asyncio.to_thread(sealed_state,db.settings,**bound)
            if set(completed)!={'source','target'}:raise BackupFailure('双库恢复结果不完整')
        except (BackupFailure,OSError,KeyError,TypeError,ValueError):raise HTTPException(422,'原归档或双库恢复结果已变化') from None
        intent.update(source_revision=str(source['revision']),_archive=bound|{'seal':seal},_session_hash=who.token_hash,
            _session_client='legacy-web' if getattr(who,'legacy_client',False) and not getattr(who,'legacy_platform',False) else 'new-web',
            _vault_fingerprint=hashlib.sha256(Vault(db.settings.connection_secret_dir,read_only=True).key()).hexdigest() if source['password_ciphertext'] else None)
        row=await(await conn.execute("INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,payload) VALUES(%s,%s,%s,%s,'database.migration.convert','queued',%s) RETURNING *",(uuid4(),who.id,data.request_id,hashed,Jsonb(intent)))).fetchone()
        await conn.execute("INSERT INTO task_events(task_id,phase) VALUES(%s,'queued')",(row['id'],))
        await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'database-migration.conversion.submitted',%s,%s)",(who.id,str(row['id']),data.request_id))
        return public_task(row)


async def execute(db,task):
    await guard(db,task)
    settings=db.settings;bound=task['payload']['_archive'];source=task['payload']
    root=private_dir(private_dir(private_dir(settings.backup_dir)/'database-migration-conversions')/str(task['id']))
    folder=root/('attempt-'+str(task['attempts']));private_dir(folder)
    budget=CaptureBudget(settings.backup_stream_max_bytes,settings.backup_stream_disk_reserve_bytes,settings.backup_stream_seconds,settings.backup_stream_max_objects)
    def convert(cancel,publish):
        publish({'phase':'conversion_verify','processed':0,'total':None,'unit':'archives'})
        archive,seal,completed=sealed_state(settings,**{key:value for key,value in bound.items() if key!='seal'},cancel=cancel,budget=budget)
        if seal!=bound['seal'] or set(completed)!={'source','target'}:raise BackupFailure('原归档或恢复结果已变化')
        manifest=json.loads(private_read(archive/'source'/'manifest.json',16*1024**2))
        tables=FrozenTables(archive/'source',manifest,cancel,budget)
        plan=transform(tables,source_owner=source['source_owner'],account_kinds=source['account_kinds'],broker_labels=source['broker_labels'],market_accounts=source['market_accounts'],order_accounts=source['order_accounts'],timezone=source['timezone'],publish=publish)
        raw=canonical(plan);budget.object(folder,cancel);budget.account(folder,cancel,len(raw));write_private(folder/'conversion-plan.json',raw)
        result={'phase':'conversion_requires_review','source_revision':source['source_revision'],'business_written':False,'cutover_ready':False,
            'preparation_id':source['preparation_id'],'plan_sha256':sha(raw),'domains':plan['domains'],'issue_counts':plan['issue_counts'],'portfolio_ready':plan['portfolio']['ready'],'portfolio_issues':plan['portfolio']['issues'],
            'source_owner':source['source_owner'],'account_kinds':source['account_kinds'],'broker_labels':source['broker_labels'],'market_accounts':source['market_accounts'],'order_accounts':source['order_accounts'],
            'created_at':datetime.now(UTC).isoformat(),'build_sha':settings.source_revision or None}
        write_private(folder/'receipt.json',canonical(result));sync_directory(folder);return result
    await run_preparation(db,task,folder,budget,convert)
