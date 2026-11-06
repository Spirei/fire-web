import hashlib
import math
from uuid import UUID

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from alcor_api.cash_ledger import CashLedger
from .financial_source import parse_source, shape, text


class SourceUploads:
    def __init__(self,db):
        self.db=db
        self.cash=CashLedger(db)

    async def begin(self,who,data):
        shape(data,'sourceId sha256 byteCount sourceInstance sourceOwner sourceVersion confirmedTargetUid confirmedSourceOwner')
        try: source_id=UUID(data['sourceId'])
        except (ValueError,TypeError,AttributeError):raise HTTPException(422,'源上传编号无效') from None
        if data['confirmedTargetUid']!=who.id or data['confirmedSourceOwner'] is not True:
            raise HTTPException(409,'请明确核对原owner与当前平台UID的映射')
        for key in ('sourceInstance','sourceOwner','sourceVersion'):text(data[key])
        if type(data['byteCount']) is not int or not 1<=data['byteCount']<=16777216:
            raise HTTPException(422,'原账快照大小无效')
        if not isinstance(data['sha256'],str) or len(data['sha256'])!=64 or any(c not in '0123456789abcdef' for c in data['sha256']):
            raise HTTPException(422,'原账快照哈希无效')
        manifest={k:data[k] for k in ('sourceInstance','sourceOwner','sourceVersion','confirmedTargetUid','confirmedSourceOwner')}
        async with self.db.connection() as conn,conn.transaction():
            await self.cash.lock(conn,who)
            prior=await(await conn.execute('SELECT * FROM financial_import_uploads WHERE owner_id=%s AND id=%s FOR UPDATE',(who.id,source_id))).fetchone()
            if prior:
                if prior['manifest']!=manifest or prior['sha256']!=data['sha256'] or prior['byte_count']!=data['byteCount']:
                    raise HTTPException(409,'同一源上传编号内容冲突')
            else:
                quota=await(await conn.execute('SELECT count(*) n,coalesce(sum(byte_count),0) bytes FROM financial_import_uploads WHERE owner_id=%s',(who.id,))).fetchone()
                if quota['n']>=64 or quota['bytes']+data['byteCount']>134217728:raise HTTPException(409,'原账证据容量需要管理核验')
                await conn.execute('INSERT INTO financial_import_uploads(owner_id,id,manifest,byte_count,sha256) VALUES(%s,%s,%s,%s,%s)',(who.id,source_id,Jsonb(manifest),data['byteCount'],data['sha256']))
            return await self.status_conn(conn,who,source_id)

    async def status_conn(self,conn,who,source_id):
        upload=await(await conn.execute('SELECT * FROM financial_import_uploads WHERE owner_id=%s AND id=%s',(who.id,source_id))).fetchone()
        if not upload:raise HTTPException(404,'原账上传不存在')
        rows=await(await conn.execute('SELECT part,octet_length(raw) bytes FROM financial_import_chunks WHERE owner_id=%s AND upload_id=%s ORDER BY part',(who.id,source_id))).fetchall()
        applied=await(await conn.execute("SELECT request_id FROM financial_import_operations WHERE owner_id=%s AND result->>'sourceId'=%s AND result->>'state'='completed' AND result->>'financialApplied'='true' ORDER BY created_at",(who.id,str(source_id)))).fetchall()
        return {'sourceId':str(source_id),'sha256':upload['sha256'],'byteCount':upload['byte_count'],'parts':math.ceil(upload['byte_count']/32768),'receivedParts':[r['part'] for r in rows],'sealed':upload['sealed_at'] is not None,'financialApplied':bool(applied),'originalOperationIds':[str(row['request_id']) for row in applied]}

    async def status(self,who,source_id):
        async with self.db.connection() as conn,conn.transaction():
            await self.cash.lock(conn,who)
            return await self.status_conn(conn,who,source_id)

    async def chunk(self,who,source_id,part,raw):
        async with self.db.connection() as conn,conn.transaction():
            await self.cash.lock(conn,who)
            upload=await(await conn.execute('SELECT * FROM financial_import_uploads WHERE owner_id=%s AND id=%s FOR UPDATE',(who.id,source_id))).fetchone()
            if not upload:raise HTTPException(404,'原账上传不存在')
            last=math.ceil(upload['byte_count']/32768)-1
            expected=32768 if part<last else upload['byte_count']-last*32768
            if part<0 or part>last or len(raw)!=expected:raise HTTPException(422,'原账分块位置或长度无效')
            prior=await(await conn.execute('SELECT raw FROM financial_import_chunks WHERE owner_id=%s AND upload_id=%s AND part=%s',(who.id,source_id,part))).fetchone()
            if prior:
                if bytes(prior['raw'])!=raw:raise HTTPException(409,'同一原账分块内容冲突')
            elif upload['sealed_at'] is not None:
                raise HTTPException(409,'已封存原账不可增加分块')
            else:
                await conn.execute('INSERT INTO financial_import_chunks VALUES(%s,%s,%s,%s)',(who.id,source_id,part,raw))
            return await self.status_conn(conn,who,source_id)

    async def seal(self,who,source_id):
        async with self.db.connection() as conn,conn.transaction():
            await self.cash.lock(conn,who)
            upload=await(await conn.execute('SELECT * FROM financial_import_uploads WHERE owner_id=%s AND id=%s FOR UPDATE',(who.id,source_id))).fetchone()
            if not upload:raise HTTPException(404,'原账上传不存在')
            rows=await(await conn.execute('SELECT part,raw FROM financial_import_chunks WHERE owner_id=%s AND upload_id=%s ORDER BY part',(who.id,source_id))).fetchall()
            if [r['part'] for r in rows]!=list(range(math.ceil(upload['byte_count']/32768))):raise HTTPException(409,'原账分块尚未完整')
            raw=b''.join(bytes(r['raw']) for r in rows)
            if len(raw)!=upload['byte_count'] or hashlib.sha256(raw).hexdigest()!=upload['sha256']:
                raise HTTPException(409,'原账完整字节哈希不匹配')
            source=parse_source(raw)
            manifest=upload['manifest'];meta=source['source']
            if any(meta[k]!=manifest[m] for k,m in (('instance','sourceInstance'),('owner','sourceOwner'),('version','sourceVersion'))):
                raise HTTPException(409,'原owner或源版本与已确认映射不同')
            prior=await(await conn.execute('SELECT * FROM financial_import_sources WHERE owner_id=%s AND source_instance=%s AND source_owner=%s AND source_version=%s',(who.id,meta['instance'],meta['owner'],meta['version']))).fetchone()
            if prior and (prior['sha256']!=upload['sha256'] or prior['id']!=source_id):raise HTTPException(409,'该源版本已有其他封存快照，请查询原sourceId')
            if not prior:
                await conn.execute('INSERT INTO financial_import_sources(owner_id,id,source_instance,source_owner,source_version,sha256,raw) VALUES(%s,%s,%s,%s,%s,%s,%s)',(who.id,source_id,meta['instance'],meta['owner'],meta['version'],upload['sha256'],raw))
                await conn.execute('UPDATE financial_import_uploads SET sealed_at=clock_timestamp() WHERE owner_id=%s AND id=%s',(who.id,source_id))
            return await self.status_conn(conn,who,source_id)
