"""The four old F41 GET/POST methods, sharing exact native policy operations."""
import hashlib
import json
from decimal import Decimal, localcontext

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .financing_model import CURRENCIES, policy
from .financing_policies import FinancingPolicies, head
from .legacy_identity import assert_native_origin, native_identity
from .source_read_access import source_read_lock


def js_number(value):
    value=Decimal(value)
    if Decimal(str(float(value)))!=value:raise HTTPException(409,'旧数值协议不能精确表达当前融资金额，请使用平台精确金额接口')
    if not value:return '0'
    with localcontext() as context:
        context.prec=80
        value=value.normalize()
    if abs(value)>=Decimal('0.000001'):return format(value,'f')
    text=format(value,'e');mantissa,exponent=text.split('e');return mantissa+'e'+str(int(exponent))


def legacy_payload_hash(revision_value,value):
    raw='{"revision":'+json.dumps(revision_value)+',"policy":'+legacy_policy_json(value)+'}'
    return hashlib.sha256(raw.encode()).hexdigest()


def legacy_policy_json(value):
    return 'null' if value is None else '{"currency":'+json.dumps(value['currency'])+','+','.join(json.dumps(key)+':'+('null' if value[key] is None else js_number(value[key])) for key in ('limit','initialMargin','maintenanceMargin'))+'}'


def legacy_revision(value):
    return hashlib.sha256(legacy_policy_json(value).encode()).hexdigest()


def view(owner,value):
    return {'version':1,'accountId':owner,'revision':legacy_revision(value),'policy':None if value is None else {'currency':value['currency'],**{key:None if value[key] is None else float(js_number(value[key])) for key in ('limit','initialMargin','maintenanceMargin')}}}


async def unique_kind(conn,owner,explicit=None):
    if explicit is not None:
        if explicit not in ('real','simulated'):raise HTTPException(400,'账本身份协商无效')
        return explicit
    rows=await(await conn.execute("SELECT DISTINCT account_kind FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL UNION SELECT DISTINCT account_kind FROM financing_policy_heads WHERE owner_id=%s",(owner,owner))).fetchall()
    installed=await(await conn.execute("SELECT to_regclass('financing_source_policy_claims') name")).fetchone()
    if installed['name']:
        rows+=await(await conn.execute('SELECT account_kind FROM financing_source_policy_claims WHERE owner_id=%s',(owner,))).fetchall()
    kinds={row['account_kind'] for row in rows}
    if len(kinds)!=1 or kinds-{'real','simulated'}:raise HTTPException(409,'旧接口须唯一已核实账本身份；请明确选择真实或模拟账本')
    return next(iter(kinds))


class LegacyFinancingPolicies(FinancingPolicies):
    def __init__(self,db,owner,kind,explicit):super().__init__(db);self.owner=owner;self.kind=kind;self.explicit=explicit;self._budget_consumed=False
    async def consume_budget(self,who):
        if not self._budget_consumed:
            await super().consume_budget(who)
            self._budget_consumed=True
    def parse_command(self,raw):
        from .actual_fee_confirmations import identifier
        if not isinstance(raw,dict) or set(raw)!={'requestId','revision','policy'} or not isinstance(raw['revision'],str):raise HTTPException(400,'融资请求无效')
        value=raw['policy']
        if not isinstance(value,dict) or set(value)-{'currency','limit','initialMargin','maintenanceMargin'} or value.get('currency') not in CURRENCIES:raise HTTPException(400,'融资政策无效')
        normalized={'currency':value['currency']}
        for key in ('limit','initialMargin','maintenanceMargin'):
            item=value.get(key)
            if item is not None and (isinstance(item,bool) or not isinstance(item,(int,float,Decimal))):raise HTTPException(400,'融资金额须为有效数值')
            normalized[key]=None if item is None else str(item)
        return {'requestId':identifier(raw['requestId']),'targetUserId':self.owner,'accountKind':self.kind,'revision':raw['revision'],'policy':policy(normalized)}
    async def calculate(self,conn,who,data):
        if not self.explicit and await unique_kind(conn,who.id)!=self.kind:raise HTTPException(409,'真实或模拟账本范围已变化')
        current=await head(conn,who.id,self.kind)
        if not current['policyKnown']:raise HTTPException(409,'原融资政策尚未取得授权映射，不能把未知政策当作空配置')
        if legacy_revision(current['policy'])!=data['revision']:raise HTTPException(409,'融资参数已变化，请重新读取')
        return await super().calculate(conn,who,{**data,'revision':current['revision']})
    async def decorate_policy_receipt(self,conn,who,data,result):return {**result,'legacyReceipt':view(who.id,result['policy'])}


def mount_legacy_financing(app):
    db=app.state.db
    fallback=[route for route in app.router.routes if getattr(route,'path',None) in ('/api/{path:path}','/{path:path}')]
    app.router.routes[:]=[route for route in app.router.routes if route not in fallback]
    async def response(request,version,write):
        headers={'Cache-Control':'no-store, private','Vary':'X-Alcor-Account-Kind','X-Alcor-API-Version':str(version)}
        try:
            if version not in (1,2):raise HTTPException(404,'接口不存在')
            assert_native_origin(request,db.settings)
            who,_=await native_identity(request,db,'portfolio.write' if write else 'portfolio.read')
            if request.query_params:raise HTTPException(400,'不支持查询参数')
            explicit=request.headers.get('x-alcor-account-kind')
            async with db.connection() as conn,conn.transaction():
                await source_read_lock(conn,who)
                try:kind=await unique_kind(conn,who.id,explicit)
                except HTTPException:
                    if not write and explicit is None and not await(await conn.execute('SELECT 1 FROM broker_accounts WHERE owner_id=%s UNION ALL SELECT 1 FROM legacy_source_heads WHERE owner_id=%s',(who.id,who.id))).fetchone():return JSONResponse({'code':0,'message':'ok','data':view(who.id,None)},headers=headers)
                    raise
            if not write:
                async with db.connection() as conn,conn.transaction():
                    await source_read_lock(conn,who)
                    current=await head(conn,who.id,kind)
                    if not current['policyKnown']:raise HTTPException(409,'原融资政策尚未映射，请在平台核对原始来源')
                    result=view(who.id,current['policy'])
            else:
                service=LegacyFinancingPolicies(db,who.id,kind,explicit is not None)
                await service.consume_budget(who)
                raw=await request.body()
                if len(raw)>8192:raise HTTPException(413,'请求内容超过上限')
                try:body=json.loads(raw,parse_float=Decimal)
                except (ValueError,UnicodeDecodeError):raise HTTPException(400,'融资请求须为有效JSON') from None
                # A known original UUID is read before a fresh preview. No unknown
                # result is ever resubmitted automatically after the POST.
                data=service.parse_command(body)
                from .fee_repairs import hashed
                async with db.connection() as conn,conn.transaction():
                    await source_read_lock(conn,who)
                    prior=await(await conn.execute('SELECT fingerprint,result FROM trade_operations WHERE owner_id=%s AND request_id=%s',(who.id,data['requestId']))).fetchone()
                    if prior:
                        if prior['result'].get('sourcePolicyArchive'):
                            archive=await(await conn.execute('SELECT * FROM financing_source_policy_request_archives WHERE owner_id=%s AND original_request_id=%s',(who.id,data['requestId']))).fetchone()
                            if not archive or archive['account_kind']!=kind or archive['payload_hash']!=legacy_payload_hash(data['revision'],data['policy']):raise HTTPException(409,'原融资UUID已用于其他来源或请求内容')
                            return JSONResponse({'code':0,'message':'ok','data':prior['result']['legacyReceipt']},headers=headers)
                        if prior['fingerprint']!=hashed(data):raise HTTPException(409,'请求编号已使用')
                        result=prior['result']
                        if result.get('state')=='failed':raise HTTPException(result['status'],result['message'])
                        return JSONResponse({'code':0,'message':'ok','data':result.get('legacyReceipt') or view(who.id,result['policy'])},headers=headers)
                proof=await service.preview(who,body)
                result=await service.submit(who,body,proof['previewRevision'])
                if result['state']=='failed':raise HTTPException(result['status'],result['message'])
                result=result['legacyReceipt']
            return JSONResponse({'code':0,'message':'ok','data':result},headers=headers)
        except HTTPException as error:return JSONResponse({'code':error.status_code*100+1,'message':str(error.detail),'data':None},status_code=error.status_code,headers=headers)
    @app.get('/api/v{version}/account-assets/financing-policy')
    async def read(version:int,request:Request):return await response(request,version,False)
    @app.post('/api/v{version}/account-assets/financing-policy')
    async def write(version:int,request:Request):return await response(request,version,True)
    handlers=app.state.legacy_asset_operation_adapters
    if 'financing_policy' in handlers:raise RuntimeError('duplicate financing policy receipt adapter')
    handlers['financing_policy']=lambda result:result.get('legacyReceipt') or view(result['data']['targetUserId'],result['policy'])
    app.router.routes.extend(fallback)
