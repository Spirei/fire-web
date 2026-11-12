"""Native account-assets order views and atomic cancellation over shared PG intents."""

from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg.types.json import Jsonb

from .fx_provider_parser import unique
from .internal_orders import InternalOrders, fingerprint, order_dto
from .legacy_identity import assert_native_origin, native_identity
from .legacy_optional_credentials import credentials_present
from .legacy_order_projection import READ_MODEL
from .legacy_trading_snapshot import TIME_ZONES, fee_transport, scalar, snapshot_in_transaction
from .profile_http import bounded_body
from .security import lock_mutation_identity, lock_read_identity


class NativeOrders(InternalOrders):
    async def listing(self, who, *, scope='today', status='all', record_id=None):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            await lock_read_identity(conn,who,require_admin=False)
            _, snapshot = await snapshot_in_transaction(conn,who,strict=False,scope_record_id=record_id,registered_order_read_model=True)
            now = datetime.now(UTC)
            items, unknown_dates = [], []
            for item in snapshot['orders']:
                if record_id and item['recordId'] != record_id:
                    continue
                try:
                    zone = ZoneInfo(TIME_ZONES[item['market']])
                    stamp = item['tradedAt']
                    stamp = stamp if isinstance(stamp,datetime) else datetime.fromisoformat(stamp)
                    if stamp.tzinfo is None:
                        raise ValueError()
                    today = stamp.astimezone(zone).date() == now.astimezone(zone).date()
                except (ValueError,TypeError,KeyError):
                    unknown_dates.append(item['id'])
                    today = False
                if status != 'all' and item['status'] != status or scope == 'today' and not today:
                    continue
                items.append(item)
            unverified_history=(len({row['id'] for row in items})!=len(items) or any(
                row.get('executionModel')=='source_registered_history' and row.get('originalReadModel')!=READ_MODEL
                for row in items))
            return scalar({'accountId':who.id,'asOf':now,'scope':scope,'status':status,'recordId':record_id,
                'source':'platform_native_and_registered_history' if unverified_history else 'local_trade_ledger','executionModel':'registered_history_and_atomic_internal_orders' if unverified_history else 'atomic_internal_orders','items':items,'count':len(items),
                'settlesPendingOrders':False,'dateBasis':'exchange_local_calendar_date','timeZones':TIME_ZONES,
                'unknownDateOrderIds':unknown_dates,'supportedStatuses':['pending','filled','cancelled','expired'],
                'rejectedOrdersAvailable':False,'partialFillsAvailable':False})

    async def cancel_many(self, who, raw):
        if (not isinstance(raw,dict) or set(raw)!={'requestId','accountId','orders'} or raw['accountId']!=who.id
                or not isinstance(raw['orders'],list) or not 1<=len(raw['orders'])<=100):
            raise HTTPException(400,'须明确选择本人1至100笔订单')
        from .actual_fee_confirmations import identifier
        rid = identifier(raw['requestId'])
        selected, seen = [], set()
        for item in raw['orders']:
            if (not isinstance(item,dict) or set(item)!={'orderId','recordId','market','code','revision','recordRevision'}
                    or any(not isinstance(item[k],str) or not 1<=len(item[k])<=200 for k in ('orderId','recordId','market','code'))
                    or any(type(item[k]) is not int or item[k]<1 for k in ('revision','recordRevision'))
                    or item['orderId'] in seen):
                raise HTTPException(400,'订单身份或版本无效')
            seen.add(item['orderId'])
            selected.append(item)
        hashed = fingerprint(raw)
        async with self.db.connection() as conn, conn.transaction():
            await self.lock(conn,who)
            prior = await (await conn.execute('SELECT * FROM internal_order_operations WHERE owner_id=%s AND request_id=%s',(who.id,rid))).fetchone()
            if prior:
                raise HTTPException(409,'requestId已使用，请查询原回执')
            from .asset_request_domains import require_domain
            await require_domain(conn,who.id,rid,'internal_order')
            rows = []
            for item in selected:
                try:
                    order_id = UUID(item['orderId'])
                except ValueError:
                    raise HTTPException(404,'本人订单不存在') from None
                row = await (await conn.execute('SELECT * FROM internal_orders WHERE owner_id=%s AND id=%s FOR UPDATE',(who.id,order_id))).fetchone()
                if not row:
                    raise HTTPException(404,'本人订单不存在')
                record = await self.records.get(conn,who.id,row['record_id'])
                if (row['status']!='pending' or row['revision']!=item['revision'] or not record
                        or record['revision']!=item['recordRevision'] or row['record_id']!=item['recordId']
                        or row['record_market']!=item['market'] or row['record_code']!=item['code']
                        or record['market']!=row['record_market'] or record['code']!=row['record_code']):
                    raise HTTPException(409,'订单或证券已变化，请重新读取后确认')
                rows.append(row)
            for row in rows:
                await conn.execute("UPDATE internal_orders SET status='cancelled',cancelled_at=clock_timestamp() WHERE owner_id=%s AND id=%s",(who.id,row['id']))
            await conn.execute('UPDATE cash_ledger_collections SET revision=revision+1 WHERE owner_id=%s',(who.id,))
            current = await (await conn.execute('SELECT * FROM internal_orders WHERE owner_id=%s AND id=ANY(%s::uuid[])',(who.id,[row['id'] for row in rows]))).fetchall()
            result = scalar({'requestId':rid,'kind':'cancel_orders','accountId':who.id,'orderIds':[item['orderId'] for item in selected],
                'state':'completed','code':0,'message':'ok','completedAt':datetime.now(UTC),
                'data':{'items':[{**order_dto(row),'recordId':row['record_id'],'market':row['record_market'],'code':row['record_code'],
                    'qty':str(row['quantity']),'price':str(row['limit_price']),'currentPrice':None,'currentPriceSource':'unavailable'} for row in current],
                    'projection':'internal_order_original_scope_no_unrelated_account_refresh'}})
            outcome = {'requestId':rid,'kind':'legacy_internal_orders','state':'completed','legacyReceipt':result}
            await conn.execute('INSERT INTO internal_order_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,rid,hashed,Jsonb(outcome)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'internal-order.cancel-many',%s,%s)",(who.id,who.id,rid))
            return result


def mount_legacy_native_orders(app):
    service = NativeOrders(app.state.db)
    app.state.legacy_native_orders = service

    async def run(request, version, action, order_id=None):
        headers = {'Cache-Control':'no-store, private','Vary':'Cookie, Authorization, X-Alcor-Trade-Fees','X-Alcor-API-Version':str(version)}
        try:
            assert_native_origin(request,service.db.settings)
            credentials_present(request)
            who,_ = await native_identity(request,service.db,'portfolio.read' if action=='list' else 'orders.write' if action.startswith('amend') else 'orders.cancel')
            detailed = request.headers.get('x-alcor-trade-fees')
            if detailed not in (None,'details-v1'):
                raise HTTPException(400,'费用读取版本无效')
            if detailed:
                headers['X-Alcor-Trade-Fees']='details-v1'
            if action=='list':
                params=request.query_params
                if set(params)-{'scope','status','recordId'} or any(len(params.getlist(key))!=1 for key in params):
                    raise HTTPException(400,'查询参数无效')
                scope,status,record_id=params.get('scope','today'),params.get('status','all'),params.get('recordId')
                if scope not in ('today','all') or status not in ('all','pending','filled','cancelled','rejected','expired') or record_id is not None and not 1<=len(record_id)<=200:
                    raise HTTPException(400,'订单筛选无效')
                value=await service.listing(who,scope=scope,status=status,record_id=record_id)
            else:
                if request.query_params:
                    raise HTTPException(400,'不支持查询参数')
                import json
                raw=json.loads(await bounded_body(request,65536),parse_float=Decimal,object_pairs_hook=unique,
                               parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
                if not await app.state.rate_limit(service.db,'native-internal-orders:'+who.id,120,window_seconds=60):
                    raise HTTPException(429,'请求过于频繁')
                if action.startswith('amend'):
                    from .internal_order_actions import InternalOrderActions
                    commands=InternalOrderActions(service.db)
                    value=await commands.preview_native(who,raw,order_id) if action=='amend_preview' else await commands.submit_native(who,raw,order_id)
                else:
                    value=await service.cancel_many(who,raw)
            return JSONResponse({'code':0,'message':'ok','data':fee_transport(value,detailed=='details-v1')},headers=headers)
        except HTTPException as exc:
            headers.update(exc.headers or {})
            if exc.status_code in (401,403):
                headers['X-Alcor-Retire-Context']='true'
            return JSONResponse({'code':getattr(exc,'business_code',exc.status_code*100+1),'message':str(exc.detail),'data':None},status_code=exc.status_code,headers=headers)
        except (ValueError,TypeError,KeyError):
            return JSONResponse({'code':40001,'message':'订单请求参数无效','data':None},status_code=400,headers=headers)

    def build(v):
        async def listing(request:Request):
            return await run(request,v,'list')
        async def cancellation(request:Request):
            return await run(request,v,'cancel')
        async def amendment_preview(order_id:str,request:Request):
            return await run(request,v,'amend_preview',order_id)
        async def amendment(order_id:str,request:Request):
            return await run(request,v,'amend',order_id)
        return listing,cancellation,amendment_preview,amendment
    for version in (1,2):
        listing,cancellation,amendment_preview,amendment=build(version)
        app.add_api_route(f'/api/v{version}/account-assets/orders',listing,methods=['GET'])
        app.add_api_route(f'/api/v{version}/account-assets/orders/cancellations',cancellation,methods=['POST'])
        app.add_api_route(f'/api/v{version}/account-assets/trading/orders/{{order_id}}/preview',amendment_preview,methods=['POST'])
        app.add_api_route(f'/api/v{version}/account-assets/trading/orders/{{order_id}}',amendment,methods=['PUT'])

    async def canonical(request, action):
        from .security import identity
        who=await identity(request)
        headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'}
        if action=='context':
            if any(key!='recordId' or len(request.query_params.getlist(key))!=1 for key in request.query_params):raise HTTPException(400,'委托快照参数无效')
            async with service.db.connection() as conn,conn.transaction():
                await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
                await lock_mutation_identity(conn,who,require_admin=False)
                _,value=await snapshot_in_transaction(conn,who,strict=False,scope_record_id=request.query_params.get('recordId'))
                accounts=await (await conn.execute('SELECT r.id,r.broker_account_id,b.account_kind FROM portfolio_records r LEFT JOIN broker_accounts b ON b.owner_id=r.owner_id AND b.id=r.broker_account_id WHERE r.owner_id=%s AND r.deleted_at IS NULL',(who.id,))).fetchall()
                by_record={row['id']:row for row in accounts}
                contexts=await (await conn.execute('''SELECT c.order_id,c.order_revision,c.draft FROM internal_order_contexts c
                    JOIN internal_orders o ON o.owner_id=c.owner_id AND o.id=c.order_id AND o.revision=c.order_revision
                    WHERE c.owner_id=%s''',(who.id,))).fetchall()
                by_order={(str(row['order_id']),row['order_revision']):row['draft'] for row in contexts}
                for order in value['orders']:
                    intent=by_order.get((order['id'],order['revision']))
                    if intent is not None:
                        order.update(attachments=intent.get('attachmentsExact',intent.get('attachments')),
                                     attachmentsExact=intent.get('attachmentsExact'),attachmentInputsAvailable=True,
                                     parentOrderId=intent.get('parentOrderId'),parentTradeId=intent.get('parentTradeId'),
                                     attachmentRole=intent.get('attachmentRole'),familyId=intent.get('familyId'),
                                     intentExact=intent)
                for position in value['positions']:
                    source=by_record.get(position['recordId'],{})
                    position.update(brokerAccountId=source.get('broker_account_id'),accountKind=source.get('account_kind'))
            return JSONResponse(value,headers=headers)
        import json

        from .internal_order_actions import InternalOrderActions
        try:
            raw=json.loads(await bounded_body(request,65536),parse_float=Decimal,object_pairs_hook=unique,
                           parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
        except (ValueError,UnicodeDecodeError):
            raise HTTPException(422,'须提供有效JSON内部委托') from None
        if not isinstance(raw,dict) or set(raw)-{'data','orderId'} or not isinstance(raw.get('data'),dict):
            raise HTTPException(422,'须明确内部委托及可选原单编号')
        data=dict(raw['data'])
        # Canonical exact text stays Decimal through validation; never binary-float conversion.
        nodes=[(data,('qty','price','fees','triggerPrice'))]
        attached=data.get('attachments')
        if attached is not None:
            if not isinstance(attached,dict):
                raise HTTPException(422,'附加单参数须为对象')
            for leg_name in ('takeProfit','stopLoss'):
                if leg_name in attached:
                    if not isinstance(attached[leg_name],dict):
                        raise HTTPException(422,'附加单分支须为对象')
                    nodes.append((attached[leg_name],('percent','fees','limitPrice')))
        for node,keys in nodes:
            for key in keys:
                if key not in node:
                    continue
                if isinstance(node[key],str):
                    try:
                        node[key]=Decimal(node[key])
                    except InvalidOperation:
                        raise HTTPException(422,'委托及附加单数值须为有效精确文本') from None
                if type(node[key]) not in (int,Decimal) or not Decimal(node[key]).is_finite():
                    raise HTTPException(422,'委托及附加单数值类型或范围无效')
        commands=InternalOrderActions(service.db)
        value=await commands.preview_native(who,data,raw.get('orderId'),exact=True) if action=='preview' else await commands.submit_native(who,data,raw.get('orderId'))
        return JSONResponse(value,headers=headers)

    @app.get('/api/trading/order-intents/context')
    async def canonical_context(request:Request):
        return await canonical(request,'context')

    @app.post('/api/trading/order-intents/preview')
    async def canonical_preview(request:Request):
        return await canonical(request,'preview')

    @app.post('/api/trading/order-intents/operations')
    async def canonical_submit(request:Request):
        return await canonical(request,'submit')
