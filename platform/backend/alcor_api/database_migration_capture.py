"""Consistent operator PG archives and exact row sidecars. No restore or business writes."""
import hashlib
import json
import os
import subprocess
import time
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from .backups import BackupFailure,command_env,private_dir,tools,write_private
from . import __version__


class CaptureBudget:
    def __init__(self,maximum,reserve,seconds,objects=10000):
        self.maximum=maximum;self.reserve=reserve;self.deadline=time.monotonic()+seconds;self.used=0
        self.max_objects=objects;self.objects=0

    def check(self,root,cancel,additional=0):
        import shutil
        if cancel.is_set():raise BackupFailure('迁移准备已停止')
        if time.monotonic()>self.deadline:raise BackupFailure('迁移准备超过执行时间预算')
        if additional<0 or self.used+additional>self.maximum:raise BackupFailure('迁移备份超过容量预算')
        if shutil.disk_usage(root).free<self.reserve+additional:raise BackupFailure('可用空间不足以完成迁移备份')

    def account(self,root,cancel,size):
        self.check(root,cancel,size);self.used+=size

    def object(self,root,cancel):
        self.check(root,cancel)
        if self.objects>=self.max_objects:raise BackupFailure('迁移备份的文件数量超过预算')
        self.objects+=1


def canonical(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def sha(raw):return hashlib.sha256(raw).hexdigest()


def sync_directory(path):
    descriptor=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)


def file_sha(path,cancel):
    hashed=hashlib.sha256()
    with path.open('rb') as stream:
        while block:=stream.read(1024*1024):
            if cancel.is_set():raise BackupFailure('迁移准备已停止')
            hashed.update(block)
    return hashed.hexdigest()


def command(settings,name,args,dsn,folder,budget,cancel,output=None):
    env=command_env(dsn,folder)
    env['PGOPTIONS']='-c default_transaction_read_only=on -c timezone=UTC'
    process=subprocess.Popen([tools(settings,name),*args],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,umask=0o077)
    try:
        while process.poll() is None:
            budget.check(folder,cancel,output.stat().st_size if output and output.exists() else 0)
            time.sleep(.2)
        if process.returncode:raise BackupFailure('PostgreSQL归档或校验失败，请核对工具版本和来源权限')
        if output:budget.account(folder,cancel,output.stat().st_size)
    finally:
        if process.poll() is None:
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)


def _capture_database(settings,dsn,root,label,budget,cancel,progress,*,expected_identity=None,schema=None):
    """Full database, not merely the selected business schema. Files stay server-private."""
    folder=private_dir(root/label)
    rows_folder=private_dir(folder/'rows')
    with psycopg.connect(dsn,connect_timeout=5,row_factory=dict_row,options='-c default_transaction_read_only=on -c timezone=UTC -c search_path=pg_catalog -c bytea_output=hex -c extra_float_digits=3 -c statement_timeout=30000 -c lock_timeout=5000') as connection:
        connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        actual=connection.execute("SELECT current_database() AS database,current_user AS role,inet_server_addr()::text AS address,inet_server_port() AS port,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,current_setting('server_version') AS version,current_setting('server_encoding') AS encoding,system_identifier::text AS system_identifier FROM pg_control_system()").fetchone()
        if actual['encoding']!='UTF8':raise BackupFailure('迁移来源须使用UTF8编码')
        if expected_identity and sha(canonical({k:actual[k] for k in ('database','address','port','oid','role','system_identifier')}|{'schema':schema}))!=expected_identity:
            raise BackupFailure(('旧库' if label=='source' else '新库')+'身份已变化，请重新测试连接')
        tables=connection.execute("SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname").fetchall()
        if not tables or len(tables)>2000:raise BackupFailure('数据表范围为空或超过本次迁移预算')
        if schema and not any(t['schema']==schema for t in tables):raise BackupFailure('旧库Schema已变化，请重新测试连接')
        connection.execute(sql.SQL('LOCK TABLE {} IN ACCESS SHARE MODE').format(sql.SQL(',').join(sql.Identifier(t['schema'],t['name']) for t in tables)))
        snapshot=connection.execute('SELECT pg_export_snapshot() AS snapshot').fetchone()['snapshot']
        progress({'phase':label+'_archive','processed':0,'total':None,'unit':'archive'})
        archive=folder/'database.dump'
        budget.object(folder,cancel)
        command(settings,'pg_dump',['--no-password','--format=custom','--lock-wait-timeout=5000','--snapshot='+snapshot,'--file='+str(archive)],dsn,folder,budget,cancel,archive)
        schema_file=folder/'schema.sql'
        budget.object(folder,cancel)
        command(settings,'pg_dump',['--no-password','--schema-only','--lock-wait-timeout=5000','--snapshot='+snapshot,'--file='+str(schema_file)],dsn,folder,budget,cancel,schema_file)
        inventory=[]
        progress({'phase':label+'_rows','processed':0,'total':len(tables),'unit':'tables'})
        for table in tables:
            budget.check(folder,cancel)
            key=sha(json.dumps([table['schema'],table['name']],ensure_ascii=False,separators=(',',':')).encode())
            path=rows_folder/(key+'.jsonl');hashes=[]
            budget.object(folder,cancel)
            descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(descriptor,'wb') as output,connection.cursor(name='migration_'+key[:24]) as cursor:
                cursor.execute(sql.SQL('SELECT row_to_json(t)::text AS value FROM ONLY {} t').format(sql.Identifier(table['schema'],table['name'])))
                while batch:=cursor.fetchmany(256):
                    for row in batch:
                        raw=row['value'].encode()
                        if len(raw)>16*1024**2 or len(hashes)>=500000:raise BackupFailure('来源表需要分段迁移')
                        budget.account(folder,cancel,len(raw)+1)
                        output.write(raw+b'\n');hashes.append(hashlib.sha256(raw).digest())
                output.flush();os.fsync(output.fileno())
            inventory.append({**table,'file':'rows/'+path.name,'rows':len(hashes),'file_sha256':file_sha(path,cancel),'multiset_sha256':sha(b''.join(sorted(hashes)))})
            progress({'phase':label+'_rows','processed':len(inventory),'total':len(tables),'unit':'tables'})
    progress({'phase':label+'_verify','processed':0,'total':None,'unit':'archive'})
    command(settings,'pg_restore',['--file=/dev/null',str(archive)],dsn,folder,budget,cancel)
    # The temporary passfile is not a recoverable original and must never enter an archive.
    manifest={'format':'database-migration-snapshot/1','scope':'preparation_not_final_cutover','identity':actual,'selected_schema':schema,
              'build_sha':settings.source_revision or None,'software_version':__version__,'driver_version':psycopg.__version__,
              'snapshot':snapshot,'archive':{'sha256':file_sha(archive,cancel),'bytes':archive.stat().st_size,'integrity_verified':True,'restore_verified':False},
              'schema_sha256':file_sha(schema_file,cancel),'tables':inventory,'business_written':False,'files_included':False}
    encoded=canonical(manifest)
    budget.object(folder,cancel)
    budget.account(folder,cancel,len(encoded));write_private(folder/'manifest.json',encoded)
    for path in (archive,schema_file):
        descriptor=os.open(path,os.O_RDWR|os.O_NOFOLLOW)
        try:os.fsync(descriptor)
        finally:os.close(descriptor)
    sync_directory(rows_folder);sync_directory(folder)
    progress({'phase':label+'_verify','processed':1,'total':1,'unit':'archive'})
    return {'tables':len(tables),'rows':sum(t['rows'] for t in inventory),'archive_sha256':manifest['archive']['sha256'],'manifest_sha256':sha(encoded),
            'archive_integrity_verified':True,'restore_verified':False,'files_included':False,'bytes':manifest['archive']['bytes']}


def capture_database(settings,dsn,root,label,budget,cancel,progress,**kwargs):
    if label not in ('source','target'):raise BackupFailure('迁移归档范围无效')
    try:
        budget.check(root,cancel)
        return _capture_database(settings,dsn,root,label,budget,cancel,progress,**kwargs)
    finally:(root/label/'pgpass').unlink(missing_ok=True)
