"""Restore sealed archives into a socket-only disposable cluster as an ordinary PG role."""
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo

from .backups import BackupFailure,private_read,tools,write_private
from .database_migration_capture import canonical,file_sha,sha,sync_directory

ROLE='migration_restore'
ADMIN='migration_local_admin'


def run(settings,name,args,env,root,budget,cancel,*,data=None):
    process=subprocess.Popen([tools(settings,name),*args],env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,umask=0o077)
    try:
        while process.poll() is None:
            budget.check(root,cancel)
            if data:
                count=0;size=0
                for parent,dirs,files in os.walk(data,followlinks=False):
                    for entry in dirs+files:
                        path=Path(parent)/entry
                        if path.is_symlink():raise BackupFailure('隔离演练目录包含意外的符号链接')
                    for entry in files:
                        try:
                            current_size=(Path(parent)/entry).stat().st_size
                        except FileNotFoundError:
                            # PostgreSQL can rename or remove temporary files during a scan.
                            continue
                        size+=current_size;count+=1
                        if size+budget.used>budget.maximum or count>50000:raise BackupFailure('隔离演练超过存储预算')
            time.sleep(.25)
        if process.returncode:raise BackupFailure('隔离恢复失败，请核对归档、工具版本和结构权限')
    finally:
        if process.poll() is None:
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)


def verify_manifest(root,label,summary,cancel):
    folder=root/label
    raw=private_read(folder/'manifest.json',16*1024**2)
    if sha(raw)!=summary['manifest_sha256']:raise BackupFailure('原迁移清单已变化')
    value=json.loads(raw)
    if value['scope']!='preparation_not_final_cutover' or value['business_written'] is not False or len(value['tables'])!=summary['tables']:
        raise BackupFailure('迁移清单范围不匹配')
    if file_sha(folder/'database.dump',cancel)!=summary['archive_sha256'] or value['archive']['sha256']!=summary['archive_sha256']:
        raise BackupFailure('原数据库归档已变化')
    if file_sha(folder/'schema.sql',cancel)!=value['schema_sha256']:raise BackupFailure('原数据库结构文件已变化')
    return value


def verify_database(dsn,manifest,folder,budget,cancel,progress,label):
    expected={(t['schema'],t['name']) for t in manifest['tables']}
    checks=[]
    with psycopg.connect(dsn,connect_timeout=3,options='-c default_transaction_read_only=on -c timezone=UTC -c search_path=pg_catalog -c bytea_output=hex -c extra_float_digits=3 -c row_security=off -c statement_timeout=30000') as connection:
        connection.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        actual=connection.execute("SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'").fetchall()
        if set(actual)!=expected:raise BackupFailure('隔离恢复后的数据表范围不同')
        # Restores and verification both use the ordinary role, including user-defined casts.
        role=connection.execute("SELECT current_user,session_user,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user),current_setting('listen_addresses')").fetchone()
        if role!=(ROLE,ROLE,False,''):raise BackupFailure('隔离恢复角色或监听范围无效')
        for table in manifest['tables']:
            budget.check(folder,cancel)
            key=sha(json.dumps([table['schema'],table['name']],ensure_ascii=False,separators=(',',':')).encode())
            if table['file']!='rows/'+key+'.jsonl':raise BackupFailure('迁移副本路径与表身份不匹配')
            path=folder/table['file']
            if path.is_symlink() or file_sha(path,cancel)!=table['file_sha256']:raise BackupFailure('原表副本已变化')
            hashes=[]
            with connection.cursor(name='reconcile_'+key[:24]) as cursor:
                cursor.execute(sql.SQL('SELECT row_to_json(t)::text FROM ONLY {} t').format(sql.Identifier(table['schema'],table['name'])))
                while batch:=cursor.fetchmany(256):
                    budget.check(folder,cancel)
                    for row in batch:
                        if len(hashes)>=500000:raise BackupFailure('隔离核对超出单表预算')
                        hashes.append(hashlib.sha256(row[0].encode()).digest())
            digest=sha(b''.join(sorted(hashes)))
            if len(hashes)!=table['rows'] or digest!=table['multiset_sha256']:raise BackupFailure('隔离恢复后的记录数量或内容不同')
            checks.append({'schema':table['schema'],'table':table['name'],'rows':len(hashes),'multiset_sha256':digest})
            progress({'phase':label+'_reconcile','processed':len(checks),'total':len(expected),'unit':'tables'})
    return checks


def rehearse(settings,root,summaries,budget,cancel,progress):
    if os.geteuid()==0:raise BackupFailure('隔离演练须由应用普通用户执行')
    manifests={label:verify_manifest(root,label,summaries[label],cancel) for label in ('source','target')}
    data=root/'rehearsal-cluster'
    if data.exists():raise BackupFailure('隔离演练目录已存在，不能覆盖')
    budget.check(root,cancel,128*1024**2)
    socket=Path(tempfile.mkdtemp(prefix='alcor-mig-'))
    socket.chmod(0o700)
    if len(os.fsencode(socket))+16>100 or not re.fullmatch(r'/[A-Za-z0-9_./-]+',str(socket)):
        socket.rmdir();raise BackupFailure('隔离演练临时目录过长')
    env={'PATH':os.environ.get('PATH',''),'LANG':'C','LC_ALL':'C'}
    if os.environ.get('DYLD_FALLBACK_LIBRARY_PATH'):env['DYLD_FALLBACK_LIBRARY_PATH']=os.environ['DYLD_FALLBACK_LIBRARY_PATH']
    stopped=False;complete=False
    try:
        run(settings,'initdb',['-D',str(data),'-U',ADMIN,'--auth-local=trust','--auth-host=reject','--encoding=UTF8','--no-locale'],env,root,budget,cancel,data=data)
        # No application credentials are inherited by the rehearsal server.
        options="-c listen_addresses='' -c unix_socket_directories='"+str(socket)+"' -c unix_socket_permissions=0700 -c shared_buffers=32MB -c max_connections=12 -c jit=off -c fsync=off -c full_page_writes=off -c log_min_error_statement=panic -c log_parameter_max_length_on_error=0"
        run(settings,'pg_ctl',['-D',str(data),'-l',str(root/'rehearsal-server.log'),'-o',options,'-w','-t','30','start'],env,root,budget,cancel,data=data)
        with psycopg.connect(host=str(socket),dbname='postgres',user=ADMIN,autocommit=True,connect_timeout=3) as administrator:
            if administrator.execute('SHOW listen_addresses').fetchone()[0]!='':raise BackupFailure('隔离实例出现网络监听')
            administrator.execute(sql.SQL('CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS').format(sql.Identifier(ROLE)))
            for label in ('source','target'):
                administrator.execute(sql.SQL('CREATE DATABASE {} OWNER {} TEMPLATE template0').format(sql.Identifier(label+'_snapshot'),sql.Identifier(ROLE)))
                administrator.execute(sql.SQL('REVOKE ALL ON DATABASE {} FROM PUBLIC').format(sql.Identifier(label+'_snapshot')))
        results={}
        for label in ('source','target'):
            folder=root/label;dbname=label+'_snapshot'
            progress({'phase':label+'_restore','processed':0,'total':None,'unit':'archive'})
            restore_env={**env,'PGHOST':str(socket),'PGUSER':ROLE,'PGDATABASE':dbname,'PGCONNECT_TIMEOUT':'3','PGOPTIONS':'-c search_path=pg_catalog -c statement_timeout=30000'}
            run(settings,'pg_restore',['--no-password','--no-owner','--no-privileges','--single-transaction','--exit-on-error','--dbname='+dbname,str(folder/'database.dump')],restore_env,root,budget,cancel,data=data)
            progress({'phase':label+'_reconcile','processed':0,'total':len(manifests[label]['tables']),'unit':'tables'})
            checks=verify_database(make_conninfo(host=str(socket),dbname=dbname,user=ROLE),manifests[label],folder,budget,cancel,progress,label)
            evidence=canonical({'scope':'isolated_restore','archive_sha256':summaries[label]['archive_sha256'],'tables':checks,'listen_addresses':[],'ordinary_restore_role':True})
            budget.object(root,cancel);budget.account(root,cancel,len(evidence));write_private(folder/'restore-receipt.json',evidence)
            sync_directory(folder)
            results[label]={**summaries[label],'restore_verified':True,'restore_receipt_sha256':sha(evidence)}
        complete=True
        return results
    finally:
        if (data/'postmaster.pid').exists():
            for mode in ('fast','immediate'):
                try:result=subprocess.run([tools(settings,'pg_ctl'),'-D',str(data),'-m',mode,'-w','-t','10','stop'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
                except subprocess.TimeoutExpired:continue
                if result.returncode==0:stopped=True;break
            if not stopped:raise BackupFailure('隔离实例尚未确认停止，演练结果暂不发布')
        else:stopped=True
        if stopped:
            shutil.rmtree(socket)
            if complete:
                # Only this just-created disposable cluster is removed; archives and receipts remain.
                shutil.rmtree(data)
