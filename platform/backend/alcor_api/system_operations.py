"""Read observed recovery state and clear only this process's registry parser cache."""
import hashlib
import json
from uuid import UUID

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .security import lock_mutation_identity
from .source_window import cache_snapshot,clear_instance_cache


def identifier(value):
    try: return str(UUID(str(value)))
    except (ValueError,TypeError,AttributeError): raise HTTPException(400,'操作编号无效') from None


async def admin_lock(conn,who):
    await lock_mutation_identity(conn,who)
    web=await(await conn.execute("SELECT 1 FROM sessions WHERE user_id=%s AND token_hash=%s AND client_id=ANY(%s) AND expires_at>clock_timestamp()",(who.id,who.token_hash,['new-web','legacy-web']))).fetchone()
    if not web: raise HTTPException(403,'请使用管理员Web会话')


class SystemOperations:
    def __init__(self,db): self.db=db

    async def read(self,who):
        async with self.db.connection() as conn,conn.transaction():
            await admin_lock(conn,who)
            counts=await(await conn.execute('SELECT status,count(*) AS count FROM tasks WHERE kind LIKE %s GROUP BY status',('backup.%',))).fetchall()
            backups=await(await conn.execute('SELECT count(*) AS registered,count(*) FILTER(WHERE verified_at IS NOT NULL) AS verified,max(verified_at) AS last_verified_at FROM backups WHERE source_instance=%s',(self.db.settings.instance_id,))).fetchone()
            quarantine=await(await conn.execute('SELECT category,quarantined_at FROM restore_quarantine ORDER BY category')).fetchall()
            latest=await(await conn.execute("SELECT id,kind,status,created_at,started_at,finished_at,error_code FROM tasks WHERE kind IN('backup.restore','backup.verify') ORDER BY created_at DESC LIMIT 20")).fetchall()
            return {'instanceId':str(self.db.settings.instance_id),'cache':cache_snapshot(self.db.settings.instance_id),'recovery':{'state':'observed_registration_only','completeRecoveryVerified':None,'backups':backups,'taskCounts':counts,'recentTasks':latest,'quarantine':[{'category':r['category'],'quarantinedAt':r['quarantined_at']} for r in quarantine],'quarantined':bool(quarantine),'categoriesAuthority':'restore_quarantine_registered_categories','coverage':'registered_platform_capsules_and_tasks_only'}}

    async def receipt(self,who,rid):
        async with self.db.connection() as conn,conn.transaction():
            await admin_lock(conn,who)
            row=await(await conn.execute('SELECT state,result FROM system_cache_operations WHERE owner_id=%s AND request_id=%s',(who.id,identifier(rid)))).fetchone()
            if not row: raise HTTPException(404,'未查到原请求')
            return row['result'] or {'requestId':rid,'state':'unknown','retryAllowed':False}

    async def clear(self,who,raw):
        if not isinstance(raw,dict) or set(raw)!={'requestId','processId','revision'}: raise HTTPException(400,'缓存请求无效')
        rid=identifier(raw['requestId']);process=identifier(raw['processId']);revision=raw['revision']
        if type(revision) is not int or revision<0: raise HTTPException(400,'缓存版本无效')
        fingerprint=hashlib.sha256(json.dumps(raw,sort_keys=True).encode()).hexdigest()
        async with self.db.connection() as conn,conn.transaction():
            await admin_lock(conn,who)
            prior=await(await conn.execute('SELECT fingerprint,result FROM system_cache_operations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if prior:
                if prior['fingerprint']!=fingerprint: raise HTTPException(409,'操作编号已用于其他请求')
                return prior['result'] or {'requestId':rid,'state':'unknown','retryAllowed':False}
            current=cache_snapshot(self.db.settings.instance_id)
            if current['processId']!=process or current['revision']!=revision: raise HTTPException(409,'缓存进程或版本已变化，请重新读取')
            await conn.execute("INSERT INTO system_cache_operations(owner_id,request_id,fingerprint,instance_id,process_id,revision,state) VALUES(%s,%s,%s,%s,%s,%s,'admitted')",(who.id,rid,fingerprint,self.db.settings.instance_id,process,revision))
        # A committed admission is never re-executed. Identity is checked again
        # before touching the process cache; failure leaves an uncertain receipt.
        async with self.db.connection() as conn,conn.transaction():
            await admin_lock(conn,who)
            try:
                cleared=clear_instance_cache(self.db.settings.instance_id,process,revision)
                result={'requestId':rid,'state':'completed','cache':cleared}
            except HTTPException:
                result={'requestId':rid,'state':'rejected','reason':'cache_generation_changed','retryAllowed':False}
            await conn.execute('UPDATE system_cache_operations SET state=%s,result=%s,finished_at=clock_timestamp() WHERE owner_id=%s AND request_id=%s', (result['state'],Jsonb(result),who.id,rid))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'system.cache.'||%s,%s,%s)",(who.id,result['state'],process,rid))
            return result
