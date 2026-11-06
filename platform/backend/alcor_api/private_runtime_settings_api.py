"""Current-administrator configuration without exposing sealed credential values."""

import json
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .fx_provider_parser import unique
from .private_runtime_settings import PrivateRuntimeSettings
from .profile_http import bounded_body
from .security import identity


def mount_private_runtime_settings(app,db):
    service=PrivateRuntimeSettings(db);app.state.private_runtime_settings=service
    headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization'}

    async def admin(request):
        if 'authorization' in request.headers:raise HTTPException(403,'请使用当前网页管理员会话')
        who=await identity(request)
        if who.role!='admin':raise HTTPException(403,'需要管理员权限')
        return who

    async def execute(request,request_id=None):
        try:
            who=await admin(request)
            if request.query_params:raise HTTPException(400,'私有配置不接受查询字段')
            if request_id:return JSONResponse(await service.receipt(who,request_id),headers=headers)
            if request.method=='GET':return JSONResponse(await service.read_admin(who),headers=headers)
            try:raw=json.loads(await bounded_body(request,1024*1024),object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(ValueError()))
            except (ValueError,UnicodeError,RecursionError):raise HTTPException(400,'私有配置JSON无效') from None
            return JSONResponse(await service.save(who,raw),headers=headers)
        except HTTPException as exc:
            return JSONResponse({'error':{'code':exc.status_code*100+1,'message':str(exc.detail)}},status_code=exc.status_code,headers={**headers,**(exc.headers or {}),**({'X-Alcor-Retire-Context':'true'} if exc.status_code in (401,403) else {})})

    @app.get('/api/admin/private-runtime-settings')
    @app.post('/api/admin/private-runtime-settings')
    async def settings(request:Request):return await execute(request)

    @app.get('/api/admin/private-runtime-settings/operations/{request_id}')
    async def receipt(request_id:UUID,request:Request):return await execute(request,str(request_id))
