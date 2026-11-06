"""Private card-wallet reads, masked metadata and preview-only financial mutation adapters."""

import json
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from fastapi import HTTPException, Request

from .card_catalog_contract import clean
from .card_preferences import JS_WHITESPACE, card_key, sqlite_text
from .card_preferences_protocol import card_member, wire_response
from .card_wallet import CardWallet
from .profile_http import bounded_body
from .security import identity


def mount_card_wallet(app,settings,db,rate_limit):
    service=CardWallet(db)
    app.state.card_wallet=service

    async def member(request,legacy=False):
        if legacy:
            return await card_member(request,db)
        if 'authorization' in request.headers:
            raise HTTPException(403,'请使用当前网页登录会话')
        return await identity(request)

    async def body(request,limit=16384):
        try:
            def invalid(_):
                raise ValueError()
            value=json.loads((await bounded_body(request,limit)).decode('utf-8-sig'),parse_float=Decimal,parse_constant=invalid)
            if not isinstance(value,dict):
                raise TypeError()
            return value
        except (ValueError,TypeError,UnicodeError,RecursionError):
            raise HTTPException(400,'请求格式无效') from None

    async def execute(request,action,legacy=False,identifier=None):
        headers={'Cache-Control':'no-store' if legacy else 'no-store, private','Vary':'Cookie, Authorization','X-Alcor-Source-Coverage':'platform-manual-only'}
        try:
            who=await member(request,legacy)
            if action=='read':
                raw=request.query_params.get('cardKey')
                key=card_key(raw) if raw is not None and raw.strip(JS_WHITESPACE) else None
                if legacy and request.url.path=='/api/cards/wallet':
                    return wire_response(await service.legacy_snapshot(who,key),headers)
                result=await service.snapshot(who,key)
                if legacy and request.url.path=='/api/cards/amounts':
                    return wire_response({'amounts':[{'cardKey':row['cardKey'],'amount':float(row['amount']),'currency':row['currency'] or '', 'note':row['note'],'updatedAt':datetime.fromisoformat(row['updatedAt']).astimezone(UTC).isoformat(timespec='milliseconds').replace('+00:00','Z')} for row in result['accounts'] if row['amountKnown']]},headers)
                return wire_response(result,headers)
            if action=='history':
                params=request.query_params
                if set(params)-{'cardKey','limit','after','revision','includeDeleted'}:
                    raise HTTPException(422,'历史查询字段无效')
                try:
                    limit=int(params.get('limit','25'))
                    after=UUID(params['after']) if 'after' in params else None
                    revision=int(params['revision']) if 'revision' in params else None
                    if params.get('includeDeleted','false') not in ('true','false'):
                        raise ValueError()
                except (ValueError,TypeError):
                    raise HTTPException(422,'历史查询参数无效') from None
                return wire_response(await service.history(who,params.get('cardKey',''),limit=limit,after=after,revision=revision,include_deleted=params.get('includeDeleted')=='true'),headers)
            if action=='receipt':
                return wire_response(await service.receipt(who,UUID(identifier)),headers)
            if action=='close':
                if await body(request) != {}:
                    raise HTTPException(400,'关闭请求不能携带金融或卡背信息')
                return wire_response(await service.close(who,UUID(identifier)),headers)
            address=request.client.host if request.client else 'unknown'
            maximum=120 if action=='details' else 240
            if not await rate_limit(db,'card-wallet-'+action+':'+who.id+':'+address,maximum,window_seconds=60):
                raise HTTPException(429,'操作过于频繁，请稍后再试')
            data=await body(request)
            if action=='preview':
                return wire_response(await service.preview(who,data),headers)
            if action=='submit':
                if set(data)!={'data','preview'}:
                    raise HTTPException(422,'卡包确认字段无效')
                return wire_response(await service.submit(who,data['data'],data['preview']),headers)
            if action=='details':
                if legacy:
                    raw_id=request.headers.get('x-alcor-request-id')
                    try:
                        request_id=UUID(raw_id) if raw_id is not None else uuid4()
                    except ValueError:
                        raise HTTPException(400,'原请求编号无效') from None
                    key=card_key(data.get('cardKey',''))
                    patch={key:value for key,value in data.items() if key!='cardKey'}
                    expected=None
                else:
                    if set(data)!={'requestId','expectedRevision','cardKey','changes'} or type(data['expectedRevision']) is not int:
                        raise HTTPException(422,'卡背信息字段无效')
                    try:
                        request_id=UUID(data['requestId'])
                    except (ValueError,TypeError,AttributeError):
                        raise HTTPException(422,'原请求编号无效') from None
                    key=data['cardKey'];patch=data['changes'];expected=data['expectedRevision']
                result=await service.save_details(who,key,patch,request_id,expected,legacy=legacy)
                headers['X-Alcor-Request-Id']=str(request_id)
                return wire_response(result['legacySnapshot'] if legacy else result,headers)
            if action=='reveal':
                if set(data)-{'cardKey','reveal','password','code'} or data.get('reveal') is not True:
                    raise HTTPException(422,'需明确请求显示本人的卡背信息')
                password,code=data.get('password',''),data.get('code','')
                if not isinstance(password,str) or len(password)>128 or not isinstance(code,str) or len(code)>32:
                    raise HTTPException(422,'验证字段无效')
                async def verify(conn):
                    recent=await(await conn.execute("SELECT created_at>clock_timestamp()-interval '15 minutes' AND created_at<=clock_timestamp() AS fresh FROM sessions WHERE token_hash=%s",(who.token_hash,))).fetchone()
                    if not recent or not recent['fresh']:
                        if not password:
                            raise HTTPException(403,'请验证身份后显示卡背信息',headers={'X-Alcor-Reauthentication':'required'})
                        await app.state.native_passkeys.step_up(conn,who,password,code)
                return wire_response(await service.reveal(who,data.get('cardKey',''),verify),headers)
            raise HTTPException(404,'接口不存在')
        except HTTPException as exc:
            if exc.status_code in (401,403):
                headers['X-Alcor-Retire-Context']='true'
            if exc.headers:
                headers.update(exc.headers)
            return wire_response({'error':str(exc.detail)} if legacy else {'error':{'code':'card_wallet_'+str(exc.status_code),'message':str(exc.detail)}},headers,status_code=exc.status_code)

    @app.get('/api/account/card-wallet',tags=['card-wallet'])
    async def read(request:Request):
        return await execute(request,'read')

    @app.get('/api/account/card-wallet/history',tags=['card-wallet'])
    async def history(request:Request):
        return await execute(request,'history')

    @app.post('/api/account/card-wallet/preview',tags=['card-wallet'])
    async def preview(request:Request):
        return await execute(request,'preview')

    @app.post('/api/account/card-wallet/operations',tags=['card-wallet'])
    async def submit(request:Request):
        return await execute(request,'submit')

    @app.get('/api/account/card-wallet/operations/{identifier}',tags=['card-wallet'])
    async def receipt(identifier:UUID,request:Request):
        return await execute(request,'receipt',identifier=str(identifier))

    @app.post('/api/account/card-wallet/operations/{identifier}/close',tags=['card-wallet'])
    async def close(identifier:UUID,request:Request):
        return await execute(request,'close',identifier=str(identifier))

    @app.patch('/api/account/card-wallet/details',tags=['card-wallet'])
    async def details(request:Request):
        return await execute(request,'details')

    @app.post('/api/account/card-wallet/details/reveal',tags=['card-wallet'])
    async def reveal(request:Request):
        return await execute(request,'reveal')

    @app.get('/api/cards/amounts',tags=['legacy-web-cards'])
    @app.get('/api/cards/wallet',tags=['legacy-web-cards'])
    async def old_read(request:Request):
        return await execute(request,'read',legacy=True)

    @app.put('/api/cards/wallet',tags=['legacy-web-cards'])
    async def old_details(request:Request):
        return await execute(request,'details',legacy=True)

    async def old_financial_write(request:Request):
        headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'}
        try:
            who=await member(request,legacy=True)
            raw=await body(request) if request.method!='DELETE' else dict(request.query_params)
            if request.method=='DELETE' and any(len(request.query_params.getlist(key))!=1 for key in request.query_params):raise HTTPException(400,'删除参数重复')
            supplied=request.headers.get('x-alcor-request-id')
            try:rid=str(UUID(supplied)) if supplied is not None else str(uuid4())
            except (ValueError,TypeError):raise HTTPException(400,'原请求编号无效') from None
            from .card_wallet_contract import hashed, money
            from .market_worker import Bound
            # The immutable receipt retains the original legacy intent and its exact response.
            logical=hashed({'path':request.url.path,'method':request.method,'input':json.loads(json.dumps(raw,default=str))})
            headers['X-Alcor-Request-Id']=rid
            headers['X-Alcor-Legacy-Client-Idempotency']='true' if supplied else 'false'
            async with service.context(who) as (conn,revision):
                prior=await(await conn.execute('SELECT result FROM card_wallet_operations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
                if prior:
                    saved=prior['result']
                    if saved.get('legacyRequestHash')!=logical:raise HTTPException(409,'原UUID已用于不同卡包操作')
                    return wire_response(saved['legacySnapshot'],headers)
                key=None;entry_id=None
                if request.url.path.endswith('/wallet') and request.method=='DELETE':
                    if set(raw)!={'id'}:raise HTTPException(400,'需要原流水id')
                    try:entry_id=str(UUID(raw['id']))
                    except (ValueError,TypeError):raise HTTPException(400,'流水编号无效') from None
                    row=await(await conn.execute('SELECT card_key FROM card_wallet_entries WHERE owner_id=%s AND id=%s AND deleted_at IS NULL',(who.id,entry_id))).fetchone()
                    if not row:raise HTTPException(404,'流水不存在')
                    key=row['card_key'];operation='delete_entry'
                else:
                    key=card_key(raw.get('cardKey',''))
                    operation='clear_amount' if request.method=='DELETE' else 'set_amount' if request.url.path.endswith('/amounts') else raw.get('kind')
                current=await(await conn.execute('SELECT * FROM card_wallet_accounts WHERE owner_id=%s AND card_key=%s',(who.id,key))).fetchone()
                if operation=='set_amount' and await(await conn.execute('SELECT 1 FROM card_wallet_entries WHERE owner_id=%s AND card_key=%s AND deleted_at IS NULL LIMIT 1',(who.id,key))).fetchone():operation='adjust'
                currency=raw.get('currency') or (current['currency'] if current else None)
                if currency is not None:
                    if not isinstance(currency,str):raise HTTPException(400,'币种无效')
                    currency=currency.strip().upper() or None
                if currency is None:
                    details=await service.details(conn,who.id,key)
                    currency=(details.get(key) or {}).get('currency') or None
                when=raw.get('occurredAt') or (await(await conn.execute('SELECT clock_timestamp() AS now')).fetchone())['now'].isoformat()
                data={'requestId':rid,'expectedRevision':revision,'operation':operation,'cardKey':key,'currency':currency,
                      'note':sqlite_text(clean(float(raw['note']) if isinstance(raw.get('note'),Decimal) else raw.get('note'),100)),'occurredAt':when,'allowNegativeBalance':raw.get('allowNegativeBalance',False)}
                if operation in ('set_amount','deposit','withdraw','adjust'):
                    value=raw.get('currentBalance') if operation=='adjust' and not request.url.path.endswith('/amounts') else raw.get('amount')
                    if value is None:raise HTTPException(400,'须提供明确金额，调整须提供currentBalance')
                    data['amount']=str(money(value,negative=operation=='adjust'))
                if entry_id:data['entryId']=entry_id
                if raw.get('fundAccount')=='broker':
                    for name in ('fundAccount','accountId','accountKind','accountRevision','cashRevision'):
                        if name in raw:data[name]=raw[name]
                bound=CardWallet(Bound(conn,db.settings))
                preview=await bound.preview(who,data)
                async def project(connection,result):
                    effects=result['effects']
                    if request.url.path.endswith('/amounts'):
                        if request.method=='DELETE':dto={'ok':True}
                        else:
                            await connection.execute('UPDATE card_wallet_accounts SET note=%s WHERE owner_id=%s AND card_key=%s',(data['note'],who.id,key))
                            row=await(await connection.execute('SELECT updated_at FROM card_wallet_accounts WHERE owner_id=%s AND card_key=%s',(who.id,key))).fetchone()
                            dto={'amount':{'cardKey':key,'amount':float(effects['after']['amount']),'currency':effects['after']['currency'] or '',
                                'note':data['note'],'updatedAt':row['updated_at'].astimezone(UTC).isoformat(timespec='milliseconds').replace('+00:00','Z')}}
                    elif request.method=='DELETE':dto={'ok':True,'cardKey':key,'balance':float(effects['after']['amount']) if effects['after']['amount'] is not None else None}
                    else:
                        recorded=effects['recordedEntry'];effect=next(value for value in effects['historyEffects'] if value['id']==recorded['id'])
                        dto={'entry':{'id':recorded['id'],'cardKey':key,'kind':recorded['kind'],'delta':float(effect['delta']) if effect['delta'] is not None else None,
                             'balance':float(effect['balance']),'note':data['note'],'occurredAt':recorded['occurredAt'],'brokerLinked':effects['brokerLinked']},'balance':float(effects['after']['amount'])}
                    return {**result,'legacyRequestHash':logical,'legacySnapshot':dto}
                result=await bound.submit(who,data,preview['preview'],project=project)
                return wire_response(result['legacySnapshot'],headers)
        except HTTPException as exc:
            headers.update(exc.headers or {})
            if exc.status_code in (401,403):headers['X-Alcor-Retire-Context']='true'
            return wire_response({'error':str(exc.detail)},headers,status_code=exc.status_code)

    for noun,methods in (('amounts',('PUT','DELETE')),('wallet',('POST','DELETE'))):
        for method in methods:
            app.add_api_route('/api/cards/'+noun,old_financial_write,methods=[method],tags=['legacy-web-cards'],operation_id='legacy_card_'+noun+'_'+method.lower())
