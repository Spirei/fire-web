"""Read-only public site assets, manifest and licensed stored ticker."""

import hashlib

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .public_site import PublicSite, bundled
from .security import digest


def mount_public_site(app,db):
    service=PublicSite(db);app.state.public_site=service

    def error(exc):
        return JSONResponse({'error':{'code':exc.status_code*100+1,'message':str(exc.detail)}},status_code=exc.status_code,headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})

    def image(request,data,cache='no-cache',version=None):
        etag='"'+hashlib.sha256(data).hexdigest()+'"'
        headers={'Content-Type':'image/png','Cache-Control':cache,'ETag':etag,'X-Content-Type-Options':'nosniff'}
        if version:headers['X-Alcor-Artwork-Version']=version
        if request.headers.get('if-none-match') in (etag,'*'):return Response(status_code=304,headers=headers)
        return Response(data,headers=headers)

    @app.get('/api/pwa-icon')
    async def pwa(request:Request):
        try:
            params=request.query_params
            if set(params)-{'size','v'} or any(len(params.getlist(key))!=1 for key in params):raise HTTPException(400,'桌面图标查询无效')
            try:size=float(params.get('size') or '192')
            except ValueError:raise HTTPException(400,'桌面图标尺寸无效') from None
            if size not in (180,192,512):raise HTTPException(400,'桌面图标尺寸须为180、192或512')
            data,version=await service.icon(int(size),params.get('v'))
            return image(request,data,version=version)
        except HTTPException as exc:return error(exc)

    @app.get('/api/site-favicon')
    async def favicon(request:Request):
        try:
            data,version=await service.icon(64,favicon=True)
            return image(request,data,cache='public, max-age=0, must-revalidate',version=version)
        except HTTPException as exc:return error(exc)

    @app.get('/api/system-assets/mail-banner')
    async def banner(request:Request):
        try:return image(request,await service.mail_banner(),cache='no-store')
        except HTTPException as exc:return error(exc)

    @app.get('/api/system-assets/passkey')
    async def passkey(request:Request):
        return image(request,bundled('public_site_passkey.png'),cache='public, max-age=0, must-revalidate')

    @app.get('/assets/system/{name}')
    async def fixed_resource(name: str, request: Request):
        if name == 'security-check':
            from .system_asset_api import security_check_response
            return security_check_response()
        handlers = {'pwa-icon': pwa, 'site-favicon': favicon,
                    'mail-banner': banner, 'passkey': passkey}
        handler = handlers.get(name)
        if handler is None:
            raise HTTPException(404, '固定公开资源不存在')
        return await handler(request)

    @app.get('/manifest.webmanifest')
    async def manifest():
        try:return JSONResponse(await service.manifest(),media_type='application/manifest+json',headers={'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'})
        except HTTPException as exc:return error(exc)

    @app.get('/api/ticker')
    async def ticker(request:Request):
        try:
            address=request.client.host if request.client else 'unknown'
            if not await app.state.read_rate_limits(db,((digest('public-ticker:'+address),60),('public-ticker-global',300)),window_seconds=60):raise HTTPException(429,'请求过于频繁，请稍后再试')
            result=await service.ticker()
            return JSONResponse(result,status_code=503 if result['state']=='unavailable' else 200,headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
        except HTTPException as exc:return error(exc)
