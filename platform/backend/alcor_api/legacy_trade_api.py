"""Old v1/v2 HTTP methods over native services and immutable original UUID views."""
import json
from decimal import Decimal

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .fx_provider_parser import unique
from .legacy_identity import assert_native_origin, native_identity
from .legacy_optional_credentials import credentials_present
from .legacy_trade_services import LegacyRecordedTrading, LegacyTradeCorrections, correction_preview
from .legacy_trading_snapshot import fee_transport, snapshot_in_transaction
from .profile_http import bounded_body
from .security import lock_mutation_identity


def headers(version,detailed,typed):
    return {'Cache-Control':'no-store, private','X-Alcor-API-Version':str(version),'Vary':'Cookie, Authorization, X-Alcor-Trade-Fees, X-Alcor-Trading-Context',
      **({'X-Alcor-Trade-Fees':'details-v1'} if detailed else {}),**({'X-Alcor-Trading-Context':'nullable-v1'} if typed else {})}


def formats(request):
    fee=request.headers.get('x-alcor-trade-fees');context=request.headers.get('x-alcor-trading-context')
    if fee not in (None,'details-v1') or context not in (None,'nullable-v1'):raise HTTPException(400,'读取格式协商无效')
    return fee=='details-v1',context=='nullable-v1'


def stored_legacy_receipt(result):
    value=result.get('legacyReceipt')
    if not value:raise HTTPException(409,'此原UUID保留平台原生回执，当前旧协议无法完整表达，请通过平台原回执读取')
    return value


def mount_legacy_trade_commands(app):
    from .internal_order_actions import InternalOrderActions
    internal=InternalOrderActions(app.state.db)
    db=app.state.db;trading=LegacyRecordedTrading(db);corrections=LegacyTradeCorrections(db,getattr(app.state,'source_authority',None))
    app.state.legacy_recorded_trading=trading;app.state.legacy_trade_corrections=corrections
    fallback=[route for route in app.router.routes if getattr(route,'path',None) in ('/api/{path:path}','/{path:path}')]
    app.router.routes[:]=[route for route in app.router.routes if route not in fallback]

    async def response(request,version,action):
        detailed=typed=False
        try:
            if version not in (1,2):raise HTTPException(404,'接口不存在')
            assert_native_origin(request,db.settings)
            credentials_present(request)
            who,_=await native_identity(request,db,'orders.read' if action=='snapshot' else 'orders.write')
            detailed,typed=formats(request)
            if request.query_params and (action!='snapshot' or set(request.query_params) not in ({'recordId'},{'brokerAccountId'}) or any(len(request.query_params.getlist(key))!=1 or not request.query_params[key] for key in request.query_params)):raise HTTPException(400,'不支持查询参数')
            if action=='snapshot':
                async with db.connection() as conn,conn.transaction():
                    await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
                    await lock_mutation_identity(conn,who,require_admin=False)
                    _,value=await snapshot_in_transaction(conn,who,strict=not typed,scope_record_id=request.query_params.get('recordId'),scope_account_id=request.query_params.get('brokerAccountId'))
            else:
                limit=30 if action.startswith('correction') else 120
                if not await app.state.rate_limit(db,('legacy-trade-corrections:' if limit==30 else 'legacy-trade-records:')+who.id,limit,window_seconds=60):raise HTTPException(429,'请求过于频繁')
                maximum=131072 if action.startswith('correction') else 65536
                raw=await bounded_body(request,maximum)
                try:body=json.loads(raw,parse_float=Decimal,object_pairs_hook=unique,parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
                except (ValueError,UnicodeDecodeError):raise HTTPException(400,'请求须为有效JSON对象') from None
                if not isinstance(body,dict):raise HTTPException(400,'请求须为对象')
                if not detailed and ('feeInput' in body or isinstance(body.get('replacement'),dict) and 'feeInput' in body['replacement']):raise HTTPException(400,'费用分项提交须协商details-v1')
                if action=='trade_preview':value=await internal.preview_native(who,body) if body.get('mode')=='order' else await trading.preview(who,body)
                elif action=='trade_submit':
                    result=await internal.submit_native(who,body) if body.get('mode')=='order' else await trading.submit(who,body)
                    value=result if body.get('mode')=='order' else stored_legacy_receipt(result)
                    if result['state']=='failed':return JSONResponse({'code':result['code'],'message':result['message'],'data':None},status_code=result['status'],headers=headers(version,detailed,typed))
                elif action=='correction_preview':
                    proof=await corrections.preview(who,body)
                    value=correction_preview(proof['legacyRequest'],proof)
                else:
                    token=body.pop('previewRevision',None)
                    if not isinstance(token,str) or not 1<=len(token)<=128:raise HTTPException(400,'须提供原更正预览凭证')
                    result=await corrections.submit(who,body,token)
                    value=stored_legacy_receipt(result)
                    if result['state']=='failed':return JSONResponse({'code':result['code'],'message':result['message'],'data':None},status_code=result['status'],headers=headers(version,detailed,typed))
            return JSONResponse({'code':0,'message':'ok','data':fee_transport(value,detailed)},headers=headers(version,detailed,typed))
        except HTTPException as error:
            status=error.status_code if isinstance(error,HTTPException) else 400
            message=str(error.detail) if isinstance(error,HTTPException) else '请求参数无效'
            response_headers = headers(version,detailed,typed) if version in (1,2) else {'Cache-Control':'no-store'}
            response_headers.update(error.headers or {})
            if status in (401,403):response_headers['X-Alcor-Retire-Context']='true'
            return JSONResponse({'code':getattr(error,'business_code',40902 if status==409 else status*100+1),'message':message,'data':None},status_code=status,headers=response_headers)
        except Exception:  # noqa: BLE001 -- An unknown outcome must only permit original UUID lookup, never an automatic retry.
            return JSONResponse({'code':50301,'message':'结果尚未确认，请只读查询原UUID回执','data':None},status_code=503,headers=headers(version,detailed,typed) if version in (1,2) else {'Cache-Control':'no-store'})

    @app.get('/api/v{version}/account-assets/trading')
    async def snapshot(version:int,request:Request):return await response(request,version,'snapshot')
    @app.post('/api/v{version}/account-assets/trading/preview')
    async def preview(version:int,request:Request):return await response(request,version,'trade_preview')
    @app.post('/api/v{version}/account-assets/trading/submissions')
    async def submit(version:int,request:Request):return await response(request,version,'trade_submit')
    @app.post('/api/v{version}/account-assets/trading/corrections/preview')
    async def correction_preview_route(version:int,request:Request):return await response(request,version,'correction_preview')
    @app.post('/api/v{version}/account-assets/trading/corrections')
    async def correct(version:int,request:Request):return await response(request,version,'correction_submit')
    adapters=app.state.legacy_asset_operation_adapters
    for kind in ('legacy_recorded_trade','trade_amendment'):
        if kind in adapters:raise RuntimeError('duplicate legacy trade receipt adapter')
        adapters[kind]=stored_legacy_receipt
    app.router.routes.extend(fallback)
