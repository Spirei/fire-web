"""Current web-admin operations for independent public reference sources."""
import json
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import Response

from .fx_provider_parser import unique
from .profile_http import bounded_body
from .security import administrator, digest


def mount_public_reference(app,db,service):
    app.state.public_reference=service

    async def actor(request):
        who=await administrator(request)
        if not await app.state.rate_limit(db,digest('public-reference:'+who.id),20,window_seconds=60):raise HTTPException(429,'公开资料管理请求过于频繁')
        return who

    async def body(request):
        try:
            raw=json.loads(await bounded_body(request,16384),object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(ValueError()))
            if not isinstance(raw,dict):raise TypeError()
            raw['requestId']=UUID(str(raw['requestId']))
            if not isinstance(raw.get('password'),str) or not 1<=len(raw['password'])<=1024 or not isinstance(raw.get('code',''),str) or len(raw.get('code',''))>128:raise ValueError()
            return raw
        except (ValueError,KeyError,TypeError,UnicodeError,RecursionError):raise HTTPException(400,'公开资料命令、原UUID或验证字段无效') from None

    @app.post('/api/system/public-reference/install')
    async def install(request:Request):
        who=await actor(request);raw=await body(request)
        if set(raw)-{'requestId','password','code','policyId'} or not isinstance(raw.get('policyId'),str):raise HTTPException(400,'公开资料安装参数无效')
        return await service.install(who,raw['requestId'],raw['policyId'],raw['password'],raw.get('code',''))

    @app.post('/api/system/public-reference/revoke')
    async def revoke(request:Request):
        who=await actor(request);raw=await body(request)
        try:
            identifier=UUID(str(raw['licenseId']))
            if set(raw)-{'requestId','password','code','licenseId'}:raise ValueError()
        except (ValueError,TypeError,KeyError):raise HTTPException(400,'公开资料许可编号无效') from None
        return await service.revoke(who,raw['requestId'],identifier,raw['password'],raw.get('code',''))

    @app.post('/api/system/public-reference/collect')
    async def collect(request:Request):
        who=await actor(request);raw=await body(request)
        try:
            identifier=UUID(str(raw['licenseId']))
            if set(raw)-{'requestId','password','code','licenseId','query'} or not isinstance(raw.get('query'),dict):raise ValueError()
        except (ValueError,TypeError,KeyError):raise HTTPException(400,'公开资料采集参数无效') from None
        return await service.collect(who,raw['requestId'],identifier,raw['query'],raw['password'],raw.get('code',''))

    @app.get('/api/system/public-reference/operations/{request_id}')
    async def receipt(request:Request,request_id:UUID):return await service.receipt(await actor(request),request_id)

    @app.post('/api/system/public-reference/originals/{page_id}')
    async def original(request:Request,page_id:UUID):
        who=await actor(request);raw=await body(request)
        if set(raw)-{'requestId','password','code'}:raise HTTPException(400,'原件验证字段无效')
        body_bytes=await service.original(who,page_id,raw['password'],raw.get('code',''))
        return Response(body_bytes,media_type='application/octet-stream',headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Disposition':f'attachment; filename="public-reference-{page_id}.bin"'})
