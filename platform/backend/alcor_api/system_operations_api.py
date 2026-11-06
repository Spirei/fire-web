"""Legacy health/database envelopes over existing platform authorities."""
import json
import re
from datetime import UTC,datetime
from uuid import uuid4

from fastapi import HTTPException,Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from . import __version__
from .api_documents import legacy_docs_user
from .connection_models import ConnectionInput
from .connections import current_config,endpoint
from .profile_http import bounded_body
from .security import identity
from .system_operations import SystemOperations,admin_lock

HEADERS={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'}


def mount_system_operations(app,db):
    service=SystemOperations(db);app.state.system_operations=service

    async def admin(request,legacy=False):
        if not legacy and 'authorization' in request.headers: raise HTTPException(403,'请使用当前管理员Web会话')
        if legacy and 'authorization' in request.headers:
            supplied=request.headers.get('authorization','')
            if len(request.headers.getlist('authorization')) != 1 or not re.fullmatch(r'Bearer [a-fA-F0-9]{64}',supplied):
                raise HTTPException(401,'未登录')
        who=await legacy_docs_user(request) if legacy else await identity(request)
        if who is None: raise HTTPException(401,'未登录')
        if who.role!='admin': raise HTTPException(403,'需要管理员权限')
        async with db.connection() as conn,conn.transaction(): await admin_lock(conn,who)
        return who

    async def body(request):
        try:
            def invalid(_): raise ValueError()
            raw=json.loads(await bounded_body(request,8192),parse_constant=invalid)
        except (ValueError,UnicodeError,RecursionError): raise HTTPException(400,'无效请求体') from None
        if not isinstance(raw,dict): raise HTTPException(400,'无效请求体')
        return raw

    def response(value): return JSONResponse(jsonable_encoder(value),headers=HEADERS)

    @app.get('/api/admin/system-operations')
    async def state(request:Request): return response(await service.read(await admin(request)))

    @app.post('/api/admin/system-operations/cache/clear')
    async def clear(request:Request): return response(await service.clear(await admin(request),await body(request)))

    @app.get('/api/admin/system-operations/operations/{rid}')
    async def receipt(rid:str,request:Request): return response(await service.receipt(await admin(request),rid))

    @app.get('/api/db/status')
    async def database_status(request:Request):
        who=await admin(request,True)
        async with db.connection() as conn,conn.transaction():
            await admin_lock(conn,who)
            observed=await(await conn.execute('SELECT current_database() AS database,pg_database_size(current_database()) AS bytes,version() AS version')).fetchone()
            tables=await(await conn.execute("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).fetchall()
        value=await app.state.connections.read('postgresql')
        return response({'status':{'type':'postgres','configuredType':'postgres','file':observed['database'],'sizeBytes':observed['bytes'],'tables':[r['tablename'] for r in tables],'state':value['state'],'revision':value['revision'],'configured':value['config'] is not None,'apiApplied':value['state']=='applied','workerApplied':value['worker_applied'],'version':observed['version'],'versionKnown':True,'authority':'platform_connections'}})

    @app.post('/api/db/test')
    async def database_test(request:Request):
        who=await admin(request,True);raw=await body(request)
        if set(raw)-{'host','port','database','pgUser','password','requestId','revision','sslMode'}: raise HTTPException(400,'不支持的连接字段')
        connections=app.state.connections
        current=await connections.read('postgresql')
        config={'kind':'postgresql','host':str(raw.get('host','')).strip(),'port':raw.get('port',5432),'database':str(raw.get('database','')).strip(),'username':str(raw.get('pgUser','')).strip(),'ssl_mode':raw.get('sslMode','disable')}
        supplied=raw.get('requestId') or request.headers.get('x-alcor-request-id');password=raw.get('password')
        data={'request_id':supplied or str(uuid4()),'revision':raw.get('revision',current['revision']),'config':config,'password_mode':'replace' if password else 'keep',**({'password':password} if password else {})}
        try:
            model=ConnectionInput.model_validate(data)
            # With no PG saved row, keep may refer only to the exact configured
            # bootstrap target, never another host/database/account.
            if not password and current['config'] is None:
                base,secret=current_config(db.settings,'postgresql')
                if endpoint(base)!=endpoint(model.config) or base.username!=model.config.username: raise HTTPException(422,'连接目标或账号已变化，请重新输入密码')
                if secret: model=ConnectionInput.model_validate({**data,'password_mode':'replace','password':secret})
        except ValidationError: raise HTTPException(422,'连接字段无效') from None
        result=await connections.operate(who,model,'test')
        return response({'ok':result['status']=='passed','version':result.get('postgres_version'),'versionKnown':bool(result.get('postgres_version')),'requestId':str(model.request_id),'legacyClientIdempotency':bool(supplied),'result':result,**({'error':result['message']} if result['status']=='failed' else {})})

    @app.get('/api/health')
    async def health():
        # Startup liveness only: no network probes or implicit source collection.
        return response({'code':0,'message':'ok','data':{'status':'ok','service':'fire' if getattr(app.state,'fire_version','') else 'alcor-api','time':datetime.now(UTC).isoformat(),'version':__version__,'buildSha':db.settings.source_revision or 'unknown','quoteSource':'licensed_platform_sources','effectiveSource':None,'futuOpenD':{'available':None,'state':'not_probed'},'tickerCrossCheck':None,'authority':'process_liveness_only'}})
