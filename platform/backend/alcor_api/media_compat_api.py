"""Legacy library and media reads, bound only to registered versions."""

import json
import re
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .fx_provider_parser import unique
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, web_identity
from .media_compat import MediaCompat, standard
from .personal_fonts import PersonalFonts
from .profile_http import bounded_body
from .security import identity
from .system_asset_api import content


def mount_media_compat(app,db):
    service=MediaCompat(db);app.state.media_compat=service

    async def member(request,admin=False,canonical=False):
        if 'authorization' in request.headers:raise HTTPException(403,'请使用当前网页会话')
        if not canonical and 'x-csrf-token' not in request.headers and (request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE)):
            who=(await web_identity(request,db))[0]
        else:who=await identity(request)
        if admin and who.role!='admin':raise HTTPException(403,'需要管理员权限')
        return who

    def error(exc):
        return JSONResponse({'error':str(exc.detail),'code':exc.status_code*100+1},status_code=exc.status_code,
            headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization',**(exc.headers or {}),**({'X-Alcor-Retire-Context':'true'} if exc.status_code in (401,403) else {})})

    @app.get('/api/attachments/library')
    async def library(request:Request):
        try:
            who=await member(request,True)
            if set(request.query_params)-{'paged','type','market','q','sort','page','pageSize'} or any(len(request.query_params.getlist(key))!=1 for key in request.query_params):raise HTTPException(400,'素材目录查询参数无效')
            return JSONResponse(await service.library(who,request.query_params),headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization'})
        except HTTPException as exc:return error(exc)

    @app.get('/api/media-aliases')
    async def aliases(request:Request):
        try:
            if request.query_params:raise HTTPException(400,'映射读取不接受额外字段')
            return JSONResponse(await service.list_aliases(await member(request,canonical=True)),headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization'})
        except HTTPException as exc:return error(exc)

    @app.post('/api/media-aliases')
    async def register(request:Request):
        try:
            who=await member(request,canonical=True)
            if request.query_params:raise HTTPException(400,'映射写入不接受额外字段')
            try:
                raw=json.loads(await bounded_body(request,16384),object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(ValueError()))
            except (ValueError,UnicodeError,RecursionError):raise HTTPException(400,'映射JSON无效') from None
            return JSONResponse(await service.register(who,raw),headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization'})
        except (ValueError,TypeError):return error(HTTPException(400,'映射目标编号无效'))
        except HTTPException as exc:return error(exc)

    @app.get('/api/media-aliases/operations/{request_id}')
    async def receipt(request_id:UUID,request:Request):
        try:
            if request.query_params:raise HTTPException(400,'回执读取不接受额外字段')
            return JSONResponse(await service.receipt(await member(request,canonical=True),str(request_id)),headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization'})
        except HTTPException as exc:return error(exc)

    async def download(request,path,*,managed=False,report=False):
        private=report or path.lower().startswith(('reports/','alcor-test/'))
        try:
            if managed and path.split('/')[0] not in ('asset','cards'):
                raise HTTPException(404,'托管素材路径不存在')
            if re.search(b'%2f|%5c|%00',request.scope.get('raw_path',b''),re.IGNORECASE):raise HTTPException(400,'旧媒体路径无效')
            sha=request.query_params.get('sha256')
            if sha is not None and (len(request.query_params.getlist('sha256'))!=1 or not re.fullmatch('[a-f0-9]{64}',sha)):raise HTTPException(400,'媒体版本摘要无效')
            full='/uploads/'+('reports/' if report else '')+path
            if path.startswith('fonts/') and not report and not managed:
                who=await member(request)
                row,stream=await PersonalFonts(db).original(who,path[len('fonts/'):])
                row=standard(row)
                return content(request,row,stream,private=True)
            who=None
            private=report or path.lower().startswith(('reports/','alcor-test/'))
            if private:who=await member(request,True)
            try:row,stream,protected=await service.resolve(full,who,managed=managed,sha=sha)
            except HTTPException as exc:
                if exc.status_code!=404 or who is not None:raise
                # Public lookup never turns an unknown URL into a guessed owner file.
                if not (request.headers.get('authorization') or request.headers.get('cookie')):raise
                who=await member(request)
                row,stream,protected=await service.resolve(full,who,managed=managed,sha=sha)
            if sha is not None and row['served_sha256']!=sha:
                stream.close();raise HTTPException(404,'指定媒体版本不存在')
            return content(request,row,stream,private=protected,immutable=not protected and sha is not None)
        except (ValueError,TypeError):return error(HTTPException(400,'媒体映射目标无效'))
        except HTTPException as exc:
            if private and exc.status_code in (401,403):
                return Response('Forbidden',status_code=403,media_type='text/plain',headers={
                    'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Alcor-Retire-Context':'true'})
            return error(exc)

    @app.get('/api/managed-upload/{path:path}')
    async def managed(path:str,request:Request):return await download(request,path,managed=True)

    @app.get('/api/upload-files/{path:path}')
    async def uploaded(path:str,request:Request):return await download(request,path)

    @app.get('/api/private-reports/{path:path}')
    async def report(path:str,request:Request):return await download(request,path,report=True)
