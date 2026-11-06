"""Legacy CRUD and atomic selected deletion use the same checked record authority."""

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import UTC
from decimal import Decimal
from uuid import UUID, uuid4, uuid5

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg.types.json import Jsonb

from .fx_provider_parser import unique
from .legacy_identity import assert_native_origin, web_identity
from .legacy_portfolio import legacy_record, portfolio_member
from .market_contract import digest
from .portfolio_records import PortfolioRecords
from .profile_http import bounded_body
from .security import lock_mutation_identity


class TransactionDB:
    def __init__(self,db,conn):
        self.settings,self.conn=db.settings,conn

    @asynccontextmanager
    async def connection(self):
        yield self.conn



class ReadOnlyRecords(PortfolioRecords):
    def __init__(self,db,who):
        super().__init__(db)
        self.who=who

    async def lock(self,conn,owner,authorization=None):
        if self.who.id!=owner:
            raise HTTPException(403,'账号不匹配')
        return await self.read_lock(conn,owner,self.who)


async def compatibility_receipt(conn,owner,rid):
    installed=await(await conn.execute("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name='0116_legacy_record_commands.sql') AS installed,to_regclass('public.portfolio_compatibility_receipts') IS NOT NULL AS present")).fetchone()
    if installed['installed']!=installed['present']:
        raise HTTPException(503,'记录兼容回执结构尚未完整可用')
    if not installed['present']:
        return None
    return await(await conn.execute('SELECT result FROM portfolio_compatibility_receipts WHERE owner_id=%s AND request_id=%s',(owner,rid))).fetchone()


async def purge_record_batch_previews(conn,owner):
    state=await(await conn.execute("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name='0116_legacy_record_commands.sql') AS installed,to_regclass('public.portfolio_batch_previews') IS NOT NULL AS present")).fetchone()
    if state['installed']!=state['present']:
        raise HTTPException(503,'记录批量预览结构尚未完整可用')
    if state['present']:
        await conn.execute('DELETE FROM portfolio_batch_previews WHERE owner_id=%s',(owner,))


def request_uuid(value):
    if not isinstance(value,str):
        raise HTTPException(400,'requestId 须为小写 UUID')
    try:
        result=UUID(value)
    except ValueError:
        raise HTTPException(400,'requestId 须为小写 UUID') from None
    if str(result)!=value:
        raise HTTPException(400,'requestId 须为小写 UUID')
    return result


def record_input(raw, strict, *, web=False):
    from .portfolio_records import TEXT_LIMITS
    if strict and not {'name','code','market','price','cost','qty','group','note'}<=set(raw):
        raise HTTPException(400,'记录缺少完整必填字段')
    result={}
    for field,limit in TEXT_LIMITS.items():
        if field not in raw and field in ('brokerAccountId','accountMarket','watchGroupId'):
            continue
        value=raw.get(field,'OTHER' if field=='market' else '')
        if strict and (not isinstance(value,str) or len(value.encode('utf-16-le'))//2>limit):
            raise HTTPException(400,field+' 无效')
        if value is None:
            value=''
        elif not isinstance(value,str):
            # Legacy loose inputs stringify metadata, but never a financial number into zero.
            value=str(value) if type(value) in (int,Decimal,bool) else '[object Object]'
        result[field]=value.strip()[:limit] if not strict and field in ('group','note','source') else value.strip()
    for field in ('price','cost','qty'):
        value=raw.get(field)
        if value is None or value=='':
            result[field]=None
            continue
        if strict and type(value) not in (int,Decimal):
            raise HTTPException(400,field+' 须为有限数值或空值')
        if isinstance(value,bool):
            if strict:
                raise HTTPException(400,field+' 须为有限数值或空值')
            value=int(value)
        try:
            parsed=Decimal(str(value).strip())
            if not parsed.is_finite():
                raise ValueError()
            result[field]=format(parsed,'f')
        except (ValueError,ArithmeticError):
            if strict:
                raise HTTPException(400,field+' 须为有限数值或空值') from None
            result[field]=None
    if not strict and not web:
        result.pop('watchGroupId',None)
    return result


class RecordCommands:
    def __init__(self,db):
        self.db=db

    async def receipt(self,who,rid):
        async with self.db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who,require_admin=False)
            row=await(await conn.execute('SELECT result FROM portfolio_compatibility_receipts WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if not row:
                raise HTTPException(404,'未找到已提交回执')
            return row['result']

    async def mutate(self,who,kind,record_id,raw,*,web=False,request_header=None):
        if not isinstance(raw,dict):
            raise HTTPException(400,'无效的请求体')
        tracked='requestId' in raw or request_header is not None
        rid=request_uuid(raw.get('requestId',request_header)) if tracked else uuid4()
        if request_header is not None and str(request_uuid(request_header))!=str(rid):
            raise HTTPException(400,'请求编号不一致')
        fields={'requestId','revision'} if kind=='delete' else {'requestId','revision','name','code','market','price','cost','qty','group','note','source','watchGroupId','accountMarket','brokerAccountId'}
        if tracked and set(raw)-fields or kind=='create' and 'revision' in raw:
            raise HTTPException(400,'请求含未知字段或新建接受了旧版本')
        if (tracked and kind!='create' or 'revision' in raw) and (type(raw.get('revision')) is not int or not 1<=raw['revision']<=9007199254740991):
            raise HTTPException(400,'revision 须为正整数')
        data=None if kind=='delete' else record_input(raw,tracked,web=web)
        hashed=digest({'kind':kind,'id':record_id,'data':data,'revision':raw.get('revision')})
        async with self.db.connection() as conn,conn.transaction():
            service=PortfolioRecords(TransactionDB(self.db,conn))
            collection=await service.lock(conn,who.id,who)
            if await(await conn.execute('SELECT 1 FROM portfolio_request_reservations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone():
                raise HTTPException(409,'requestId 已使用，请只读查询原操作')
            old=await service.get(conn,who.id,record_id) if kind!='create' else None
            result=None
            try:
                # Domain rejections leave a durable strict receipt while all child effects roll back.
                async with conn.transaction():
                    if kind!='create' and old is None:
                        raise HTTPException(404,'记录不存在')
                    revision=raw.get('revision',old['revision'] if old else None)
                    proof=await service.preview(who.id,kind,data or {},record_id=record_id,revision=revision,authorization=who)
                    result=await service.confirm(who.id,proof['previewId'],rid,authorization=who)
            except HTTPException as exc:
                if exc.status_code in (401,403):
                    raise
                result={'requestId':str(rid),'kind':kind,'recordId':record_id,'state':'failed','code':40902 if exc.status_code==409 else exc.status_code*100+1,
                        'message':str(exc.detail),'record':None,'deleted':False,'revision':None,'collectionRevision':collection}
            now=(await(await conn.execute('SELECT clock_timestamp() AS at')).fetchone())['at'].astimezone(UTC).isoformat(timespec='milliseconds').replace('+00:00','Z')
            if result['state']=='completed':
                result={key:result[key] for key in ('requestId','kind','recordId','state','deleted','revision','collectionRevision')}|{'code':0,'message':'ok',
                    'record':legacy_record((await(await conn.execute('SELECT result FROM portfolio_record_operations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone())['result']['record']) if kind!='delete' else None}
            result.update(createdAt=now,completedAt=now)
            children=[rid] if result['state']=='completed' else []
            await conn.execute('INSERT INTO portfolio_compatibility_receipts(owner_id,request_id,kind,request_hash,child_requests,result) VALUES(%s,%s,%s,%s,%s,%s)',
                               (who.id,rid,kind,hashed,children,Jsonb(result)))
            return result,tracked

    async def preview_batch(self,who,raw):
        if not isinstance(raw,dict) or set(raw)!={'collectionRevision','records'} or type(raw['collectionRevision']) is not int or raw['collectionRevision']<0:
            raise HTTPException(422,'须提供当前集合版本与明确记录列表')
        records=raw['records']
        if not isinstance(records,list) or not 1<=len(records)<=200:
            raise HTTPException(422,'单次请选择1至200条记录')
        if any(not isinstance(row,dict) or set(row)!={'id','revision'} or not isinstance(row['id'],str) or not 1<=len(row['id'])<=100
               or type(row['revision']) is not int or row['revision']<1 for row in records) or len({row['id'] for row in records})!=len(records):
            raise HTTPException(422,'记录身份重复或版本无效')
        async with self.db.connection() as conn,conn.transaction():
            service=PortfolioRecords(TransactionDB(self.db,conn))
            collection=await service.lock(conn,who.id,who)
            if collection!=raw['collectionRevision']:
                raise HTTPException(409,'集合已变化，请重新读取后确认')
            chosen=[]
            for item in sorted(records,key=lambda row:row['id']):
                row=await service.get(conn,who.id,item['id'])
                if not row or row['revision']!=item['revision']:
                    raise HTTPException(409,'记录已变化或不属于本人')
                await service.check(conn,who.id,'delete',row,None)
                chosen.append({key:row[key] for key in ('id','revision','name','code','market')})
            pid=uuid4()
            stored=await(await conn.execute('INSERT INTO portfolio_batch_previews(owner_id,id,session_hash,collection_revision,records) VALUES(%s,%s,%s,%s,%s) RETURNING expires_at',
                (who.id,pid,who.token_hash,collection,Jsonb(chosen)))).fetchone()
            return {'previewId':str(pid),'kind':'batch_delete','records':chosen,'count':len(chosen),'collectionRevision':collection,'expiresAt':stored['expires_at'].isoformat()}

    async def confirm_batch(self,who,pid,rid,*,kind='batch_delete'):
        pid,rid=UUID(str(pid)),UUID(str(rid))
        async with self.db.connection() as conn,conn.transaction():
            service=PortfolioRecords(TransactionDB(self.db,conn))
            current=await service.lock(conn,who.id,who)
            if await(await conn.execute('SELECT 1 FROM portfolio_request_reservations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone():
                raise HTTPException(409,'requestId 已使用，请查询原回执')
            proof=await(await conn.execute('SELECT *,expires_at>clock_timestamp() AS valid FROM portfolio_batch_previews WHERE owner_id=%s AND id=%s FOR UPDATE',(who.id,pid))).fetchone()
            if not proof or not proof['valid'] or proof['consumed_at'] is not None or proof['session_hash']!=who.token_hash or proof['collection_revision']!=current:
                raise HTTPException(409,'批量预览已过期或集合、会话已变化')
            children=[]
            for item in proof['records']:
                child=uuid5(rid,'record-delete:'+item['id'])
                prepared=await service.preview(who.id,'delete',{},record_id=item['id'],revision=item['revision'],authorization=who)
                await service.confirm(who.id,prepared['previewId'],child,authorization=who)
                children.append(child)
            head=await(await conn.execute('SELECT revision FROM portfolio_record_collections WHERE owner_id=%s',(who.id,))).fetchone()
            result={'requestId':str(rid),'kind':kind,'state':'completed','deleted':len(children),'recordIds':[item['id'] for item in proof['records']],
                    'collectionRevision':head['revision'],'childRequestIds':[str(child) for child in children]}
            await conn.execute('INSERT INTO portfolio_compatibility_receipts(owner_id,request_id,kind,request_hash,child_requests,result) VALUES(%s,%s,%s,%s,%s,%s)',
                (who.id,rid,kind,digest({'previewId':str(pid),'kind':kind}),children,Jsonb(result)))
            await conn.execute('UPDATE portfolio_batch_previews SET consumed_at=clock_timestamp() WHERE owner_id=%s AND id=%s',(who.id,pid))
            return result


def mount_legacy_record_writes(app,settings,db):
    service=RecordCommands(db)
    app.state.legacy_record_commands=service

    async def execute(request,kind,record_id='',*,web=False):
        headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'}
        try:
            assert_native_origin(request,settings)
            if web:
                if request.headers.get('authorization','').startswith('Bearer fat_'):
                    raise HTTPException(401,'接口不接受 App 连接')
                who=(await web_identity(request,db,allow_v1_bearer=True))[0]
            else:
                who=await portfolio_member(request,settings,db,write=True)
            if not await app.state.rate_limit(db,'records-write:'+who.id,120,window_seconds=60):
                raise HTTPException(429,'提交过于频繁')
            raw_bytes=await bounded_body(request,16384)
            raw={} if not raw_bytes and request.method=='DELETE' and 'content-type' not in request.headers and 'transfer-encoding' not in request.headers else json.loads(raw_bytes,parse_float=Decimal,object_pairs_hook=unique,
                            parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
            header_id=request.headers.get('x-alcor-request-id')
            if kind in ('batch_delete','clear'):
                if not web or not isinstance(raw,dict):
                    raise HTTPException(400,'批量请求无效')
                rid=request_uuid(header_id) if header_id is not None else uuid4()
                async with db.connection() as conn,conn.transaction():
                    bound=RecordCommands(TransactionDB(db,conn))
                    records=PortfolioRecords(TransactionDB(db,conn))
                    collection=await records.lock(conn,who.id,who)
                    if kind=='clear':
                        if not await app.state.rate_limit(db,'records-clear:'+who.id,5,window_seconds=3600):
                            raise HTTPException(429,'尝试过于频繁，请稍后再试')
                        if set(raw)-{'password','collectionRevision'} or raw.get('collectionRevision')!=collection or type(raw.get('collectionRevision')) is not int:
                            raise HTTPException(409,'全量清除须明确当前记录集合版本')
                        from .passwords import verify_password
                        user=await(await conn.execute('SELECT password_hash FROM users WHERE id=%s FOR SHARE',(who.id,))).fetchone()
                        if not isinstance(raw.get('password'),str) or not await asyncio.to_thread(verify_password,raw['password'],user['password_hash']):
                            raise HTTPException(403,'当前密码错误')
                        rows=await(await conn.execute('SELECT id,revision FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 201',(who.id,))).fetchall()
                        if len(rows)>200:
                            raise HTTPException(409,'当前集合超过200条，请先分批核对')
                    else:
                        ids=list(dict.fromkeys(value for value in raw.get('ids',[]) if isinstance(value,str) and 0<len(value)<=100)) if isinstance(raw.get('ids'),list) else []
                        if not ids or len(ids)>200:
                            raise HTTPException(400,'请选择要删除的记录（单次最多200条）')
                        expected=raw.get('collectionRevision')
                        if expected is not None and (type(expected) is not int or expected!=collection):
                            raise HTTPException(409,'记录集合已变化')
                        rows=await(await conn.execute('SELECT id,revision FROM portfolio_records WHERE owner_id=%s AND id=ANY(%s) AND deleted_at IS NULL ORDER BY id',(who.id,ids))).fetchall()
                        if not rows:
                            raise HTTPException(404,'记录不存在')
                    if not rows:
                        raise HTTPException(409,'当前集合为空，没有可确认的删除目标')
                    proof=await bound.preview_batch(who,{'collectionRevision':collection,'records':rows})
                    outcome=await bound.confirm_batch(who,proof['previewId'],rid,kind=kind)
                headers['X-Alcor-Request-Id']=str(rid)
                return JSONResponse({'ok':True,'deleted':outcome['deleted']} if kind=='batch_delete' else
                                    {'ok':True,'records':outcome['deleted'],'orders':0,'activities':0,'fundTransactions':0,
                                     'financialAndAuditHistoryRetained':True},headers=headers)
            result,tracked=await service.mutate(who,kind,record_id,raw,web=web,request_header=header_id)
            headers['X-Alcor-Request-Id']=result['requestId']
            headers['X-Alcor-Records-Revision']=str(result['collectionRevision'])
            meta={key:result[key] for key in ('requestId','kind','recordId','revision','collectionRevision')}
            if result['state']=='failed':
                payload={'error':result['message'],'code':result['code']} if web else {'code':result['code'],'message':result['message'],**({'meta':meta} if tracked else {})}
                return JSONResponse(payload,status_code=result.get('httpStatus',result['code']//100),headers=headers)
            data=({'ok':True} if web else {'deleted':True,'id':result['recordId'],'revision':result['revision']} if tracked else {'deleted':True}) if kind=='delete' else result['record']
            return JSONResponse(data if web else {'code':0,'message':'ok','data':data,**({'meta':meta} if tracked else {})},
                                status_code=201 if web and kind=='create' else 200,headers=headers)
        except HTTPException as exc:
            headers.update(exc.headers or {})
            if exc.status_code in (401,403):
                headers['X-Alcor-Retire-Context']='true'
            value={'error':str(exc.detail),'code':getattr(exc,'business_code',exc.status_code*100+1)} if web else {'code':getattr(exc,'business_code',exc.status_code*100+1),'message':str(exc.detail)}
            return JSONResponse(value,status_code=exc.status_code,headers=headers)
        except (ValueError,TypeError,UnicodeError,ArithmeticError):
            return JSONResponse({'error':'请求体不合法','code':40001} if web else {'code':40001,'message':'请求体不合法'},status_code=400,headers=headers)

    def handler(kind,web):
        async def route(request:Request,record_id:str=''):
            return await execute(request,kind,record_id,web=web)
        return route
    for base,web in (('/api/records',True),('/api/v1/records',False),('/api/v2/records',False)):
        app.add_api_route(base,handler('create',web),methods=['POST'])
        app.add_api_route(base+'/{record_id}',handler('update',web),methods=['PUT'])
        app.add_api_route(base+'/{record_id}',handler('delete',web),methods=['DELETE'])
    app.add_api_route('/api/records/batch-delete',handler('batch_delete',True),methods=['POST'])
    app.add_api_route('/api/records',handler('clear',True),methods=['DELETE'])

    @app.get('/api/records/operations/{request_id}')
    async def web_operation(request_id:str,request:Request):
        who=(await web_identity(request,db,allow_v1_bearer=True))[0]
        value=await service.receipt(who,request_uuid(request_id))
        return JSONResponse(value,headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'})
