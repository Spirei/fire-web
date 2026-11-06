"""One original/source-to-canonical registered-book proof, with no rate dependency."""
import json
from datetime import datetime
from decimal import Decimal
from uuid import UUID,uuid4
from fastapi import HTTPException
from psycopg.types.json import Jsonb
from .broker_accounts import broker_account
from .trading import Trading
from .source_mapping import CURRENCY,legacy_settlement_currency
from .estimate_model import BaselineError,verify_prefix

def value(row,key):
    cell=(row or {}).get(key)
    return None if not cell or cell.get('null') else cell.get('text')


def exact(row,key):
    cell=(row or {}).get(key)
    if not cell or cell.get('null'):raise BaselineError('registered_value_unknown')
    if cell.get('storedDecimalExact') is not True and cell.get('storageType') not in ('text','character varying','bigint','integer','smallint'):
        raise BaselineError('stored_decimal_precision_unknown')
    amount=Decimal(cell['text'])
    if not amount.is_finite():raise BaselineError('registered_value_invalid')
    return amount


class RegisteredBaselineVerifier:
    def __init__(self,db,authority):self.db=db;self.authority=authority;self.trading=Trading(db)

    async def verify(self,conn,who,data,*,estimate_market=False):
        original=await(await conn.execute('SELECT * FROM legacy_source_manifests WHERE owner_id=%s AND id=%s',(who.id,data['manifestId']))).fetchone()
        if not original:raise HTTPException(404,'本人已登记的原始清单不存在')
        await self.authority.archive_grant(conn,who,original['grant_id'],original['grant_revision'],manifest_id=original['id'])
        head=await(await conn.execute('SELECT * FROM legacy_source_heads WHERE owner_id=%s',(who.id,))).fetchone()
        if not head or head['manifest_id']!=original['id']:raise HTTPException(409,'来源清单前驱已变化，请重新核对')
        if not original['manifest']['coverage']['complete']:raise HTTPException(409,'原始表范围未完整核实，不能核对既有登记基线')
        raw=json.loads(bytes(original['raw']));tables={key:table['rows'] for key,table in raw['tables'].items()}
        orders={value(row,'id'):row for row in tables['trade_orders']};records={value(row,'id'):row for row in tables['records']}
        links={value(row,'order_id'):row for row in tables['broker_cash_order_links']};old_accounts={value(row,'id'):row for row in tables['broker_accounts']}
        versions={value(row,'order_id'):value(row,'revision') for row in tables['app_asset_order_versions']}
        requests={}
        for row in tables['app_asset_operations']:
            try:receipt=json.loads(value(row,'result_json'))
            except (ValueError,TypeError):continue
            if not isinstance(receipt,dict) or not isinstance(receipt.get('data') or {},dict):continue
            items=(receipt.get('data') or {}).get('items',[])
            if receipt.get('kind')=='submit_trade' and receipt.get('state')=='completed' and isinstance(items,list) and len(items)==1 and isinstance(items[0],dict) and isinstance(items[0].get('id'),str):requests[items[0]['id']]=value(row,'request_id')
        account=await broker_account(conn,who.id,data['brokerAccountId'])
        if account['holding_source']!='manual' or account['account_kind'] not in ('real','simulated'):raise HTTPException(409,'官方或身份未知的账户不能作登记簿估算')
        excluded=[];groups={};bindings=[];snapshots={}
        for selection in data['selections']:
            oid=selection['originalOrderId'];old=orders.get(oid)
            if not old:raise HTTPException(404,'原始订单不存在')
            if value(old,'status')!='filled':
                if selection['tradeId'] is not None:raise HTTPException(409,'非成交原意图不能绑定为成交')
                record=records.get(value(old,'record_id'))
                excluded.append({'orderId':oid,'reason':'not_filled_equity_trade','status':value(old,'status'),'revision':versions.get(oid),'recordRevision':value(record,'revision')});continue
            if selection['tradeId'] is None:raise HTTPException(422,'须明确已有本人成交编号')
            facts=original['manifest']['orderFacts'].get(oid,{})
            if facts.get('registeredFee') is None:raise HTTPException(409,'原登记费用未知，不能用0代替')
            if facts.get('actualFeeKnown') is not False:raise HTTPException(409,'本人明确登记的实际费用受到保护，不能按费率覆盖')
            if exact(old,'fees')!=0:raise HTTPException(409,'仅核对已有登记0的缺费基线')
            target=await(await conn.execute('SELECT * FROM trade_ledger WHERE owner_id=%s AND id=%s',(who.id,selection['tradeId']))).fetchone()
            if not target or target['source'] not in ('unverified_legacy','legacy_import_zero') or target['fees']!=0 or target['account_id']!=account['id']:raise HTTPException(409,'只允许已有未核实登记0的本人成交基线')
            if await(await conn.execute('SELECT 1 FROM actual_fee_confirmations WHERE owner_id=%s AND trade_id=%s',(who.id,target['id']))).fetchone():raise HTTPException(409,'已有独立实际费用证据，不能重做缺费基线')
            broker_id=value(links.get(oid),'account_id');source_account=old_accounts.get(broker_id)
            if not source_account or value(source_account,'account_kind')!=account['account_kind'] or value(source_account,'provider_id')!=account['provider_id'] or value(source_account,'holding_source')!='manual':raise HTTPException(409,'缺少原成交当时券商及真实模拟身份，不能从当前账户猜测')
            record=records.get(value(old,'record_id'));current=await self.trading.records.get(conn,who.id,target['record_id'])
            if not record or not current or (value(record,'code'),value(record,'market'),value(record,'account_market') or '')!=(current['code'],current['market'],current['account_market']):raise HTTPException(409,'原证券与已有目标身份不匹配')
            if estimate_market:
                expected_market={'longbridge':'US','huatai':'CN'}.get(account['provider_id'])
                if current['market']!=expected_market or current['account_market'] not in ('',expected_market) or target['currency']!=target['settlement_currency']:raise HTTPException(409,'此市场或跨币种结算不支持历史费率估算')
            source_opening=next((r for r in tables['broker_cash_accounts'] if value(r,'account_id')==broker_id and value(r,'currency')==target['settlement_currency']),None)
            target_opening=await(await conn.execute('SELECT a.*,e.amount,e.affects_owner FROM cash_ledger_accounts a JOIN cash_ledger_entries e ON e.owner_id=a.owner_id AND e.account_id=a.account_id AND e.currency=a.currency AND e.request_id=a.opening_request_id WHERE a.owner_id=%s AND a.account_id=%s AND a.currency=%s',(who.id,account['id'],target['settlement_currency']))).fetchone()
            if not source_opening or not target_opening or value(source_opening,'opening_basis')!='new_external_opening' or target_opening['opening_basis']!='new_external_opening' or not target_opening['affects_owner'] or exact(source_opening,'opening_amount')!=target_opening['amount'] or datetime.fromisoformat(value(source_opening,'opening_at'))!=target_opening['opening_at']:raise HTTPException(409,'原账户现金期初与已有登记现金基线不一致')
            group=groups.setdefault(target['record_id'],{'sourceRecord':value(old,'record_id'),'kind':selection['instrumentKind'],'selections':set(),'targets':{},'current':current})
            if group['sourceRecord']!=value(old,'record_id') or group['kind']!=selection['instrumentKind']:raise HTTPException(409,'同一登记前缀不得合并不同原证券或证券类型')
            group['selections'].add(oid);group['targets'][oid]=target
        for record_id,group in groups.items():
            source_rows=sorted((row for row in orders.values() if value(row,'record_id')==group['sourceRecord'] and value(row,'status')=='filled'),key=lambda row:(value(row,'traded_at') or '',value(row,'id')))
            if len(source_rows)>1000:raise HTTPException(409,'登记前缀超出本次有界核对范围，须明确分段')
            target_rows=await(await conn.execute('SELECT * FROM trade_ledger WHERE owner_id=%s AND record_id=%s ORDER BY before_record_revision',(who.id,record_id))).fetchall()
            by_request={str(row['request_id']):row for row in target_rows};source_history=[];target_history=[];proof=[]
            for old in source_rows:
                oid=value(old,'id');fact=original['manifest']['orderFacts'].get(oid,{})
                row=by_request.get(requests.get(oid)) or group['targets'].get(oid)
                if not row:raise HTTPException(409,'原UUID缺少对应的已有登记，不能猜测经济前缀')
                if oid in group['targets'] and row['id']!=group['targets'][oid]['id']:raise HTTPException(409,'所选目标成交与原UUID对应的已有登记不一致')
                try:
                    registered=exact(old,'fees');when=datetime.fromisoformat(value(old,'traded_at'))
                    if when.tzinfo is None:raise ValueError()
                    snapshot=(await(await conn.execute('SELECT legacy_fee_registered_target_snapshot(%s,%s) value',(who.id,row['id']))).fetchone())['value']
                    current_source={'id':oid,'original_request_id':requests.get(oid),'original_order_version':versions.get(oid),'source_timezone':original['manifest']['source']['timezone'],'side':value(old,'side'),'quantity':exact(old,'qty'),'price':exact(old,'price'),'amount':exact(old,'amount'),'registered_fee':registered,'actual_fee_known':fact.get('actualFeeKnown') is True,'currency':CURRENCY.get(value(old,'market')),'settlement_currency':'CNY' if value(old,'settlement_currency')=='CNY' else legacy_settlement_currency(value(old,'market')),'settlement_amount':None if value(old,'settlement_amount') is None else exact(old,'settlement_amount'),'occurred_at':when,'before_quantity':exact(old,'position_qty_before'),'before_cost':exact(old,'position_cost_before'),'after_quantity':exact(old,'position_qty_after'),'after_cost':exact(old,'position_cost_after'),'registered_cash_delta':fact.get('cashProjection',{}).get('exactStoredDecimalNet')}
                except (BaselineError,ValueError,TypeError):raise HTTPException(409,'原登记前缀数值、现金或时区未知') from None
                # Market/settlement and exact stored cash are source facts, not
                # an assumption copied from the current target account.
                source_cash_currency=value(links.get(oid),'currency')
                if source_cash_currency!=row['settlement_currency'] or value(old,'market')!=group['current']['market'] or value(old,'code')!=group['current']['code']:raise HTTPException(409,'原币种、结算或证券不匹配')
                source_history.append(current_source);target_history.append(row)
                packed={key:str(v) if isinstance(v,Decimal) else v.isoformat() if isinstance(v,datetime) else str(v) if isinstance(v,UUID) else v for key,v in current_source.items()}
                proof.append({'originalOrderId':oid,'tradeId':str(row['id']),'source':packed,'canonical':snapshot})
                snapshots[str(row['id'])]=snapshot
                if oid in group['selections']:
                    bindings.append({'id':str(uuid4()),'sourceInstance':original['manifest']['source']['instance'],'sourceOwner':original['manifest']['source']['owner'],'originalOrderId':oid,'tradeId':str(row['id']),'cashEntryId':str(row['cash_entry_id']),'recordId':record_id,'accountId':account['id'],'originalRow':old,'canonical':snapshot,'prefix':proof})
            # Final prefix is attached to each selected binding only after all
            # rows have been compared. No truncated prefix can be committed.
            for binding in bindings:
                if binding['recordId']==record_id:binding['prefix']=proof
            cash=(await(await conn.execute('SELECT coalesce(sum(amount),0) balance FROM cash_ledger_entries WHERE owner_id=%s AND account_id=%s AND currency=%s',(who.id,account['id'],target_history[0]['settlement_currency']))).fetchone())['balance']
            outside=any(value(row,'id') not in group['selections'] and original['manifest']['orderFacts'].get(value(row,'id'),{}).get('actualFeeKnown') is not True for row in orders.values() if value(row,'status')=='filled' and value(links.get(value(row,'id')),'account_id')==value(links.get(next(iter(group['selections']))),'account_id'))
            source_account=value(links.get(next(iter(group['selections']))),'account_id')
            if original['financial_raw']:
                normalized=json.loads(bytes(original['financial_raw']))
                checkpoints=[a for scope in normalized['cashScopes'] for a in scope['accounts'] if a['sourceAccountId']==source_account]
                if not checkpoints or any(a['amount'] is None for a in checkpoints):outside=True
            else:outside=True
            try:registered=verify_prefix(source_history,target_history)
            except BaselineError as exc:raise HTTPException(409,'已有登记与原经济前缀不一致：'+str(exc)) from None
            source_record=records[group['sourceRecord']]
            if exact(source_record,'qty')!=group['current']['qty'] or exact(source_record,'cost')!=group['current']['cost'] or Decimal(registered['quantity'])!=group['current']['qty'] or Decimal(registered['registeredCost'])!=group['current']['cost']:raise HTTPException(409,'原登记持仓、现有记录或未建模更正发生变化')
            group.update(sourceHistory=source_history,targetHistory=target_history,registered=registered,cash=cash,cashUnknownOutside=outside,prefix=proof)
        collection=await(await conn.execute('SELECT revision FROM cash_ledger_collections WHERE owner_id=%s',(who.id,))).fetchone()
        if not collection:raise HTTPException(409,'已有登记现金版本缺失，不能自动初始化金融账')
        stable={'manifest':original['manifest_sha256'],'grantRevision':original['grant_revision'],'cashRevision':collection['revision'],'accountRevision':account['revision'],'records':{key:item['current']['revision'] for key,item in groups.items()},'snapshots':snapshots}
        return {'original':original,'account':account,'groups':groups,'bindings':bindings,'excluded':excluded,'stable':stable}

    async def persist(self,conn,who,manifest_id,bindings,*,after_step=None):
        result=[]
        for index,binding in enumerate(bindings):
            existing=await(await conn.execute('SELECT * FROM legacy_fee_baseline_bindings WHERE owner_id=%s AND source_instance=%s AND source_owner=%s AND original_order_id=%s',(who.id,binding['sourceInstance'],binding['sourceOwner'],binding['originalOrderId']))).fetchone()
            if existing:
                if str(existing['trade_id'])!=binding['tradeId']:raise HTTPException(409,'已有原登记归属不可替换')
                binding={**binding,'id':str(existing['id'])}
            else:
                await conn.execute('INSERT INTO legacy_fee_baseline_bindings(owner_id,id,first_manifest_id,source_instance,source_owner,original_order_id,trade_id,cash_entry_id,record_id,account_id,registered_fee,actual_fee_known,original_row,canonical_snapshot,prefix_proof) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,0,false,%s,%s,%s)',(who.id,binding['id'],manifest_id,binding['sourceInstance'],binding['sourceOwner'],binding['originalOrderId'],binding['tradeId'],binding['cashEntryId'],binding['recordId'],binding['accountId'],Jsonb(binding['originalRow']),Jsonb(binding['canonical']),Jsonb(binding['prefix'])))
            if after_step:await after_step(conn,index,binding)
            result.append(binding)
        return result
