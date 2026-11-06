"""Old trading read contract over one current PG ledger; no legacy business calls."""
from collections import defaultdict
from datetime import UTC, datetime
from decimal import Decimal, localcontext
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from .actual_projection import PENDING_FEE_SQL
from .fee_repair_model import effective_projection, replay
from .fee_repairs import FeeRepairs, hashed
from .legacy_portfolio import legacy_record
from .portfolio_records import record_dto
from .scope_coverage import require_global
from .trade_accounting import replay_economic_trades, rounded

MARKET_CURRENCY={'US':'USD','HK':'HKD','CN':'CNY','JP':'JPY','KR':'KRW','SG':'SGD','UK':'GBP'}
TIME_ZONES={'US':'America/New_York','HK':'Asia/Hong_Kong','CN':'Asia/Shanghai'}


def scalar(value):
    if isinstance(value,Decimal):return float(value)
    if isinstance(value,datetime):return value.astimezone(UTC).isoformat(timespec='milliseconds').replace('+00:00','Z')
    if isinstance(value,dict):return {key:scalar(item) for key,item in value.items()}
    if isinstance(value,(tuple,list)):return [scalar(item) for item in value]
    return value


def exact_scalar(value):
    """Internal workbook/import projection; legacy HTTP numeric DTO stays unchanged."""
    if isinstance(value,Decimal):return format(value,'f')
    if isinstance(value,datetime):return scalar(value)
    if isinstance(value,dict):return {key:exact_scalar(item) for key,item in value.items()}
    if isinstance(value,(tuple,list)):return [exact_scalar(item) for item in value]
    return value


def legacy_numbers(value,key=None):
    if isinstance(value,dict):return {name:legacy_numbers(item,name) for name,item in value.items()}
    if isinstance(value,list):return [legacy_numbers(item,key) for item in value]
    numeric={'triggerPrice','qty','quantity','price','fees','amount','total','cashBefore','cashAfter','cashDelta','costBefore','costAfter','quantityBefore','quantityAfter','realizedBefore','realizedAfter','feeBefore','feeAfter','realizedPnl','positionQtyBefore','positionQtyAfter','positionCostBefore','positionCostAfter'}
    if key in numeric and isinstance(value,str) and value:
        return float(Decimal(value))
    return value


def fee_transport(value,detailed):
    if isinstance(value,list):return [fee_transport(item,detailed) for item in value]
    if not isinstance(value,dict):return value
    row={key:fee_transport(item,detailed) for key,item in value.items()}
    if not detailed:
        if row.get('feeSource')=='rule_calculated':row['feeSource']='owner_recorded'
        if row.get('feeBreakdownSource') in ('rule_calculated','owner_recorded'):
            row['feeBreakdown']=None;row['feeBreakdownSource']='unavailable';row.pop('feeProvenance',None)
        for key in ('feeRuleVersion','feeRuleSnapshot','feeDetail'):row.pop(key,None)
    return row


async def snapshot_in_transaction(conn,who,*,allow_uncommitted_amendment=False,strict=True,exact=False,scope_record_id=None,scope_account_id=None):
    scope_record=None
    if scope_record_id is not None and scope_account_id is not None:
        raise HTTPException(400,'记录与账户范围不能混用')
    if scope_record_id is None and scope_account_id is None:
        await require_global(conn,who.id)
    elif scope_record_id is not None:
        if not isinstance(scope_record_id,str) or not 1<=len(scope_record_id)<=200:raise HTTPException(400,'须明确本人记录范围')
        scope_record=await(await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s AND deleted_at IS NULL',(who.id,scope_record_id))).fetchone()
        if not scope_record or not scope_record['broker_account_id']:raise HTTPException(404,'本人已归属账户记录不存在')
        from .scope_coverage import require_record
        await require_record(conn,who.id,scope_record_id)
    scoped_account=scope_record['broker_account_id'] if scope_record else scope_account_id
    if scoped_account is not None:
        from .broker_accounts import broker_account
        from .scope_coverage import account_status
        await broker_account(conn,who.id,scoped_account)
        if not await account_status(conn,who.id,scoped_account):raise HTTPException(409,'该账户原件范围尚未核对')
    if await(await conn.execute('SELECT 1 FROM trade_ledger t WHERE t.owner_id=%s AND (%s::text IS NULL OR t.record_id=%s) AND (%s::text IS NULL OR t.account_id=%s) AND '+PENDING_FEE_SQL+' LIMIT 1',(who.id,scope_record_id,scope_record_id,scoped_account,scoped_account))).fetchone():raise HTTPException(409,'旧交易协议不能将未核实实付费用表示为实际资金，请先核对')
    brokers=await(await conn.execute('SELECT * FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL AND (%s::text IS NULL OR id=%s) ORDER BY id LIMIT 10001',(who.id,scoped_account,scoped_account))).fetchall()
    if len(brokers)>10000:raise HTTPException(409,'账户范围超出本次完整交易快照预算')
    if brokers:
        state=await FeeRepairs(None).state(conn,who,brokers[0]['id'])
    else:
        rows=await(await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 10001',(who.id,))).fetchall()
        head=await(await conn.execute('SELECT revision FROM portfolio_record_collections WHERE owner_id=%s',(who.id,))).fetchone()
        state={'fills':[],'records':rows,'cash':[],'openings':[],'corrections':[],'actualConfirmations':[],'projections':[],'cashRevision':0,'collectionRevision':head['revision'] if head else 0}
    if scoped_account is not None:
        selected={row['id'] for row in state['records'] if row['broker_account_id']==scoped_account and (scope_record_id is None or row['id']==scope_record_id)}
        state={**state,'records':[row for row in state['records'] if row['id'] in selected],
               'fills':[row for row in state['fills'] if row['record_id'] in selected],
               'cash':[row for row in state['cash'] if row['account_id']==scoped_account],
               'openings':[row for row in state['openings'] if row['account_id']==scoped_account],
               'projections':[row for row in state['projections'] if row['record_id'] in selected]}
    pending=await(await conn.execute('SELECT * FROM internal_orders WHERE owner_id=%s AND (%s::text IS NULL OR record_id=%s) AND (%s::text IS NULL OR account_id=%s) ORDER BY id LIMIT 10001',(who.id,scope_record_id,scope_record_id,scoped_account,scoped_account))).fetchall()
    if len(pending)>10000 or len(state['records'])>10000 or len(state['fills'])>5000:raise HTTPException(409,'完整交易历史超出本次有界快照，须独立分段核对')
    if await(await conn.execute("SELECT 1 FROM broker_account_references r WHERE r.owner_id=%s AND (%s::text IS NULL OR r.account_id=%s) AND r.kind='order' AND NOT EXISTS(SELECT 1 FROM trade_ledger t WHERE t.owner_id=r.owner_id AND t.id::text=r.reference_id) AND NOT EXISTS(SELECT 1 FROM internal_orders i WHERE i.owner_id=r.owner_id AND i.id::text=r.reference_id) LIMIT 1",(who.id,scoped_account,scoped_account))).fetchone():raise HTTPException(409,'原委托范围尚未核对，不能返回虚假的空订单')
    kinds={row['account_kind'] for row in state['cash']}|{row['account_kind'] for row in pending}|{row['account_kind'] for row in state['fills']}
    if len(kinds)>1 or kinds-{'real','simulated'}:raise HTTPException(409,'旧交易协议无法合并真实、模拟或未知账户身份')
    rows=[row for row in state['records'] if row['deleted_at'] is None];by_record={row['id']:row for row in rows};by_broker={row['id']:row for row in brokers}
    grouped=defaultdict(list)
    for row in state['fills']:grouped[row['record_id']].append(row)
    corrections={row['trade_id']:row['new_fees'] for row in state['corrections']}
    actual={row['trade_id']:row for row in state['actualConfirmations']}
    projected_by_record=defaultdict(list)
    for projection in state['projections']:projected_by_record[projection['record_id']].append(projection)
    effective={};averages={};raw_by_id={row['id']:row for row in state['fills']};amendments={}
    for record_id,history in grouped.items():
        if record_id not in by_record:raise HTTPException(409,'原订单证券归属缺失，不能隐藏历史')
        try:effective.update(effective_projection(history,by_record[record_id],corrections,projected_by_record[record_id]))
        except ValueError:raise HTTPException(409,'原成交与更正链尚未核对') from None
        try:
            initial,events=replay(history,by_record[record_id],corrections,projected_by_record[record_id])
            from .position_transfer_checkpoint import economic_initial
            economics=replay_economic_trades(economic_initial(by_record[record_id],initial),events)
            averages[record_id]=economics.position.cost if economics.complete and economics.position.quantity>0 else None
        except ValueError:averages[record_id]=None
        for row in history:
            for amendment in row.get('_record_amendments',()):amendments[amendment['id']]=amendment
    latest={row['id']:row['_latest_amendment'] for row in state['fills'] if row.get('_latest_amendment')}
    details=await(await conn.execute('SELECT * FROM trade_fee_details WHERE owner_id=%s ORDER BY trade_id LIMIT 10001',(who.id,))).fetchall();details={row['trade_id']:row['detail'] for row in details}
    presentation=await(await conn.execute('SELECT target_kind,target_id,number FROM trade_presentation_ids WHERE owner_id=%s ORDER BY number LIMIT 20001',(who.id,))).fetchall()
    if len(presentation)>20000:raise HTTPException(409,'交易展示标识超过本次完整读取预算')
    presentation={(row['target_kind'],str(row['target_id'])):str(row['number']) for row in presentation}
    declared=await(await conn.execute('SELECT trade_id,context FROM trade_registration_contexts WHERE owner_id=%s ORDER BY trade_id LIMIT 10001',(who.id,))).fetchall()
    if len(declared)>10000:raise HTTPException(409,'完整登记上下文超出本次读取预算')
    declared={row['trade_id']:row['context'] for row in declared}
    intent_contexts=await(await conn.execute('SELECT order_id,order_revision,draft FROM internal_order_contexts WHERE owner_id=%s ORDER BY order_id,order_revision LIMIT 20001',(who.id,))).fetchall()
    if len(intent_contexts)>20000:raise HTTPException(409,'委托声明历史超出本次读取预算')
    intent_contexts={(str(item['order_id']),item['order_revision']):item['draft'] for item in intent_contexts}
    from .flat_order_notes import current_notes, note_projection
    note_declarations=await current_notes(conn,who.id,[row['id'] for row in state['fills']])
    orders=[]
    def item(row,record,*,identifier,parameters,projection,status='filled',revision=1,correction=None,origin_amendment=None):
        account=by_broker.get(row['account_id']);fee=parameters['fees'];detail=details.get(row['id']);confirmed=actual.get(row['id'])
        if correction and correction['state']=='replacement':
            detail={'source':'owner_recorded','currency':row['currency'],'total':str(fee),'components':None,'ruleVersion':None,'ruleSnapshot':None,'brokerAccountId':row['account_id'],'providerId':account['provider_id'] if account else None}
            current=origin_amendment or latest.get(row['id'])
            if current and current['evidence'].get('legacyFeeDetail'):detail=current['evidence']['legacyFeeDetail']
        elif confirmed:
            detail={'source':'owner_recorded','currency':row['currency'],'total':str(fee),'components':[{'kind':'actual_paid','amount':str(fee),'currency':row['currency']}],'ruleVersion':None,'ruleSnapshot':None,'brokerAccountId':row['account_id'],'providerId':account['provider_id'] if account else None}
        context=declared.get(row['id'])
        display_kind='amendment' if correction and correction['state']=='replacement' else 'trade'
        if display_kind=='trade' and identifier!=str(row['id']):display_kind='amendment'
        display=presentation.get((display_kind,identifier))
        if display is None:raise HTTPException(409,'交易缺少持久的平台展示标识')
        settlement_currency=parameters.get('settlement_currency',row['settlement_currency'])
        settlement_amount=parameters.get('settlement_amount',row['settlement_amount'])
        settlement_amount=Decimal(settlement_amount) if settlement_amount is not None else None
        value = {'orderNoSource':'platform_assigned','originalOrderNo':None,'registrationContextSource':'legacy_explicit_record_request' if context else 'unknown','registrationContextKnown':context is not None,'brokerExecution':False,'continuousExecution':False,'executionStatus':None,'id':identifier,'orderNo':display,'recordId':row['record_id'],'market':record['market'],'code':record['code'],'name':record['name'],
          'side':parameters.get('side',row['side']),'status':status,'revision':revision,'recordRevision':record['revision'],'identityMatches':True,
          'accountMarket':record['account_market'] or record['market'],'accountCurrency':settlement_currency,'settlementCurrency':settlement_currency if settlement_currency!=row['currency'] else None,
          'settlementAmount':settlement_amount if settlement_currency!=row['currency'] else None,
          'realizedPnl':projection.get('realized_pnl'),'positionQtyBefore':projection.get('before_quantity'),'positionQtyAfter':projection.get('after_quantity'),'positionCostBefore':projection.get('before_cost'),'positionCostAfter':projection.get('after_cost'),
          'parentOrderId':context.get('parentOrderId') if context else None,'parentTradeId':context.get('parentTradeId') if context else None,'attachmentRole':context.get('attachmentRole') if context else None,'attachments':context.get('attachments') if context else None,'attachmentInputsAvailable':bool(context and 'attachments' in context),'executionModel':'owner_recorded_fill',
          'qty':Decimal(parameters['quantity']),'price':Decimal(parameters['price']),'fees':Decimal(fee),'amount':Decimal(parameters['amount']),'orderType':context['orderType'] if context else None,
          'feeSource':'owner_recorded' if not detail else detail['source'],'feeBreakdown':None if not detail else detail.get('components'),'feeBreakdownSource':'unavailable' if not detail or detail.get('components') is None else 'owner_recorded','feeDetail':detail,
          'currentRecordBrokerAccountId':row['account_id'],'brokerAccountId':row['account_id'],'brokerAccountIdSource':'recorded_order_entry',
          'orderPrice':None,'executedPrice':Decimal(parameters['price']) if status=='filled' else None,'triggerPrice':context.get('triggerPrice') if context else None,'conditionExecutionVerified':False,
          'filledQty':Decimal(parameters['quantity']) if status=='filled' else 0,'filledQtySource':'atomic_order_status','tif':context['tif'] if context else None,'expiresAt':context.get('expiresAt') if context else None,'session':context['session'] if context else None,'triggerStatus':None,
          'tradedAt':parameters['occurred_at'],'createdAt':row['created_at'],'broker':context['brokerNameAtEntry'] if context else None,'note':row['note'],
          'currentPrice':None,'currentPriceSource':'unavailable','currentPriceAt':None,'cancellable':False,**({'correction':correction} if correction else {})}
        return note_projection(value,note_declarations.get(str(row['id']))) if status=='filled' else value
    for row in state['fills']:
        record=by_record[row['record_id']]
        parameters={'quantity':row['quantity'],'price':row['price'],'fees':corrections.get(row['id'],row['fees']),'amount':row['amount'],'occurred_at':row['occurred_at']}
        current=latest.get(row['id']);status='cancelled' if current else 'filled'
        projection={} if current else effective[row['id']]
        orders.append(item(row,record,identifier=str(row['id']),parameters=parameters,projection=projection,status=status,revision=1+int(row['id'] in corrections)+int(bool(current)),correction={'state':'superseded','operationId':str(current['request_id']),'replacementId':None if current['action']=='delete' else str(current['replacement_id'])} if current else None))
    for amendment in amendments.values():
        if amendment['action']=='delete':continue
        row=raw_by_id[amendment['trade_id']];record=by_record[row['record_id']];current=latest[row['id']];active=current['id']==amendment['id'] and not row.get('_effective_inactive')
        orders.append(item(row,record,identifier=str(amendment['replacement_id']),parameters=amendment['replacement'],projection=effective[row['id']] if active else {},status='filled' if active else 'cancelled',revision=1 if active else 2,origin_amendment=amendment,correction={'state':'replacement','operationId':str(amendment['request_id'])} if active else {'state':'superseded','operationId':str(current['request_id']),'replacementId':None if current['action']=='delete' else str(current['replacement_id'])}))
    # Internal intent is not a broker fill. Suspended old intentions remain
    # visibly inactive, preserving their actual source metadata.
    for order in pending:
        if order['status']=='filled':
            continue  # The linked trade child is the single economic fill; retain intent in its own history.
        record=by_record.get(order['record_id'])
        if not record:raise HTTPException(409,'委托证券归属缺失，不能隐藏原意图')
        if order['status']=='imported_suspended':raise HTTPException(409,'旧协议不能完整表达暂停中的未迁入意图，请按原账核对')
        intent=intent_contexts.get((str(order['id']),order['revision']))
        if intent is None and order['status'] in ('cancelled','expired'):
            # Terminal status guards preserve the immediately preceding intent fields.
            intent=intent_contexts.get((str(order['id']),order['revision']-1))
        orders.append({'id':str(order['id']),'orderNo':presentation.get(('internal_order',str(order['id']))),'orderNoSource':'platform_assigned','registrationContextKnown':intent is not None,'registrationContextSource':'explicit_owner_internal_intent' if intent else 'unknown','originalOrderNo':None,'recordId':order['record_id'],'market':order['record_market'],'code':order['record_code'],'name':record['name'],'side':order['side'],'status':order['status'],'revision':order['revision'],'recordRevision':record['revision'],
          'identityMatches':True,'accountMarket':record['account_market'] or record['market'],'accountCurrency':order['currency'],'settlementCurrency':None,'settlementAmount':None,
          'qty':order['quantity'],'price':order['limit_price'],'fees':order['fees'],'amount':order['quantity']*order['limit_price'],'orderType':intent.get('orderType') if intent else None,'orderPrice':order['limit_price'],'executedPrice':None,'filledQty':0,'filledQtySource':'atomic_order_status','continuousExecution':False,'executionStatus':'自动执行未启用' if order['status']=='pending' else None,'executionModel':'internal_pending','parentOrderId':None,'attachmentRole':None,'attachments':None,'attachmentInputsAvailable':False,'tif':intent.get('tif') if intent else None,'expiresAt':intent.get('expiresAt') if intent else None,'session':intent.get('session') if intent else None,'triggerPrice':(intent.get('triggerPrice') or intent.get('priceExact')) if intent and intent.get('orderType') in ('trigger_buy','trigger_sell','rebound_buy','rebound_sell') else intent.get('triggerPrice') if intent else None,'triggerStatus':None,'realizedPnl':None,'positionQtyBefore':None,'positionQtyAfter':None,'positionCostBefore':None,'positionCostAfter':None,'tradedAt':order['created_at'],'createdAt':order['created_at'],'broker':by_broker.get(order['account_id'],{}).get('name'),'note':order['note'],'currentPrice':None,'currentPriceSource':'unavailable','currentPriceAt':None,'currentRecordBrokerAccountId':order['account_id'],'brokerAccountId':order['account_id'],'brokerAccountIdSource':'recorded_order_entry','feeSource':'estimated_not_actual_paid','feeBreakdown':None,'feeBreakdownSource':'unavailable','cancellable':order['status']=='pending'})
    missing_context=[row['id'] for row in orders if not row.get('registrationContextKnown')]
    if strict and missing_context:raise HTTPException(409,'旧交易协议需要原委托上下文；当前成交未登记此事实，请使用可表达未知的客户端')
    currencies={row['currency'] for row in state['openings']}|{row['currency'] for row in state['cash']}
    balances={currency:sum((row['amount'] for row in state['cash'] if row['currency']==currency and row['affects_owner']),Decimal(0)) for currency in currencies}
    required={MARKET_CURRENCY.get(row['market']) for row in rows if row['qty'] is not None and row['qty']!=0}
    if None in required:raise HTTPException(409,'旧交易协议无法核对未知市场的资金单位')
    missing=sorted(required-currencies)
    complete=not missing and all(row['opening_at'] is not None for row in state['openings'])
    def at(value):
        return value if isinstance(value,datetime) else datetime.fromisoformat(value)
    positions=[]
    active_by_record=defaultdict(list)
    for order in orders:
        if order['status']=='filled':active_by_record[order['recordId']].append(order)
    observed=datetime.now(UTC)
    with localcontext() as precision:
        precision.prec=80
        facts={}
        for row in rows:
            qty=row['qty'];price=row['price'];cost=row['cost'];currency=MARKET_CURRENCY.get(row['market']);zero=qty==0
            market=Decimal(0) if zero else qty*price if qty is not None and price is not None else None
            basis=Decimal(0) if zero else qty*cost if qty is not None and cost is not None else None
            pnl=market-basis if market is not None and basis is not None else None
            active_orders=sorted(active_by_record[row['id']],key=lambda item:(at(item['tradedAt']),at(item['createdAt']),item['id']))
            last=active_orders[-1] if active_orders else None
            cleared=last['tradedAt'] if zero and last and last['side']=='sell' and last['positionQtyAfter']==0 else None
            facts[row['id']]={'market':None if market is None else rounded(market,2),'basis':None if basis is None else rounded(basis,2),'pnl':None if pnl is None else rounded(pnl,2),'percent':None if pnl is None or not basis else rounded(pnl/abs(basis)*100,2),'cycle':next((item['tradedAt'] for item in reversed(active_orders) if item['side']=='buy' and item['positionQtyBefore']==0),None) if averages.get(row['id']) is not None else None,'cleared':cleared,'clearedToday':bool(cleared and row['market'] in TIME_ZONES and at(cleared).astimezone(ZoneInfo(TIME_ZONES[row['market']])).date()==observed.astimezone(ZoneInfo(TIME_ZONES[row['market']])).date()),'average':averages.get(row['id'])}
    for row in rows:
        record=legacy_record(record_dto(row));qty=row['qty'];price=row['price'];currency=MARKET_CURRENCY.get(row['market']);zero=qty is not None and qty==0;fact=facts[row['id']]
        positions.append({'recordId':row['id'],'recordRevision':row['revision'],'name':row['name'],'code':row['code'],'market':row['market'],'accountMarket':row['account_market'] or row['market'],'accountCurrency':currency,'channel':'direct','broker':by_broker.get(row['broker_account_id'],{}).get('name'),
          'currency':currency,'instrument':{'kind':'unknown','listingStatus':'unknown','multiplier':None,'underlyingRecordId':None,'source':'unavailable','revision':0,'identityMatches':False,'updatedAt':None},'valuationBasis':'legacy_record_unit','valuationUnitMultiplier':1,
          'qty':qty,'price':price,'priceSource':'record' if price is not None else 'unavailable','priceAt':row['updated_at'] if price is not None else None,'quoteSession':None,'quoteSource':None,'quoteCached':False,
          'cost':row['cost'],'dilutedCost':row['cost'],'averageOpenCost':fact['average'],'costMethod':'diluted','averageCostComplete':fact['average'] is not None,'costUnavailableReason':'missing_cost' if row['cost'] is None else None,'cycleStartedAt':fact['cycle'],
          'nativeMarketValue':fact['market'],'nativeCostValue':fact['basis'],'nativeHoldingPnl':fact['pnl'],'valuationCurrency':'USD','marketValue':fact['market'] if currency=='USD' else None,'costValue':fact['basis'] if currency=='USD' else None,'holdingPnl':fact['pnl'] if currency=='USD' else None,'holdingPnlPct':fact['percent'],
          'dayPnl':None,'dayPnlPct':None,'dayPnlUnavailableReason':'missing_verified_day_opening_position_and_cashflows','weightPct':None,'clearedAt':fact['cleared'],'clearedToday':fact['clearedToday'],'active':qty is not None and qty!=0,'valuationComplete':currency=='USD' and fact['market'] is not None,'valuationUnavailableReason':None if currency=='USD' and fact['market'] is not None else 'missing_price' if price is None and not zero else 'missing_exchange_rate' if currency!='USD' else 'unsupported_position_quantity','rawRecord':record})
    active_positions=[row for row in positions if row['active']]
    if all(row['qty'] is not None for row in positions) and all(row['marketValue'] is not None for row in active_positions):
        with localcontext() as precision:
            precision.prec=80
            total_market=sum((row['marketValue'] for row in active_positions),Decimal(0))
            if total_market:
                for position in active_positions:position['weightPct']=rounded(position['marketValue']/total_market*100,2)
    # Quote/asOf observations do not rotate a financial revision. Full current
    # PG originals/projections/accounts/intents do; the old hash is opaque.
    revision=hashed({'viewSchema':'legacy-native-ledger-context-v1',**({'scopeRecordId':scope_record_id} if scope_record_id is not None else {}),**({'scopeAccountId':scope_account_id} if scope_account_id is not None else {}),'ledger':state,'brokers':brokers,'intents':pending,'presentation':sorted((kind,target,number) for (kind,target),number in presentation.items()),'declared':sorted((str(trade),context) for trade,context in declared.items())})
    cash={'nativeBalancesByCurrency':balances if complete else None,'sourceComplete':complete,'balancesByCurrency':balances if complete and set(balances)<={'USD'} else None,'complete':complete and set(balances)<={'USD'},'source':'recorded_cash_ledger','valuationIndependent':True,'unavailableReasons':[] if complete else ['missing_recorded_opening'],'missingOpeningCurrencies':missing,'marketAllocationAvailable':False}
    if scoped_account is not None:
        cash.update(nativeBalancesByCurrency=None,balancesByCurrency=None,sourceComplete=False,complete=False,unavailableReasons=['owner_scope_incomplete_not_requested'])
    public={'accountId':who.id,'snapshotRevision':revision,'collectionRevision':state['collectionRevision'],'asOf':observed,'cash':cash,'positions':positions,'orderContextComplete':not missing_context,'unknownOrderContextIds':missing_context,'orders':sorted(orders,key=lambda row:(at(row['tradedAt']),at(row['createdAt']),row['id']),reverse=True)}
    if scope_record is not None:
        public['projectionScope']={'kind':'owned_record','recordId':scope_record_id,'brokerAccountId':scope_record['broker_account_id'],'accountKind':brokers[0]['account_kind'],'ownerComplete':False,'ownerTotalsKnown':False}
    if scope_account_id is not None:
        public['projectionScope']={'kind':'owned_account','brokerAccountId':scope_account_id,'accountKind':brokers[0]['account_kind'],'ownerComplete':False,'ownerTotalsKnown':False}
    return state,exact_scalar(public) if exact else legacy_numbers(scalar(public))


async def command_snapshot(conn,who,revision,*,record_id=None,account_id=None):
    """Match only a current complete global or explicitly owned scoped proof; never merge books."""
    try:
        state,view=await snapshot_in_transaction(conn,who,strict=False)
    except HTTPException as error:
        if error.status_code!=409:raise
    else:
        if view['snapshotRevision']==revision:
            return state,view,False
    if record_id is None and account_id is None:
        raise HTTPException(409,'须读取明确本人账户或记录范围')
    state,view=await snapshot_in_transaction(conn,who,strict=False,scope_record_id=record_id,scope_account_id=account_id)
    return state,view,True
