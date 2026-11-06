"""Explicit administrator controls for independent public discovery publication."""
import json
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .fx_provider_parser import unique
from .profile_http import bounded_body
from .public_discovery import PublicDiscovery
from .security import administrator, digest


def mount_public_discovery(app,settings,db,*,quote_authority=None):
    service=PublicDiscovery(db,policy_provider=lambda:settings.public_discovery_policies,
                            target_provider=lambda:settings.public_discovery_targets,quote_authority=quote_authority)
    app.state.public_discovery=service
    async def admin(request):
        who=await administrator(request)
        if not await app.state.rate_limit(db,digest('public-discovery-admin:'+who.id),20,window_seconds=60):raise HTTPException(429,'公共发现管理请求过于频繁')
        return who
    async def body(request,allowed,*,request_id=True):
        if request.query_params:raise HTTPException(400,'不支持查询参数')
        try:
            raw=json.loads(await bounded_body(request,16384),object_pairs_hook=unique)
            if not isinstance(raw,dict) or set(raw)-allowed:raise ValueError()
            if request_id:raw['requestId']=UUID(str(raw['requestId']))
            if not isinstance(raw.get('password'),str) or not 1<=len(raw['password'])<=1024 or not isinstance(raw.get('code',''),str) or len(raw.get('code',''))>128:raise ValueError()
            return raw
        except (ValueError,TypeError,KeyError,UnicodeError,RecursionError):raise HTTPException(400,'公共发现命令或身份核对无效') from None
    def response(value):return JSONResponse(value,headers={'Cache-Control':'no-store, private'})
    @app.get('/api/system/public-discovery/licenses')
    async def licenses(request:Request):
        who=await admin(request)
        async with db.connection() as conn,conn.transaction():
            await service.admin._admin(conn,who)
            rows=await(await conn.execute('SELECT l.id,l.policy_id,l.license_revision,l.created_at,EXISTS(SELECT 1 FROM public_discovery_revocations r WHERE r.license_id=l.id) AS revoked FROM public_discovery_licenses l ORDER BY l.created_at DESC LIMIT 101')).fetchall()
        policies=[]
        for raw in settings.public_discovery_policies:
            try:
                p=service.policy(raw['id'])
                policies.append({'id':p.id,'licenseRevision':p.license_revision,'validFrom':p.valid_from,'validUntil':p.valid_until,'markets':list(p.markets),'purposes':list(p.purposes)})
            except (HTTPException,KeyError,TypeError):continue
        return response({'licenses':[{'id':str(r['id']),'policyId':r['policy_id'],'licenseRevision':r['license_revision'],'createdAt':r['created_at'].isoformat(),'revoked':r['revoked']} for r in rows[:100]],'partial':len(rows)>100,'policies':policies,'automaticCollection':False})
    @app.post('/api/system/public-discovery/install')
    async def install(request:Request):
        who=await admin(request);raw=await body(request,{'requestId','policyId','password','code'})
        return response(await service.install(who,raw['requestId'],raw.get('policyId'),raw['password'],raw.get('code','')))
    @app.post('/api/system/public-discovery/revoke')
    async def revoke(request:Request):
        who=await admin(request);raw=await body(request,{'requestId','licenseId','password','code'})
        try:identifier=UUID(str(raw['licenseId']))
        except (ValueError,KeyError):raise HTTPException(400,'公共许可编号无效') from None
        return response(await service.revoke(who,raw['requestId'],identifier,raw['password'],raw.get('code','')))
    @app.post('/api/system/public-discovery/collect')
    async def collect(request:Request):
        who=await admin(request);raw=await body(request,{'requestId','licenseId','query','password','code'})
        try:identifier=UUID(str(raw['licenseId']))
        except (ValueError,KeyError):raise HTTPException(400,'公共许可编号无效') from None
        return response(await service.collect(who,raw['requestId'],identifier,raw.get('query'),raw['password'],raw.get('code','')))
    @app.get('/api/system/public-discovery/operations/{request_id}')
    async def receipt(request:Request,request_id:UUID):
        return response(await service.receipt(await admin(request),request_id))
    @app.post('/api/system/public-discovery/originals/{page_id}')
    async def original(request:Request,page_id:UUID):
        who=await admin(request);raw=await body(request,{'password','code'},request_id=False)
        data,sha=await service.original(who,page_id,raw['password'],raw.get('code',''))
        return Response(data,media_type='application/octet-stream',headers={'Cache-Control':'no-store, private','X-Alcor-Source-SHA256':sha,'X-Content-Type-Options':'nosniff','Content-Disposition':'attachment; filename="public-discovery.bin"'})
    return service
