"""Private bounded response retention, never a source of replacement rates."""
import hashlib

from fastapi import HTTPException, Request
from fastapi.responses import Response

LIMIT=131072


class ResponseBytes(bytes):
    status=200
    complete=True


class ResponseRejected(ValueError):
    def __init__(self,raw,status,complete,message='provider_http_error'):
        super().__init__(message)
        self.complete=bool(complete and len(raw)<=LIMIT)
        self.raw=bytes(raw[:LIMIT])
        self.status=status


async def retain(db,task,origin,raw,status,complete,representation):
    if str(db.settings.instance_id)!=str(origin):
        raise HTTPException(503,'汇率响应实例绑定已变化')
    complete=bool(complete and len(raw)<=LIMIT)
    raw=bytes(raw[:LIMIT]);sha=hashlib.sha256(raw).hexdigest()
    async with db.connection() as conn,conn.transaction():
        instance=await(await conn.execute('SELECT instance_id FROM alcor_instance WHERE singleton')).fetchone()
        row=await(await conn.execute('SELECT * FROM fx_refresh_tasks WHERE id=%s FOR UPDATE',(task['id'],))).fetchone()
        if not instance or str(instance['instance_id'])!=str(origin) or not row or (row['owner_id'],row['provider_revision'])!=(task['owner_id'],task['provider_revision']):
            raise HTTPException(503,'汇率响应原任务绑定无法验证')
        prior=await(await conn.execute('SELECT * FROM fx_response_pages WHERE task_id=%s',(task['id'],))).fetchone()
        if prior:
            if (bytes(prior['raw_bytes']),prior['raw_sha256'],prior['http_status'],prior['complete'],str(prior['origin_instance']))!=(raw,sha,status,complete,str(origin)):
                raise HTTPException(503,'汇率响应原件冲突')
            return
        if row['state']!='running':
            raise HTTPException(503,'汇率响应原任务已失效')
        await conn.execute('INSERT INTO fx_response_pages(task_id,task_owner_id,provider_revision,origin_instance,raw_bytes,raw_sha256,representation,http_status,complete) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                           (task['id'],task['owner_id'],task['provider_revision'],origin,raw,sha,representation,status,complete))


def mount_fx_response_originals(app,db):
    from .admin_verification import VerificationInput
    from .security import administrator, lock_mutation_identity

    @app.post('/api/reference/rates/responses/{task_id}/original')
    async def original(task_id:str,data:VerificationInput,request:Request):
        from uuid import UUID
        if request.query_params:raise HTTPException(400,'不支持查询参数')
        who=await administrator(request)
        if not await app.state.rate_limit(db,'reference-response-proof:'+who.id,10):raise HTTPException(429,'验证尝试过于频繁')
        try:
            identifier=UUID(task_id)
            if str(identifier)!=task_id:raise ValueError
        except (ValueError,TypeError):raise HTTPException(400,'任务UUID无效') from None
        async with db.connection() as conn,conn.transaction():
            await app.state.native_passkeys.serialize(conn,who)
            await lock_mutation_identity(conn,who,require_admin=True)
            await app.state.native_passkeys.step_up(conn,who,data.password.get_secret_value(),data.code.get_secret_value())
            row=await(await conn.execute('SELECT * FROM fx_response_pages WHERE task_id=%s',(identifier,))).fetchone()
            if not row:raise HTTPException(404,'汇率响应原件不存在')
            raw=bytes(row['raw_bytes'])
            if hashlib.sha256(raw).hexdigest()!=row['raw_sha256']:raise HTTPException(503,'汇率响应原件校验失败')
        return Response(raw,media_type='application/octet-stream',headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization',
            'Content-Disposition':'attachment; filename="fx-response.bin"','X-Content-Type-Options':'nosniff','X-Alcor-Source-SHA256':row['raw_sha256'],
            'X-Alcor-Source-Complete':str(row['complete']).lower(),**({'X-Alcor-Source-HTTP-Status':str(row['http_status'])} if row['http_status'] is not None else {})})
