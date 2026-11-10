"""Resumable original-file verification and native public material registration."""
import asyncio
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import unquote,urlsplit
from uuid import uuid5

from fastapi import HTTPException
from psycopg.types.json import Jsonb
from psycopg.errors import DeadlockDetected,LockNotAvailable,SerializationFailure
from psycopg_pool import PoolTimeout

from .backups import BackupFailure,private_read
from .database_migration_capture import canonical,sha
from .database_migration_jobs import guard
from .legacy_asset_directory import LegacyAssetDirectory,public_upload_root


def input_manifest(settings,plan):
    from .backup_stream_storage import existing_directory
    root=existing_directory(existing_directory(settings.backup_dir)/'migration-completion-input')
    raw=private_read(root/'media-manifest.json',4*1024**2);value=json.loads(raw)
    if value.get('source_instance')!=plan['portfolio']['source_instance'] or value.get('source_owner')!=plan['source_owner']:
        raise BackupFailure('素材原件登记不属于本次来源')
    files=value.get('files')
    if not isinstance(files,list) or len(files)>20000:raise BackupFailure('素材原件清单无效')
    by_path={}
    for row in files:
        if not isinstance(row,dict) or not isinstance(row.get('path'),str) or not row['path'].startswith('uploads/') or row['path'] in by_path or not re.fullmatch('[a-f0-9]{64}',row.get('sha256','')) or type(row.get('bytes')) is not int or not 0<=row['bytes']<=2*1024**3:
            raise BackupFailure('素材原件清单无效')
        by_path[row['path']]=row
    return root,by_path,sha(raw)


def original_bytes(settings,url,files):
    parsed=urlsplit(url)
    if parsed.scheme or parsed.netloc or not parsed.path.startswith('/uploads/') or parsed.fragment:raise BackupFailure('原图片地址不在本地 uploads')
    path=unquote(parsed.path).lstrip('/');parts=path.split('/')
    if len(parts)>9 or any(not p or p.startswith('.') or '\\' in p or any(ord(c)<32 for c in p) for p in parts):raise BackupFailure('原图片路径无效')
    entry=files.get(path)
    if not entry:raise BackupFailure('原图片尚未登记到原件清单')
    raw=LegacyAssetDirectory(public_upload_root(settings)).read_parts(parts[1:],64*1024**2)
    if len(raw)!=entry['bytes'] or hashlib.sha256(raw).hexdigest()!=entry['sha256']:raise BackupFailure('原图片内容与完整备份不一致')
    return raw,Path(parts[-1]).name,entry['sha256']


def plain(value):
    from decimal import Decimal
    if isinstance(value,Decimal):return str(value)
    if isinstance(value,dict):return {key:plain(item) for key,item in value.items()}
    if isinstance(value,list):return [plain(item) for item in value]
    return value


async def execute(db,task,who,plan,frozen):
    from .asset_lookup_catalog import AssetCatalog
    from .system_assets import SystemAssets
    from .asset_lookup_contract import manifest
    _,files,input_sha=input_manifest(db.settings,plan)
    source=plan['portfolio'];rows=frozen.rows(source['source_schema'],'assets')
    catalog=AssetCatalog(db);images=SystemAssets(db)
    async with db.connection() as conn:
        receipts=await(await conn.execute('SELECT original_id,original,result FROM database_migration_asset_imports WHERE owner_id=%s AND source_instance=%s AND source_owner=%s',(who.id,source['source_instance'],source['source_owner']))).fetchall()
    prior={row['original_id']:row for row in receipts};pending=[]
    for row in rows:
        receipt=prior.get(str(row['id']))
        if receipt:
            if receipt['original']!=plain(row) or receipt['result'].get('input_sha256')!=input_sha:raise BackupFailure('已迁入的素材来源发生变化')
        else:pending.append(row)
    done=len(rows)-len(pending)
    def progress():return {'phase':'completion_assets','processed':done,'total':len(rows),'unit':'assets','business_written':True,'completed_domains':['accounts','positions','orders','cash','pnl']}
    await guard(db,task,progress())
    # Bound each transaction to eight originals. One durable commit/checkpoint
    # replaces a commit and repeated pool/schema acquisition for every item.
    for start in range(0,len(pending),8):
        batch=pending[start:start+8]
        # Four bounded readers validate immutable originals and decode safe
        # presentation bytes concurrently, outside the database write locks.
        semaphore=asyncio.Semaphore(4)
        async def prepare(row):
            async with semaphore:return await asyncio.to_thread(prepare_variants,db.settings,row,files)
        work=asyncio.gather(*(prepare(row) for row in batch))
        try:
            while not work.done():
                await asyncio.wait({work},timeout=.5)
                await guard(db,task,progress())
            prepared=await work
        except BaseException:
            work.cancel();await asyncio.gather(work,return_exceptions=True);raise
        for attempt in range(3):
            try:
                async with catalog.context(who,True) as conn:
                    from .worker import owned_row
                    if not (lease:=await owned_row(conn,task)) or lease['status']!='running':raise BackupFailure('迁移已停止')
                    async with images.context(who,True,connection=conn):
                        for row,variants in zip(batch,prepared,strict=True):
                            await import_one(db,conn,task,who,source,row,variants,input_sha,catalog,images,manifest)
                            await conn.execute('UPDATE tasks SET lease_until=clock_timestamp()+make_interval(secs=>%s) WHERE id=%s',(max(30,db.settings.lease_seconds),task['id']))
                        await conn.execute("UPDATE system_asset_scope SET revision=revision+1 WHERE namespace='system_public'")
                break
            except (DeadlockDetected,LockNotAvailable,SerializationFailure,PoolTimeout,HTTPException) as error:
                if isinstance(error,HTTPException) and (error.status_code!=503 or error.detail!='原件正在处理，请核对原回执后重试'):raise
                if attempt==2:raise
                # Rollback releases all locks. Retry this chunk only; committed
                # chunks and their per-original receipts are never rewritten.
                await guard(db,task,progress());await asyncio.sleep(.25*(attempt+1))
        done+=len(batch)
        await guard(db,task,progress())
    return {'metadata':len(rows),'retired':sum(row['type']=='icon' for row in rows),'input_sha256':input_sha}


def prepare_variants(settings,row,files):
    from .system_assets import prepare_original
    variants={}
    for field in (() if row['type']=='icon' else ('url','url_dark')):
        url=row.get(field)
        if url:
            try:
                raw,name,digest=original_bytes(settings,url,files)
                variants[field]=(raw,name,digest,prepare_original(raw,name))
            except (HTTPException,OSError,ValueError) as error:raise BackupFailure('素材原件缺失或不可读') from error
    return variants


async def import_one(db,conn,task,who,source,row,variants,input_sha,catalog,images,manifest):
    original=plain(row);identifier=str(row['id']);item_hash=sha(canonical(original))
    # Also cover a worker resuming after an uncertain commit response.
    prior=await(await conn.execute('SELECT original,result FROM database_migration_asset_imports WHERE owner_id=%s AND source_instance=%s AND source_owner=%s AND original_id=%s',(who.id,source['source_instance'],source['source_owner'],identifier))).fetchone()
    if prior:
        if prior['original']!=original or prior['result'].get('input_sha256')!=input_sha:raise BackupFailure('已迁入的素材来源发生变化')
        return
    kind=row['type'];versions={}
    # Navigation/function icons were explicitly retired. Keep original
    # files and metadata, without bringing that category back to the UI.
    if kind!='icon':
        cache={}
        for field,(raw,name,digest,prepared) in variants.items():
            if digest not in cache:
                cache[digest]=await images.apply(conn,who.id,{'kind':'asset','folder':kind,'market':row.get('market') or '',
                    'code':'IMG-'+sha((source['source_instance']+':'+identifier+':'+field).encode())[:20],'name':row.get('name') or str(row.get('code') or '')},name,raw,source_original=True,prepared_original=prepared)
            versions[field]=cache[digest]['version']
        if kind!='card':
            existing=await(await conn.execute('SELECT id FROM asset_catalog_entries WHERE id=%s',(identifier,))).fetchone()
            if not existing:
                entry={'id':identifier,'type':kind,'market':str(row.get('market') or '').upper(),'code':str(row.get('code') or '').upper(),'name':row.get('name') or str(row.get('code') or ''),'imageVersion':versions.get('url'),'darkImageVersion':versions.get('url_dark')}
                text=json.dumps({'version':1,'publicMetadataConfirmed':True,'entries':[entry]},ensure_ascii=False,separators=(',',':'))
                value=manifest(text,'数据库迁移素材')
                current=await(await conn.execute('SELECT revision FROM asset_catalog_scope FOR UPDATE')).fetchone()
                result=await catalog.import_locked(conn,who,uuid5(task['request_id'],'asset:'+identifier),current['revision'],value['sha256'],text,'数据库迁移素材')
                if result['rejectedCount']:raise BackupFailure('素材目录存在冲突，未覆盖当前素材')
    result={'state':'retired_original_retained' if kind=='icon' else 'imported','original_sha256':item_hash,'input_sha256':input_sha,
            'versions':versions,'files':{field:{'original_sha256':item[2],'bytes':len(item[0])} for field,item in variants.items()}}
    await conn.execute('INSERT INTO database_migration_asset_imports(owner_id,source_instance,source_owner,original_id,original,result,task_id) VALUES(%s,%s,%s,%s,%s,%s,%s)',(who.id,source['source_instance'],source['source_owner'],identifier,Jsonb(original),Jsonb(result),task['id']))
