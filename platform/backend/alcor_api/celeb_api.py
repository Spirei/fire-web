"""Public catalogue and administrator transports over the shared disclosure authorities."""

import asyncio
import json
import re
from decimal import Decimal
from uuid import UUID, uuid5

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

from .celeb_core import Celebs, identifier, latest_on_connection
from .celeb_returns import CelebReturns
from .celeb_sources import CelebSources
from .feed_api import operation_id
from .fx_provider_parser import unique
from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, web_identity
from .market_worker import Bound
from .profile_http import bounded_body
from .record_image_ocr import image_mime
from .security import identity, lock_mutation_identity
from .system_assets import SystemAssets


def legacy_input(raw,action):
    from .asset_catalog_management_api import js_text, trim
    def cut(value,n):return value.encode('utf-16-le',errors='surrogatepass')[:n*2].decode('utf-16-le',errors='surrogatepass')
    if action=='reorder':return {'reorder':[js_text(item) for item in raw['reorder']]}
    key=re.sub('-+','-',re.sub('[^a-z0-9_-]','-',trim(js_text(raw.get('id'))).lower()))[:40]
    result={'id':key}
    if not key:raise HTTPException(400,'缺少 id')
    if action=='delete':return result
    if isinstance(raw.get('name'),str) and trim(raw['name']):result['name']=cut(trim(raw['name']),50)
    if action=='create' and 'name' not in result:raise HTTPException(400,'需要 id 和名称')
    for name,limit in (('title',100),('avatar',None),('cik',20),('entity',100),('sourceLabel',100)):
        if isinstance(raw.get(name),str):result[name]=cut(trim(raw[name]),limit) if limit else trim(raw[name])
    if type(raw.get('enabled')) is bool:result['enabled']=raw['enabled']
    if raw.get('sourceKind') in ('none','13f','form4'):result['sourceKind']=raw['sourceKind']
    for name in ('holdings','trades'):
        if isinstance(raw.get(name),list):result[name]=raw[name]
    for name in ('returns','stockIcons'):
        if isinstance(raw.get(name),dict):result[name]=raw[name]
    hours=raw.get('refreshHours')
    if type(hours) in (int,float,Decimal) and Decimal(str(hours)).is_finite():result['refreshHours']=min(max(hours,0),8760)
    if result.get('cik') and not re.fullmatch('[0-9]{10}',result['cik']):raise HTTPException(400,'CIK 需为 10 位数字')
    return result


class CelebTransport:
    def __init__(self,app,db):
        self.app,self.db=app,db
        self.core,self.sources=Celebs(db),CelebSources(db)
        self.returns=CelebReturns(db,getattr(app.state,'market_authority',None))

    async def administrator(self,request):
        assert_native_origin(request,self.db.settings)
        if 'authorization' in request.headers:
            if not re.fullmatch(r'Bearer [A-Za-z0-9_-]{64}',request.headers['authorization']):raise HTTPException(401,'需要有效旧网页会话')
            who=(await web_identity(request,self.db,allow_legacy_bearer=True,web_bearer_only=True))[0]
            if who.role!='admin':raise HTTPException(403,'需要管理员权限')
            return who,True
        legacy=not request.headers.get('x-csrf-token') and bool(request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE))
        who=(await web_identity(request,self.db))[0] if legacy else await identity(request)
        if who.role!='admin':raise HTTPException(403,'需要管理员权限')
        return who,legacy

    async def body(self,request):
        try:
            value=json.loads(await bounded_body(request,1024*1024),object_pairs_hook=unique,parse_float=Decimal,parse_constant=lambda _:(_ for _ in ()).throw(ValueError()))
            if not isinstance(value,dict):raise TypeError()
            return value
        except (ValueError,TypeError,UnicodeError,RecursionError):raise HTTPException(400,'目录JSON内容无效') from None

    def expected(self,raw,legacy):
        value=raw.pop('expectedRevision',None)
        if value is None and legacy:return None
        if type(value) is not int or not 0<=value<=9007199254740991:raise HTTPException(400,'需要当前目录修订')
        return value

    async def media(self,request,who,legacy,kind):
        multipart=request.headers.get('content-type','').split(';')[0].strip().lower()=='multipart/form-data'
        if not multipart:
            if kind!='stock-icon':raise HTTPException(415,'头像请提交图片表单')
            raw=await self.body(request);rid,tracked=operation_id(request,raw,legacy=legacy);expected=self.expected(raw,legacy)
            if set(raw)!={'id','code','url'}:raise HTTPException(400,'证券图标字段无效')
            celeb_id=identifier(raw['id']);code=raw['code'];url=raw['url']
            if not isinstance(code,str) or not 1<=len(code)<=40:raise HTTPException(400,'证券代码无效')
            async with self.db.connection() as conn,conn.transaction():
                await lock_mutation_identity(conn,who)
                return await self.media_commit(conn,who,celeb_id,expected,kind,code,url,rid),rid,tracked
        await bounded_body(request,2*1024*1024+65536)
        try:
            form=await request.form(max_files=1,max_fields=6,max_part_size=2*1024*1024)
            if set(form)-{'file','id','code','revision','expectedRevision','requestId'} or any(len(form.getlist(key))!=1 for key in form):raise HTTPException(400,'目录图片表单无效')
            file=form.get('file');celeb_id=identifier(form.get('id'))
            if not isinstance(file,UploadFile):raise HTTPException(400,'请选择图片')
            revision=form.get('expectedRevision',form.get('revision'))
            if 'expectedRevision' in form and 'revision' in form and form['expectedRevision']!=form['revision']:raise HTTPException(400,'图片修订不一致')
            if revision is None and legacy:expected=None
            elif isinstance(revision,str) and revision.isascii() and revision.isdecimal() and len(revision)<=16:expected=int(revision)
            else:raise HTTPException(400,'需要当前人物修订')
            raw=await file.read(2*1024*1024+1);await file.close()
            if not raw or len(raw)>2*1024*1024:raise HTTPException(413,'图片最大2MB')
            await asyncio.to_thread(image_mime,raw)
            if not isinstance(file.filename,str) or file.filename.rsplit('.',1)[-1].lower() not in ('png','jpg','jpeg','gif','webp'):raise HTTPException(400,'请选择PNG、JPG、GIF或WebP图片')
            key=form.get('code')
            if kind=='stock-icon' and (not isinstance(key,str) or not 1<=len(key)<=40):raise HTTPException(400,'需要准确证券代码')
            if kind=='avatar' and key is not None:raise HTTPException(400,'头像不接受证券代码')
            rid,tracked=operation_id(request,{'requestId':form['requestId']} if form.get('requestId') else {},legacy=legacy)
            async with self.db.connection() as conn,conn.transaction():
                await lock_mutation_identity(conn,who)
                current=await latest_on_connection(conn,celeb_id,False)
                prior=await(await conn.execute('SELECT result FROM celeb_operations WHERE actor_id=%s AND request_id=%s',(who.id,rid))).fetchone()
                if not prior and expected is not None and current['revision']!=expected:raise HTTPException(409,'人物资料已变化')
                child=str(uuid5(UUID(rid),'celeb-image:'+kind))
                fields={'requestId':child,'kind':'asset','folder':'icon','name':'celeb-'+celeb_id+'-'+rid,'code':''}
                asset_service=SystemAssets(Bound(conn,self.db.settings))
                async with asset_service.context(who,write=True):
                    previous=await(await conn.execute('SELECT result FROM system_asset_operations WHERE request_id=%s',(child,))).fetchone()
                    if previous:
                        # A parent replay must compare file bytes through the original child's fingerprint.
                        fields['expectedRevision']=previous['result']['revision']-1
                    else:
                        fields['expectedRevision']=(await(await conn.execute("SELECT revision FROM system_asset_scope WHERE namespace='system_public'")).fetchone())['revision']
                    assets=await asset_service.upload(who,fields,file.filename,raw,child,True)
                if assets.get('state')!='completed':raise HTTPException(assets.get('httpStatus',409),assets.get('message','素材未完成'))
                result=await self.media_commit(conn,who,celeb_id,expected,kind,key,assets['url'],rid)
                return result,rid,tracked
        except StarletteHTTPException as exc:raise HTTPException(exc.status_code,'图片表单格式无效或超过限制') from None

    async def media_commit(self,conn,who,celeb_id,expected,kind,key,url,rid):
        # Replays compare the original submitted target, not a later icon map.
        prior=await(await conn.execute('SELECT result FROM celeb_operations WHERE actor_id=%s AND request_id=%s',(who.id,rid))).fetchone()
        if prior:
            revision=await(await conn.execute('SELECT raw_input,revision FROM celeb_revisions WHERE actor_id=%s AND request_id=%s AND celeb_id=%s ORDER BY revision LIMIT 1',(who.id,rid,celeb_id))).fetchone()
            original=revision['raw_input'] if revision else {}
            matches=set(original)=={'id','avatar'} and original.get('avatar')==url if kind=='avatar' else set(original)=={'id','stockIcons'} and original.get('stockIcons',{}).get(key)==url
            if not matches or expected is not None and revision['revision']!=expected+1:raise HTTPException(409,'原请求编号已用于其他人物或素材')
            return prior['result']
        current=await latest_on_connection(conn,celeb_id,False)
        return await self.core.set_media_on_connection(conn,who,celeb_id,expected if expected is not None else current['revision'],kind,key,url,rid)

    async def execute(self,request,action='',version=None):
        headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'}
        if version:headers['X-Alcor-API-Version']=str(version)
        try:
            params=request.query_params
            if any(len(params.getlist(key))!=1 for key in params):raise HTTPException(400,'查询参数重复')
            parts=action.split('/') if action else []
            public=request.method=='GET' and (not parts or parts==['returns'] or len(parts)==1 and parts[0] not in ('manage','avatar','stock-icon','sources','operations') or len(parts)==2 and parts[1]=='returns' and parts[0] not in ('sources','operations'))
            if public:
                if not parts:
                    if params:raise HTTPException(400,'人物列表不接受查询参数')
                    result=await self.core.list()
                elif parts==['returns']:
                    if set(params) not in ({'celeb'},{'celebId'}):raise HTTPException(400,'需要celeb或celebId参数')
                    result=await self.returns.read(identifier(params.get('celeb',params.get('celebId'))))
                elif len(parts)==2:
                    if params:raise HTTPException(400,'收益读取不接受查询参数')
                    result=await self.returns.read(identifier(parts[0]))
                else:
                    if params:raise HTTPException(400,'人物详情不接受查询参数')
                    result=await self.core.detail(identifier(parts[0]))
                return JSONResponse({'code':0,'message':'ok','data':result} if version else result,headers=headers)
            if version:raise HTTPException(404,'接口不存在')
            who,legacy=await self.administrator(request)
            if request.method=='GET':
                if params:raise HTTPException(400,'管理读取不接受查询参数')
                if parts==['manage']:
                    result=await self.core.manage(who)
                    if legacy:result={'celebs':result['celebs']}
                elif len(parts)==2 and parts[0]=='operations':result=await self.core.receipt(who,str(UUID(parts[1])))
                elif parts==['sources','targets']:result=await self.sources.targets(who)
                elif len(parts)==3 and parts[:2]==['sources','operations']:result=await self.sources.operation(who,str(UUID(parts[2])))
                elif len(parts)==3 and parts[:2]==['sources','originals']:
                    row,raw=await self.sources.original(who,str(UUID(parts[2])))
                    return Response(raw,media_type='application/octet-stream',headers={**headers,'Content-Disposition':'attachment; filename="disclosure-original.bin"','X-Content-SHA256':row['raw_sha256'],'X-Content-Type-Options':'nosniff'})
                else:raise HTTPException(404,'接口不存在')
                return JSONResponse(result,headers=headers)
            if parts in (['avatar'],['stock-icon']) and request.method=='POST':
                if params:raise HTTPException(400,'素材写入不接受查询参数')
                result,rid,tracked=await self.media(request,who,legacy,parts[0])
            else:
                if request.method=='DELETE':
                    if parts or set(params)-{'id','expectedRevision','requestId'}:raise HTTPException(400,'删除参数无效')
                    if params:
                        if 'id' not in params:raise HTTPException(400,'需要删除目标id')
                        if await bounded_body(request,1024):raise HTTPException(400,'删除参数不可同时放在URL和正文')
                        raw={'id':params['id']}
                        if 'requestId' in params:raw['requestId']=params['requestId']
                        if 'expectedRevision' in params:
                            value=params['expectedRevision']
                            if not value.isascii() or not value.isdecimal() or len(value)>16:raise HTTPException(400,'目录修订无效')
                            raw['expectedRevision']=int(value)
                    else:raw=await self.body(request)
                else:
                    if params:raise HTTPException(400,'写入不接受查询参数')
                    raw=await self.body(request)
                rid,tracked=operation_id(request,raw,legacy=legacy)
                if parts==['sources','collect'] and request.method=='POST':
                    if 'expectedRevision' in raw:
                        if 'revision' in raw and raw['revision']!=raw['expectedRevision']:raise HTTPException(400,'来源版本不一致')
                        raw['revision']=raw.pop('expectedRevision')
                    result=await self.sources.collect(who,{**raw,'requestId':rid})
                elif not parts and request.method in ('POST','PUT','DELETE'):
                    expected=self.expected(raw,legacy)
                    op='create' if request.method=='POST' else 'delete' if request.method=='DELETE' else 'reorder' if 'reorder' in raw else 'update'
                    if legacy:raw=legacy_input(raw,op)
                    result=await self.core.mutate(who,rid,op,raw,expected_revision=expected)
                else:raise HTTPException(404,'接口不存在')
            headers['X-Alcor-Request-Id']=rid
            headers['X-Alcor-Legacy-Client-Idempotency']='true' if tracked else 'false'
            if legacy and 'result' in result and result.get('state')=='completed':
                outcome=result['result']
                if parts==['avatar']:outcome={'avatar':outcome['celeb']['avatar']}
                elif parts==['stock-icon']:outcome={'ok':True,'stockIcons':outcome['celeb']['stockIcons']}
                elif not parts and request.method=='DELETE' or not parts and 'reorder' in outcome:outcome={'ok':True}
                elif not parts and 'celeb' in outcome:outcome={'celeb':outcome['celeb']}
                return JSONResponse(outcome,status_code=201 if request.method=='POST' and not parts else 200,headers=headers)
            return JSONResponse(result,status_code=201 if request.method=='POST' and not parts else 200,headers=headers)
        except (ValueError,TypeError,AttributeError):
            return JSONResponse({'error':'请求参数或UUID无效','code':40001},status_code=400,headers=headers)
        except HTTPException as exc:
            headers.update(exc.headers or {})
            if exc.status_code in (401,403):headers['X-Alcor-Retire-Context']='true'
            return JSONResponse({'code':getattr(exc,'business_code',exc.status_code*100+1),'message':str(exc.detail),'error':str(exc.detail),'data':None},status_code=exc.status_code,headers=headers)


def mount_celebs(app,db):
    service=CelebTransport(app,db);app.state.celebs=service.core;app.state.celeb_sources=service.sources

    def endpoints(method):
        async def catalogue(request:Request):return await service.execute(request)
        async def action(action:str,request:Request):return await service.execute(request,action)
        app.add_api_route('/api/celebs',catalogue,methods=[method],operation_id='celebs_'+method.lower())
        app.add_api_route('/api/celebs/{action:path}',action,methods=[method],operation_id='celeb_action_'+method.lower())
    for method in ('GET','POST','PUT','DELETE'):endpoints(method)

    @app.get('/api/v1/celebs')
    async def v1(request:Request):return await service.execute(request,version=1)

    @app.get('/api/v2/celebs')
    async def v2(request:Request):return await service.execute(request,version=2)

    @app.get('/api/v1/celebs/{celeb_id}')
    async def v1_detail(celeb_id:str,request:Request):return await service.execute(request,celeb_id,version=1)

    @app.get('/api/v2/celebs/{celeb_id}')
    async def v2_detail(celeb_id:str,request:Request):return await service.execute(request,celeb_id,version=2)

    @app.get('/api/v1/celebs/{celeb_id}/returns')
    async def v1_returns(celeb_id:str,request:Request):return await service.execute(request,celeb_id+'/returns',version=1)

    @app.get('/api/v2/celebs/{celeb_id}/returns')
    async def v2_returns(celeb_id:str,request:Request):return await service.execute(request,celeb_id+'/returns',version=2)
