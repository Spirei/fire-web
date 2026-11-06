"""Public, read-only person originals; GET never refreshes or translates."""

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .public_square import DUAN_USER, SOURCE, PublicSquare
from .security import digest


def mount_public_square(app,db):
    service=PublicSquare(db)
    app.state.public_square=service

    async def respond(request,author=None,*,legacy=False):
        headers={'Cache-Control':'no-store','Vary':'Origin'}
        try:
            caller=request.client.host if request.client else 'unknown'
            if not await app.state.rate_limit(db,digest('public-square:'+caller),60,window_seconds=60):
                raise HTTPException(429,'请求过于频繁，请稍后读取')
            allowed={'refresh'} if legacy else {'author','cursor','limit'}
            params=request.query_params
            if set(params)-allowed or any(len(params.getlist(key))!=1 for key in params):raise HTTPException(400,'人物动态查询参数无效')
            if legacy and params.get('refresh') not in (None,'0','1'):raise HTTPException(400,'刷新参数无效')
            if not legacy:
                author=params.get('author') or None
                raw=params.get('limit','30')
                if not raw.isascii() or not raw.isdecimal() or len(raw)>3:raise HTTPException(400,'分页条数无效')
                limit=int(raw)
            else:limit=5000
            result=await service.read(author=author,cursor=params.get('cursor'),limit=limit,legacy=legacy)
            if legacy:
                if result['state'] not in ('observed','partial') or not result['posts']:raise HTTPException(503,'公共人物来源尚未完整许可或不可用；未触发抓取')
                if author=='duan':result={**result,'user':DUAN_USER,'source':'cache'}
                elif author=='trump':result={**result,'source':SOURCE,'fetchedAt':result['updatedAt'],'cached':True}
                else:
                    result={**result,'source':'local-cache'}
                    result['posts']=[{key:value for key,value in post.items() if key not in ('images','media')} for post in result['posts']]
                    for post in result['posts']:
                        if isinstance(post.get('quote'),dict):post['quote']={key:value for key,value in post['quote'].items() if key!='images'}
                result['migration']={'refreshRequested':params.get('refresh')=='1','refreshExecuted':False,'collectionOnRead':False}
            return JSONResponse(result,headers=headers)
        except HTTPException as exc:
            return JSONResponse({'error':{'code':exc.status_code*100+1,'message':str(exc.detail)},'posts':[],'collectionOnRead':False},status_code=exc.status_code,headers=headers)

    @app.get('/api/public-square')
    async def public(request:Request):return await respond(request)

    @app.get('/api/trading-square/duan')
    async def duan(request:Request):return await respond(request,'duan',legacy=True)

    @app.get('/api/trading-square/trump')
    async def trump(request:Request):return await respond(request,'trump',legacy=True)

    @app.get('/api/trading-square/feed')
    async def feed(request:Request):return await respond(request,legacy=True)
