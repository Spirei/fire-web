"""Explicit owner Web migration over registered sources; no native automatic capture."""

import json
from uuid import UUID

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .profile_http import bounded_body
from .resource_import import object_pairs
from .security import identity
from .watch_group_import import WatchGroupImport


class Strict(BaseModel):
    model_config=ConfigDict(extra='forbid',strict=True)


class Capture(Strict):
    requestId:str=Field(pattern=r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    grantRevision:int=Field(ge=1,le=9007199254740991)


class Empty(Strict):pass


class Apply(Strict):
    requestId:str=Field(pattern=r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    preview:str=Field(pattern='^[a-f0-9]{64}$')
    expectedGroupRevision:int=Field(ge=0,le=9007199254740991)
    expectedRecordRevision:int=Field(ge=0,le=9007199254740991)


def mount_watch_group_import(app,settings):
    service=WatchGroupImport(app.state.db,app.state.source_authority);app.state.watch_group_import=service
    async def member(request,model=None,paging=False):
        if 'authorization' in request.headers:raise HTTPException(403,'请使用当前网页登录会话')
        if set(request.query_params)-({'after'} if paging else set()) or any(len(request.query_params.getlist(key))!=1 for key in request.query_params):raise HTTPException(400,'查询字段无效')
        who=await identity(request)
        if model is None:return who
        if request.headers.get('content-type','').split(';')[0].strip().lower()!='application/json':raise HTTPException(415,'请提交JSON请求')
        try:
            def constant(_):raise ValueError()
            raw=json.loads(await bounded_body(request,4096),parse_constant=constant,object_pairs_hook=object_pairs)
            return who,model.model_validate(raw).model_dump()
        except (ValueError,UnicodeError,ValidationError):raise HTTPException(422,'请求字段无效') from None
    def response(value):return JSONResponse(value,headers={'Cache-Control':'private, no-store'})
    def after(request):
        value=request.query_params.get('after','0')
        if not value.isascii() or not value.isdecimal() or len(value)>6 or int(value)>50000:raise HTTPException(400,'分页位置无效')
        return int(value)
    @app.post('/api/watch-group-import/authorizations/{grant_id}/snapshots')
    async def captured(grant_id:UUID,request:Request):
        who,data=await member(request,Capture)
        return response(await service.captured(who,grant_id,data))
    @app.post('/api/watch-group-import/manifests/{manifest_id}/preview')
    async def preview(manifest_id:UUID,request:Request):
        who,_=await member(request,Empty)
        return response(await service.preview(who,manifest_id))
    @app.post('/api/watch-group-import/manifests/{manifest_id}/operations')
    async def apply(manifest_id:UUID,request:Request):
        who,data=await member(request,Apply)
        return response(await service.apply(who,manifest_id,data))
    @app.get('/api/watch-group-import/manifests/{manifest_id}')
    async def manifest(manifest_id:UUID,request:Request):
        return response(await service.manifest(await member(request,paging=True),manifest_id,after=after(request)))
    @app.get('/api/watch-group-import/manifests/{manifest_id}/raw')
    async def raw(manifest_id:UUID,request:Request):
        payload,digest=await service.raw(await member(request),manifest_id)
        return Response(payload,media_type='application/json',headers={'Cache-Control':'private, no-store','ETag':'"'+digest+'"','Content-Disposition':'attachment; filename="watch-source-'+str(manifest_id)+'.json"'})
    @app.get('/api/watch-group-import/operations/{request_id}')
    async def receipt(request_id:UUID,request:Request):return response(await service.receipt(await member(request),request_id))
    @app.get('/api/watch-group-import/operations/{request_id}/members')
    async def outcomes(request_id:UUID,request:Request):return response(await service.outcomes(await member(request,paging=True),request_id,after(request)))
    @app.post('/api/watch-group-import/operations/{request_id}/close')
    async def close(request_id:UUID,request:Request):
        who,_=await member(request,Empty)
        return response(await service.close(who,request_id))
