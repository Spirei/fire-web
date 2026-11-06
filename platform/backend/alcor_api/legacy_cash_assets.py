"""Old App cash/instrument/position contracts over shared platform services."""

import json
import re
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg.errors import UniqueViolation

from .legacy_asset_authority import LegacyAssetAuthority
from .legacy_broker_accounts import unique
from .legacy_broker_read import LEGACY_CURRENCIES, iso
from .legacy_cash_commands import HASH, LegacyCashCommands
from .legacy_cash_read import money
from .legacy_identity import assert_native_origin, native_identity
from .legacy_optional_credentials import credentials_present
from .native_app_auth import CLIENT
from .profile_http import bounded_body
from .security import digest, identity


async def owner_cash_page(service,commands,who,query):
    allowed={'limit','offset','currency','snapshotRevision'}
    if any(key not in allowed or len(query.getlist(key))!=1 for key in query):raise HTTPException(400,'资金查询参数无效')
    limit,offset=query.get('limit','100'),query.get('offset','0')
    currency=query.get('currency');expected=query.get('snapshotRevision')
    if (not re.fullmatch(r'[1-9][0-9]*',limit) or len(limit)>3 or int(limit)>200
            or not re.fullmatch(r'0|[1-9][0-9]*',offset) or len(offset)>16 or int(offset)>9007199254740991
            or currency is not None and currency not in LEGACY_CURRENCIES
            or expected is not None and not HASH.fullmatch(expected)):
        raise HTTPException(400,'资金分页或币种无效')
    async with service.context(who) as conn:
        from .cash_overview import CashOverview
        overview=await CashOverview(service.db).on_connection(conn,who)
        now=(await (await conn.execute('SELECT clock_timestamp() AS at')).fetchone())['at']
        result=await commands.owner_snapshot(conn,who,overview,now)
        if expected is not None and expected!=result['snapshotRevision'] or int(offset)>0 and expected is None:
            raise HTTPException(409,'现金流水已变化，请从原快照重新读取')
        args=(who.id,currency,currency)
        total=(await (await conn.execute('SELECT count(*) AS total FROM cash_ledger_entries WHERE owner_id=%s AND (%s::text IS NULL OR currency=%s)',args)).fetchone())['total']
        rows=await (await conn.execute('''SELECT e.*,coalesce(d.detail->>'source',t.source) AS fee_source,
            EXISTS(SELECT 1 FROM actual_fee_confirmations a JOIN trade_fee_corrections c ON c.owner_id=a.owner_id AND c.trade_id=a.trade_id AND c.request_id=a.request_id AND c.new_fees=a.actual_fee WHERE a.owner_id=t.owner_id AND a.trade_id=t.id) OR
            EXISTS(SELECT 1 FROM native_actual_fee_confirmations a JOIN trade_fee_corrections c ON c.owner_id=a.owner_id AND c.trade_id=a.trade_id AND c.request_id=a.request_id AND c.old_fees=a.registered_fee AND c.new_fees=a.actual_fee WHERE a.owner_id=t.owner_id AND a.trade_id=t.id) AS fee_confirmed
            FROM cash_ledger_entries e LEFT JOIN trade_ledger t ON t.owner_id=e.owner_id AND t.id=e.source_trade_id
            LEFT JOIN trade_fee_details d ON d.owner_id=t.owner_id AND d.trade_id=t.id
            WHERE e.owner_id=%s AND (%s::text IS NULL OR e.currency=%s)
            ORDER BY e.occurred_at DESC,e.created_at DESC,e.id DESC LIMIT %s OFFSET %s''',(*args,int(limit),int(offset)))).fetchall()
        items=[]
        for row in rows:
            known=row['source_trade_id'] is None or row['fee_confirmed'] or row['fee_source'] in ('owner_recorded','broker_reported')
            items.append({'id':str(row['id']),'currency':row['currency'],'type':row['kind'],'amount':money(abs(row['amount'])) if known else None,
                'direction':-1 if row['amount']<0 else 1,'occurredAt':iso(row['occurred_at']),'createdAt':iso(row['created_at']),
                'note':row['note'],'sourceOrderId':str(row['source_trade_id']) if row['source_trade_id'] else None,
                'brokerAccountId':row['account_id'],'accountKind':row['account_kind'],'requestId':str(row['request_id']),
                'registeredAmount':str(row['amount']),'amountAuthority':'registered_posting','actualAmountKnown':bool(known),
                'affectsOwnerCash':row['affects_owner'],'independentlyDeletable':False})
        result.update({'transactions':items,'transactionSource':'stored_fund_ledger','ordersCashSource':'filled_trade_orders',
            'pagination':{'limit':int(limit),'offset':int(offset),'total':total}})
        return result


def mount_legacy_cash_assets(app,rate_limit):
    service=LegacyAssetAuthority(app.state.db,app.state.market_authority)
    commands=LegacyCashCommands(service)
    app.state.legacy_asset_authority=service
    app.state.legacy_cash_commands=commands

    async def member(request,scope,extra=()):
        credentials_present(request)
        assert_native_origin(request,app.state.db.settings)
        if not re.fullmatch(r'Bearer fat_[A-Za-z0-9_-]{43}',request.headers.get('authorization',''),re.ASCII):
            raise HTTPException(401,'需要有效的 App 连接')
        who,grant=await native_identity(request,app.state.db,scope)
        if grant['client_id']!=CLIENT:raise HTTPException(401,'需要有效的 App 连接')
        required=(scope,*extra)
        if not set(required)<=set(grant['scope'].split()):raise HTTPException(403,'连接缺少明确授权的范围')
        who.asset_required_scopes=required
        if request.method!='GET' and not await rate_limit(app.state.db,digest('app-cash:'+who.id),120,window_seconds=60):
            raise HTTPException(429,'请求过于频繁')
        return who

    async def body(request,limit=65536):
        if request.headers.get('content-type','').split(';')[0].strip()!='application/json':raise HTTPException(400,'需要JSON请求')
        try:
            value=json.loads(await bounded_body(request,limit),object_pairs_hook=unique,parse_constant=lambda _:(_ for _ in ()).throw(ValueError()))
        except (ValueError,UnicodeError,RecursionError):raise HTTPException(400,'无效请求') from None
        if not isinstance(value,dict):raise HTTPException(400,'无效请求')
        return value

    async def execute(request,action,record_id=''):
        version=2 if request.url.path.startswith('/api/v2/') else 1
        headers={'Cache-Control':'private, no-store','Vary':'Authorization','X-Alcor-API-Version':str(version),'X-Content-Type-Options':'nosniff'}
        try:
            scope=('cash.read' if action=='cash' and request.method=='GET' else 'positions.read' if action=='positions' else 'assets.read' if action=='summary' else 'portfolio.read' if request.method=='GET' else 'portfolio.write')
            who=await member(request,scope,('portfolio.read',) if action in ('positions','summary') else ())
            if action=='snapshot':
                if any(key not in ('currency','costMethod','usPrice') or len(request.query_params.getlist(key))!=1 for key in request.query_params):raise HTTPException(400,'资产查询参数无效')
                data=await service.snapshot(who,dict(request.query_params))
            elif action=='cash' and request.method=='GET':
                data=await owner_cash_page(service,commands,who,request.query_params)
            elif action=='global':
                if any(key!='include' or len(request.query_params.getlist(key))!=1 or request.query_params[key]!='accounts' for key in request.query_params):raise HTTPException(400,'不支持查询参数')
                data=await commands.overview(who,request.query_params.get('include')=='accounts',version)
            else:
                if request.query_params:raise HTTPException(400,'不支持查询参数')
                if action=='instrument':
                    data=await service.instrument(who,record_id) if request.method=='GET' else await service.declare(who,record_id,await body(request))
                elif action in ('positions','summary'):
                    snapshot=await service.snapshot(who)
                    data={key:snapshot[key] for key in ('accountId','snapshotRevision','asOf','currency','collectionRevision')}
                    data.update({'items':snapshot['positions']} if action=='positions' else {'summary':snapshot['summary'],'markets':snapshot['markets']})
                elif action=='cash':data=await commands.command(who,await body(request),submit=True,owner_target=True)
                else:data=await commands.command(who,await body(request,8192),submit=action=='submit')
            status=data.get('status',200) if isinstance(data,dict) else 200
            if status!=200:return JSONResponse({'code':data.get('code',status*100+1),'message':data.get('message','操作未完成')},status_code=status,headers=headers)
            return JSONResponse({'code':0,'data':data},status_code=status,headers=headers)
        except UniqueViolation as exc:
            if exc.diag.constraint_name!='asset_request_domain':raise
            return JSONResponse({'code':40901,'message':'原UUID已用于其他金融操作，请查询原回执'},status_code=409,headers=headers)
        except HTTPException as exc:
            return JSONResponse({'code':getattr(exc,'legacy_code',exc.status_code*100+1),'message':str(exc.detail)},status_code=exc.status_code,headers=headers)

    for version in (1,2):
        base=f'/api/v{version}'
        for action,path,methods in (
                ('snapshot','/account-assets',('GET',)),
                ('cash','/account-assets/cash',('GET','POST')),
                ('instrument','/account-assets/instruments/{record_id}',('GET','PUT')),
                ('positions','/account-assets/positions',('GET',)),('summary','/account-assets/summary',('GET',)),
                ('global','/broker-accounts/cash',('GET',)),('preview','/broker-accounts/cash/preview',('POST',)),
                ('submit','/broker-accounts/cash/submissions',('POST',))):
            def handler_for(selected):
                async def handler(request:Request,record_id:str=''):
                    return await execute(request,selected,record_id)
                return handler  # noqa: B023
            handler=handler_for(action)
            for method in methods:
                app.add_api_route(base+path,handler,methods=[method],operation_id=f'legacy_cash_assets_v{version}_{action}_{method.lower()}')

    async def web_member(request):
        if 'authorization' in request.headers:raise HTTPException(403,'请使用当前网页登录会话')
        return await identity(request)

    @app.get('/api/account/asset-instruments/operations/{request_id}')
    async def web_receipt(request:Request,request_id:UUID):
        if request.query_params:raise HTTPException(400,'不支持查询参数')
        who=await web_member(request)
        return JSONResponse(await service.receipt(who,str(request_id)),headers={'Cache-Control':'private, no-store'})

    @app.get('/api/account/asset-instruments/{record_id}')
    async def web_state(request:Request,record_id:str):
        if request.query_params:raise HTTPException(400,'不支持查询参数')
        return JSONResponse(await service.instrument(await web_member(request),record_id),headers={'Cache-Control':'private, no-store'})

    @app.put('/api/account/asset-instruments/{record_id}')
    async def web_declare(request:Request,record_id:str):
        if request.query_params:raise HTTPException(400,'不支持查询参数')
        who=await web_member(request)
        result=await service.declare(who,record_id,await body(request))
        return JSONResponse(result,status_code=result['status'],headers={'Cache-Control':'private, no-store'})

    return service
