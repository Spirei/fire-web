"""Owner-only simple ledger and bounded workbook candidate tools."""
import hashlib
import re
from uuid import uuid4

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from .legacy_identity import assert_native_origin
from .profile_http import bounded_body
from .security import COOKIE, identity
from .simple_ledger import SimpleLedger, decimal_json, exact_json, legacy_wire
from .simple_ledger_xlsx import export

HEADERS={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization'}


def exact_response(value,*,status_code=200,headers=None):
    return Response(exact_json(value).encode('utf-8'),status_code=status_code,media_type='application/json',headers=headers)



def mount_simple_ledger(app,db):
    service=SimpleLedger(db); app.state.simple_ledger=service

    async def actor(request,version=0,write=False):
        assert_native_origin(request,db.settings)
        from .legacy_identity import OLD_COOKIE, WEB_COOKIE, native_identity, web_identity
        from .legacy_optional_credentials import credentials_present
        from .native_app_auth import CLIENT
        authorization=request.headers.get('authorization')
        tool=request.url.path.startswith('/api/simple-app/tool/')
        if version or tool or authorization is not None or COOKIE not in request.cookies:credentials_present(request)
        if version==2 or version==1 and authorization and authorization.startswith('Bearer fat_'):
            if not authorization or not re.fullmatch(r'Bearer fat_[A-Za-z0-9_-]{43}',authorization):raise HTTPException(401,'需要当前App连接')
            who,grant=await native_identity(request,db,'portfolio.write' if write else 'portfolio.read')
            if grant['client_id']!=CLIENT:raise HTTPException(401,'客户端连接不匹配')
        elif version or tool:
            if authorization is not None:
                if not re.fullmatch(r'Bearer [A-Za-z0-9_-]{64}',authorization):raise HTTPException(401,'旧网页会话无效')
                who=(await web_identity(request,db,allow_legacy_bearer=True))[0]
            elif request.cookies.get(COOKIE) and (request.headers.get('x-csrf-token') or not any(key in request.cookies for key in (WEB_COOKIE,OLD_COOKIE))):
                who=await identity(request)
            else:who=(await web_identity(request,db))[0]
            if getattr(who,'legacy_client',False):
                async with db.connection() as conn:
                    bound=await(await conn.execute('SELECT client_id FROM sessions WHERE token_hash=%s AND user_id=%s',(who.token_hash,who.id))).fetchone()
                if not bound:raise HTTPException(401,'旧会话已失效')
                who.simple_session_client=bound['client_id']
        else:
            if authorization is not None:raise HTTPException(403,'请使用当前网页登录会话')
            who=await identity(request)
        if request.headers.get('x-simple-ledger-user',who.id)!=who.id: raise HTTPException(409,'当前账号已切换，请刷新后重试')
        return who

    async def body(request,limit=2*1024*1024):
        try: value=decimal_json(await bounded_body(request,limit))
        except (ValueError,UnicodeError,RecursionError): raise HTTPException(400,'无效JSON') from None
        if not isinstance(value,dict): raise HTTPException(400,'请求须为对象')
        return value

    def ledger_endpoint(version):
        async def endpoint(request:Request):
            try:
                who=await actor(request,version,request.method=='PUT')
                if request.query_params: raise HTTPException(400,'不支持查询参数')
                if request.method=='GET':
                    current=await service.read(who,legacy=bool(version)); result=current['ledger'] if version else current
                else:
                    raw=await body(request)
                    if version and request.headers.get('x-alcor-request-id'):
                        if raw.get('requestId') is not None and raw['requestId']!=request.headers['x-alcor-request-id']:raise HTTPException(400,'原操作编号不一致')
                        raw['requestId']=request.headers['x-alcor-request-id']
                    current=await service.save(who,raw,legacy=bool(version));result=current['ledger'] if version else current
                headers={**HEADERS,**({'X-Alcor-Request-Id':current['requestId'],'X-Alcor-Legacy-Client-Idempotency':str(current['legacyClientIdempotency']).lower()} if request.method=='PUT' else {})}
                if version:return JSONResponse({'code':0,'message':'ok','data':legacy_wire(result)},headers=headers)
                return exact_response(result,headers=headers)
            except HTTPException as exc:
                if not version: raise
                return JSONResponse({'code':exc.status_code*100+1,'message':str(exc.detail),'data':None},status_code=exc.status_code,headers=HEADERS)
        return endpoint

    for version,path in ((0,'/api/account/simple-ledger'),(1,'/api/v1/simple-ledger'),(2,'/api/v2/simple-ledger')):
        for method in ('GET','PUT'): app.add_api_route(path,ledger_endpoint(version),methods=[method],operation_id=f'simple_ledger_{version}_{method.lower()}')

    @app.get('/api/account/simple-ledger/revision')
    async def revision(request:Request):
        who=await actor(request)
        if request.query_params:raise HTTPException(400,'不支持查询参数')
        return JSONResponse(await service.read_revision(who),headers=HEADERS)

    def recovery_endpoint(version,close_operation=False):
        async def endpoint(rid:str,request:Request):
            try:
                who=await actor(request,version,close_operation)
                if request.query_params:raise HTTPException(400,'不支持查询参数')
                if close_operation:
                    if await bounded_body(request,1024) not in (b'',b'{}'):raise HTTPException(400,'关闭只接受原操作编号')
                    result=await service.close(who,rid)
                else:result=await service.receipt(who,rid)
                return JSONResponse({'code':0,'message':'ok','data':legacy_wire(result)},headers=HEADERS)
            except HTTPException as exc:return JSONResponse({'code':exc.status_code*100+1,'message':str(exc.detail),'data':None},status_code=exc.status_code,headers=HEADERS)
        return endpoint
    for version in (1,2):
        app.add_api_route(f'/api/v{version}/simple-ledger/operations/{{rid}}',recovery_endpoint(version),methods=['GET'])
        app.add_api_route(f'/api/v{version}/simple-ledger/operations/{{rid}}/close',recovery_endpoint(version,True),methods=['POST'])

    @app.get('/api/account/simple-ledger/operations/{rid}')
    async def operation(rid:str,request:Request):
        return exact_response(await service.receipt(await actor(request),rid),headers=HEADERS)

    @app.post('/api/account/simple-ledger/operations/{rid}/close')
    async def close(rid:str,request:Request):
        if request.query_params or await bounded_body(request,1024) not in (b'',b'{}'):raise HTTPException(400,'关闭只接受原操作编号')
        return exact_response(await service.close(await actor(request,write=True),rid),headers=HEADERS)

    @app.get('/api/account/simple-ledger/originals/{rid}')
    async def original(rid:str,request:Request):
        from .simple_ledger import request_id
        who=await actor(request); rid=request_id(rid)
        async with db.connection() as conn,conn.transaction():
            await service.lock(conn,who)
            row=await(await conn.execute('SELECT raw,sha256 FROM simple_ledger_files WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if not row: raise HTTPException(404,'未查到原文件')
            raw=bytes(row['raw'])
            if hashlib.sha256(raw).hexdigest()!=row['sha256']:raise HTTPException(503,'原文件完整性不可验证')
            return Response(raw,media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',headers={**HEADERS,'Content-Disposition':'attachment; filename="simple-ledger-source.xlsx"','X-Content-SHA256':row['sha256']})

    async def import_workbook(request:Request):
        who=await actor(request,write=True)
        await bounded_body(request,10*1024*1024+256*1024)
        form=await request.form(max_files=1,max_fields=4,max_part_size=10*1024*1024)
        if set(form)-{'file','requestId'} or any(len(form.getlist(key))!=1 for key in form):
            raise HTTPException(400,'文件字段无效')
        file=form.get('file')
        if not hasattr(file,'read'): raise HTTPException(400,'缺少文件')
        if not str(file.filename or '').lower().endswith('.xlsx') and 'spreadsheetml' not in str(file.content_type): raise HTTPException(400,'仅支持xlsx；JSON请使用账本保存接口')
        raw=await file.read(10*1024*1024+1)
        await file.close()
        if len(raw)>10*1024*1024: raise HTTPException(413,'文件不能超过10MiB')
        if form.get('requestId') and request.headers.get('x-alcor-request-id') and form['requestId']!=request.headers['x-alcor-request-id']:raise HTTPException(400,'原操作编号不一致')
        supplied=form.get('requestId') or request.headers.get('x-alcor-request-id')
        result=await service.import_file(who,supplied or str(uuid4()),raw)
        return exact_response({**result,'legacyClientIdempotency':bool(supplied)},status_code=result.get('httpStatus',200),headers={**HEADERS,'X-Alcor-Request-Id':result['requestId']})

    async def export_workbook(request:Request):
        who=await actor(request)
        raw=await body(request)
        # Legacy exports an explicitly supplied independent investment list;
        # canonical defaults to the saved ledger, never the broker authority.
        current=await service.read(who,legacy=request.url.path.startswith('/api/simple-app/tool/'))
        invest=raw.get('invest') if request.url.path.startswith('/api/simple-app/tool/') else raw.get('invest',current['ledger']['invest'])
        return Response(export(invest),media_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',headers={**HEADERS,'Content-Disposition':'attachment; filename="alcor-simple-invest.xlsx"'})

    def tool_endpoint(function):
        async def endpoint(request:Request):
            try:return await function(request)
            except StarletteHTTPException as exc:return JSONResponse({'ok':False,'error':str(exc.detail)},status_code=exc.status_code,headers=HEADERS)
        return endpoint

    for path in ('/api/simple-app/tool/import','/api/account/simple-ledger/tool/import'):
        app.add_api_route(path,tool_endpoint(import_workbook),methods=['POST'])
    for path in ('/api/simple-app/tool/export','/api/account/simple-ledger/tool/export'):
        app.add_api_route(path,tool_endpoint(export_workbook),methods=['POST'])
