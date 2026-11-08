"""Migration-only source editor and bounded read-only probes. Never changes runtime PG."""
import asyncio
import hashlib
import hmac
import json
import re
import time
from datetime import UTC,datetime
from typing import Literal
from uuid import UUID,uuid4

import psycopg
from fastapi import HTTPException
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import SecretStr,Field,field_validator,model_validator

from .connection_models import PostgresConfig
from .connections import Connections,Vault,current_config
from .db import verify_identity
from .models import InputModel
from .security import lock_mutation_identity
from .connection_access import require_connection_verification
from . import __version__


class SourceConfig(PostgresConfig):
    username:str=Field(min_length=1,max_length=128)
    schema_name:str=Field(default='public',min_length=1,max_length=63)

    @field_validator('schema_name')
    @classmethod
    def schema_valid(cls,value):
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}',value) or value.startswith('pg_') or value=='information_schema':
            raise ValueError('Invalid source schema')
        return value


class SourceSave(InputModel):
    request_id:UUID
    expected_revision:UUID|None=None
    config:SourceConfig
    password_mode:Literal['keep','replace','clear']='keep'
    password:SecretStr|None=Field(default=None,max_length=1024)

    @model_validator(mode='after')
    def password_valid(self):
        if (self.password_mode=='replace')!=(self.password is not None):
            raise ValueError('Password replacement is incomplete')
        return self


class SourceTest(InputModel):
    revision:UUID


def fingerprint(data):
    return hashlib.sha256(json.dumps(data,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()


def source_view(row):
    return None if not row else {'revision':str(row['revision']),'config':row['config'],
                                'password_configured':bool(row['password_ciphertext']),'updated_at':row['updated_at'].isoformat()}


async def system_identifier(conn):
    try:
        async with conn.transaction():
            row=await(await conn.execute('SELECT system_identifier::text AS identity FROM pg_control_system()')).fetchone()
        return row['identity']
    except psycopg.errors.InsufficientPrivilege:
        return None


class MigrationConnections:
    def __init__(self,db):
        self.db=db
        self.vault=Vault(db.settings.connection_secret_dir)

    def runtime_binding(self):
        config,_=current_config(self.db.settings,'postgresql')
        return fingerprint({'instance':str(self.db.settings.instance_id),'config':config.model_dump(mode='json'),
                            'build':self.db.settings.source_revision,'software':__version__,'driver':psycopg.__version__,'format':'database-migration/1'})

    async def read(self,who):
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who)
            row=await(await conn.execute('SELECT * FROM database_migration_source WHERE singleton')).fetchone()
            checks={}
            for scope in ('source','target'):
                observed=await(await conn.execute('''SELECT result FROM database_migration_connection_observations
                    WHERE scope=%s AND runtime_binding=%s AND source_revision IS NOT DISTINCT FROM %s ORDER BY id DESC LIMIT 1''',
                    (scope,self.runtime_binding(),row['revision'] if scope=='source' and row else None))).fetchone()
                checks[scope]=observed['result'] if observed else None
        config,password=current_config(self.db.settings,'postgresql')
        return {'source':source_view(row),'target':{'config':config.model_dump(),'password_configured':bool(password),
                                                   'instance_id':str(self.db.settings.instance_id),'environment':self.db.settings.environment,'managed_by':'environment'},'checks':checks}

    async def save(self,who,data):
        # Bind the password hash to idempotency without ever saving or logging its plaintext.
        payload=data.model_dump(mode='json',exclude={'password'})
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who)
            await conn.execute('SELECT pg_advisory_xact_lock(67132153)')
            await require_connection_verification(conn,who)
            if data.password is not None:payload['password_binding']=hmac.new(self.vault.key(),data.password.get_secret_value().encode(),hashlib.sha256).hexdigest()
            hashed=fingerprint(payload)
            prior=await(await conn.execute('SELECT fingerprint,result FROM database_migration_source_operations WHERE actor_id=%s AND request_id=%s',(who.id,data.request_id))).fetchone()
            if prior:
                if prior['result'].get('state')=='cancelled':raise HTTPException(409,'此保存请求已取消，请重新编辑连接')
                if prior['fingerprint']!=hashed:raise HTTPException(409,'此请求编号已用于不同操作')
                return prior['result']
            row=await(await conn.execute('SELECT * FROM database_migration_source WHERE singleton FOR UPDATE')).fetchone()
            if (row['revision'] if row else None)!=data.expected_revision:raise HTTPException(409,'旧库配置已变化，请重新读取')
            config=data.config.model_dump(mode='json')
            # A different endpoint cannot accidentally inherit another database's password.
            if data.password_mode=='keep' and row and any(row['config'].get(k)!=config.get(k) for k in ('host','port','database','username')):
                raise HTTPException(422,'更换旧库地址或账号后请重新填写密码')
            encrypted=row['password_ciphertext'] if row else None
            if data.password_mode=='clear':encrypted=None
            elif data.password_mode=='replace':encrypted=self.vault.encrypt(data.password.get_secret_value(),'database-migration-source',self.db.settings.instance_id)
            revision=uuid4()
            saved=await(await conn.execute('''INSERT INTO database_migration_source(singleton,revision,config,password_ciphertext,updated_by)
                VALUES(true,%s,%s,%s,%s) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,config=excluded.config,
                password_ciphertext=excluded.password_ciphertext,updated_by=excluded.updated_by,updated_at=clock_timestamp() RETURNING *''',
                (revision,Jsonb(config),encrypted,who.id))).fetchone()
            result={'request_id':str(data.request_id),'source':source_view(saved)}
            await conn.execute('INSERT INTO database_migration_source_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,data.request_id,hashed,Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'database-migration.source.saved',%s,%s)",(who.id,str(revision),data.request_id))
            return result

    async def receipt(self,who,request_id):
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who)
            row=await(await conn.execute('SELECT result FROM database_migration_source_operations WHERE actor_id=%s AND request_id=%s',(who.id,request_id))).fetchone()
            if not row:raise HTTPException(404,'尚未查询到此请求的保存回执')
            return row['result']

    async def cancel_save(self,who,request_id):
        # A durable tombstone prevents a late HTTP request from saving after cancellation.
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who)
            await conn.execute('SELECT pg_advisory_xact_lock(67132153)')
            prior=await(await conn.execute('SELECT result FROM database_migration_source_operations WHERE actor_id=%s AND request_id=%s',(who.id,request_id))).fetchone()
            if prior:return prior['result']
            result={'request_id':str(request_id),'state':'cancelled'}
            await conn.execute('INSERT INTO database_migration_source_operations(actor_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,request_id,fingerprint(result),Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'database-migration.source.cancelled',%s,%s)",(who.id,str(request_id),request_id))
            return result

    async def test_source(self,who,revision):
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who)
            await require_connection_verification(conn,who)
            row=await(await conn.execute('SELECT * FROM database_migration_source WHERE singleton')).fetchone()
            if not row or row['revision']!=revision:raise HTTPException(409,'旧库配置已变化，请重新读取')
            config=SourceConfig.model_validate(row['config'])
            password=self.vault.decrypt(row['password_ciphertext'],'database-migration-source',self.db.settings.instance_id)
            target=await(await conn.execute("SELECT current_database() AS database,inet_server_addr()::text AS address,inet_server_port() AS port,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid")).fetchone()
            target['system_identifier']=await system_identifier(conn)
        failure=None
        try:result={**await self.probe(config,password,target),'revision':str(revision)}
        except HTTPException as error:
            failure=error
            result={'state':'failed','revision':str(revision),'observed_at':datetime.now(UTC).isoformat()}
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who)
            current=await(await conn.execute('SELECT revision FROM database_migration_source WHERE singleton FOR SHARE')).fetchone()
            if not current or current['revision']!=revision:raise HTTPException(409,'检查期间旧库配置已变化，请重新测试')
            await conn.execute('INSERT INTO database_migration_connection_observations(scope,source_revision,runtime_binding,actor_id,result) VALUES(\'source\',%s,%s,%s,%s)',(revision,self.runtime_binding(),who.id,Jsonb(result)))
        if failure:raise failure
        return result

    async def probe(self,config,password,target):
        started=time.monotonic()
        address=await Connections(self.db.settings,self.db,None).address(config)
        values=dict(host=config.host,port=config.port,dbname=config.database,user=config.username,password=password,sslmode=config.ssl_mode)
        if not config.host.startswith('/'):values['hostaddr']=address
        try:
            async with asyncio.timeout(12):
                async with await psycopg.AsyncConnection.connect(make_conninfo(**values),autocommit=True,row_factory=dict_row,connect_timeout=config.connect_timeout,
                    options='-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000 -c search_path=pg_catalog') as conn:
                    await conn.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
                    actual=await(await conn.execute("SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS address,inet_server_port() AS port,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,current_setting('server_version') AS version,current_setting('transaction_read_only') AS readonly")).fetchone()
                    actual['system_identifier']=await system_identifier(conn)
                    if actual['database']!=config.database or actual['role']!=config.username or actual['readonly']!='on':raise HTTPException(409,'旧库身份与填写的连接不一致')
                    if all(actual[k]==target[k] for k in ('database','address','port','oid')):raise HTTPException(409,'旧库和新库不能是同一个数据库')
                    if actual['system_identifier'] and target['system_identifier'] and actual['system_identifier']==target['system_identifier'] and actual['oid']==target['oid']:
                        raise HTTPException(409,'旧库和新库不能是同一个数据库')
                    marker=await(await conn.execute("SELECT to_regclass('public.alcor_instance') AS relation")).fetchone()
                    if marker['relation']:
                        async with conn.transaction():
                            try:
                                platform=await(await conn.execute('SELECT instance_id FROM public.alcor_instance WHERE singleton')).fetchone()
                                if platform and str(platform['instance_id'])==str(self.db.settings.instance_id):raise HTTPException(409,'旧库和新库不能使用同一平台实例')
                            except psycopg.errors.InsufficientPrivilege:
                                raise HTTPException(422,'无法核对旧库的平台身份，请核对读取权限') from None
                    exists=await(await conn.execute('SELECT has_schema_privilege(current_user,oid,\'USAGE\') AS allowed FROM pg_namespace WHERE nspname=%s',(config.schema_name,))).fetchone()
                    if not exists or not exists['allowed']:raise HTTPException(422,'旧库 Schema 不存在或没有读取权限')
                    tables=await(await conn.execute("SELECT c.relname AS name,has_table_privilege(current_user,c.oid,'SELECT') AS readable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=%s AND c.relkind IN ('r','p') ORDER BY c.relname",(config.schema_name,))).fetchall()
                    if not tables:raise HTTPException(422,'旧库 Schema 中没有数据表')
                    if any(not t['readable'] for t in tables):raise HTTPException(422,'旧库存在无法读取的数据表')
                    await conn.execute(sql.SQL('SELECT 1 FROM {} LIMIT 1').format(sql.Identifier(config.schema_name,tables[0]['name'])))
                    await conn.execute('ROLLBACK')
            return {'state':'connected','observed_at':datetime.now(UTC).isoformat(),'response_ms':round((time.monotonic()-started)*1000),
                    'database':actual['database'],'schema':config.schema_name,'server_version':actual['version'],'table_count':len(tables),'read_only':True,
                    'persistent_identity_verified':bool(actual['system_identifier']),
                    'identity_fingerprint':fingerprint({k:actual[k] for k in ('database','address','port','oid','role','system_identifier')}|{'schema':config.schema_name})}
        except (psycopg.Error,OSError,TimeoutError):
            raise HTTPException(422,'旧库连接失败，请核对地址、账号、密码和读取权限') from None

    async def test_target(self,who):
        started=time.monotonic()
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who)
            await verify_identity(conn,self.db.settings)
            actual=await(await conn.execute("SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS address,inet_server_port() AS port,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,current_setting('server_version') AS server_version")).fetchone()
            actual['system_identifier']=await system_identifier(conn)
            result={'database':actual['database'],'server_version':actual['server_version'],'state':'connected','observed_at':datetime.now(UTC).isoformat(),
                    'response_ms':round((time.monotonic()-started)*1000),'instance_id':str(self.db.settings.instance_id),
                    'persistent_identity_verified':bool(actual['system_identifier']),
                    'identity_fingerprint':fingerprint({k:actual[k] for k in ('database','address','port','oid','role','system_identifier')}|{'schema':'public'})}
            await conn.execute('INSERT INTO database_migration_connection_observations(scope,runtime_binding,actor_id,result) VALUES(\'target\',%s,%s,%s)',(self.runtime_binding(),who.id,Jsonb(result)))
        return result
