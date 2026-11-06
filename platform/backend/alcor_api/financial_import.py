"""Confirmed source-ledger import into the sole canonical cash/trade/order authority.

First posting requires empty affected scopes. A subsequent authorized snapshot can
append only after its entire imported prefix and the current canonical target agree;
unrelated financial changes remain explicit conflicts and are never overwritten.
No export completeness or broker execution is inferred from a current position.
"""

import secrets
import copy
from .financial_continuation import existing_prefix,verify_target_prefix
from datetime import UTC,datetime
from decimal import Decimal,localcontext
from uuid import UUID,NAMESPACE_URL,uuid5

from fastapi import HTTPException

from psycopg import Error as DatabaseError
from psycopg.types.json import Jsonb

from .source_read_access import source_read_lock

from alcor_api.broker_accounts import broker_account
from alcor_api.security import digest
from alcor_api.trade_accounting import AccountingError,Position,apply_filled_trade,replay_economic_trades
from alcor_api.trading import MARKET_CURRENCY,Trading,exact,fingerprint,normalize,trade_value
from .financial_source import parse_source,shape,text,decimal,timestamp
from .source_uploads import SourceUploads


class FinancialImport:
    def __init__(self,db):
        self.db=db
        self.trading=Trading(db)
        self.uploads=SourceUploads(db)
        # Test fault hooks never accept an HTTP instruction to inject a failure.
        self.after_step=None
        self.after_commit=None

    def command(self,who,raw):
        shape(raw,'requestId sourceId sourceHash confirmedSourceOwner targetUid accountMap recordMap confirmedHistoricalOnly')
        try:
            request=str(UUID(raw['requestId']));source=str(UUID(raw['sourceId']))
        except (ValueError,TypeError,AttributeError):raise HTTPException(422,'导入UUID无效') from None
        if raw['targetUid']!=who.id or raw['confirmedHistoricalOnly'] is not True:
            raise HTTPException(409,'请核对本人平台UID及仅导入历史记录')
        text(raw['confirmedSourceOwner']);text(raw['sourceHash'])
        for key in ('accountMap','recordMap'):
            if not isinstance(raw[key],dict) or len(raw[key])>10000:raise HTTPException(422,'原编号映射无效')
            for a,b in raw[key].items():text(a);text(b)
            if len(set(raw[key].values()))!=len(raw[key]):raise HTTPException(409,'多个原对象不可合并成同一目标')
        return {**raw,'requestId':request,'sourceId':source}

    @staticmethod
    def event_uuid(who,source,kind,item):
        if item.get('requestId'):
            return str(UUID(item['requestId']))
        meta=source['source']
        # Version is deliberately absent: a new snapshot cannot bypass original-ID deduplication.
        return str(uuid5(NAMESPACE_URL,'alcor.financial-source/1:'+fingerprint([who.id,meta['instance'],meta['owner'],kind,item['id']])))

    @staticmethod
    def target_uuid(who,source,kind,item):
        return uuid5(NAMESPACE_URL,'alcor.financial-target/1:'+fingerprint([who.id,source['source']['instance'],source['source']['owner'],kind,item['id']]))

    async def plan(self,conn,who,data,cash_revision):
        stored=await(await conn.execute('SELECT * FROM financial_import_sources WHERE owner_id=%s AND id=%s',(who.id,data['sourceId']))).fetchone()
        if not stored:raise HTTPException(404,'封存原账不存在')
        if stored['sha256']!=data['sourceHash'] or stored['source_owner']!=data['confirmedSourceOwner']:
            raise HTTPException(409,'原账哈希或原owner确认不匹配')
        source=parse_source(bytes(stored['raw']));meta=source['source'];blockers=[]
        def block(code,original=None,detail=None):
            item={'code':code}
            if original is not None:item['originalId']=original
            if detail is not None:item['detail']=detail
            if item not in blockers:blockers.append(item)
        if not meta['complete']:block('source_coverage_incomplete')
        if meta['authority']!='frozen_authoritative_export':block('source_authority_unknown')
        if meta['cashScopeSemantics']!='owner_total_includes_allocations':block('cash_scope_overlap_unknown')
        if not meta['timezone']:block('source_timezone_missing')
        records={r['id']:r for r in source['records']};orders={r['id']:r for r in source['orders']};cash={r['id']:r for r in source['cash']}
        evidence={e['id']:e for e in source['evidence']}
        if set(data['recordMap'])!=set(records):block('record_mapping_incomplete_or_extra')
        account_ids={r['sourceAccountId'] for r in [*source['cash'],*source['orders']] if r['sourceAccountId'] is not None}
        account_ids|={a['sourceAccountId'] for s in source['cashScopes'] for a in s['accounts']}
        if set(data['accountMap'])!=account_ids:block('account_mapping_incomplete_or_extra')
        def proof(item,kind,identifier):
            if item.get('evidenceId') is None:block('source_evidence_missing',identifier)
            elif evidence[item['evidenceId']]['kind']!=kind:block('source_evidence_kind_mismatch',identifier,kind)
        applied=await existing_prefix(conn,who,data,source,block)
        for kind,items in (('record',source['records']),('cash',source['cash']),('order',source['orders'])):
            for item in items:
                prior=await(await conn.execute('SELECT target_id,operation_id,source_sha256 FROM financial_import_links WHERE owner_id=%s AND source_instance=%s AND source_owner=%s AND object_kind=%s AND original_id=%s',(who.id,meta['instance'],meta['owner'],kind,item['id']))).fetchone()
                if prior and (kind,item['id']) not in applied:block('original_id_already_imported',item['id'],{'kind':kind,'targetId':prior['target_id'],'originalOperationId':str(prior['operation_id']),'sameSourceHash':prior['source_sha256']==stored['sha256']})
        accounts={};targets={};account_revisions={};record_revisions={}
        for source_id,target in sorted(data['accountMap'].items()):
            try: row=await broker_account(conn,who.id,target)
            except HTTPException: block('target_account_missing',source_id);continue
            accounts[source_id]=row;account_revisions[target]=row['revision']
            if row['holding_source']!='manual' or row['account_kind'] not in ('real','simulated'):block('target_account_authority_protected',source_id)
        for source_id,target in sorted(data['recordMap'].items()):
            row=await self.trading.records.get(conn,who.id,target)
            if not row:block('target_record_missing',source_id);continue
            targets[source_id]=row;record_revisions[target]=row['revision']
            old=records.get(source_id)
            if old is None:continue
            if ('record',source_id) not in applied and (row['history_state']!='empty' or row['qty']!=0 or row['trade_tip_id'] is not None):block('target_record_not_empty',source_id)
            if (row['code'],row['market'],row['account_market'])!=(old['code'],old['market'],old['accountMarket']):block('target_security_identity_mismatch',source_id)
            if row['source'] not in ('','manual'):block('target_record_source_protected',source_id)
            opening=old['opening'];proof(opening,'position_opening',source_id);proof(old['closing'],'position_checkpoint',source_id)
            if decimal(opening['quantity']) is None:block('position_opening_quantity_unknown',source_id)
            elif decimal(opening['quantity'])!=0:block('verified_nonzero_position_opening_requires_continuation_mode',source_id)
            if ('record',source_id) not in applied and decimal(opening['cost'],negative=True)!=row['cost']:block('target_position_opening_cost_mismatch',source_id)
            if timestamp(opening['occurredAt'],meta['timezone']) is None:block('position_opening_time_unknown',source_id)
            if old['accountKind']=='unknown':block('source_account_kind_unknown',source_id)
        scopes={(s['accountKind'],s['currency']):s for s in source['cashScopes']}
        now=(await(await conn.execute('SELECT clock_timestamp() at')).fetchone())['at']
        for scope,s in scopes.items():
            if not s['complete']:block('cash_scope_coverage_incomplete',detail=list(scope))
            if scope[0]=='unknown':block('source_account_kind_unknown',detail=list(scope))
            if s['ownerTotal'] is None or s['unallocated'] is None or any(a['amount'] is None for a in s['accounts']):block('cash_closing_unknown',detail=list(scope))
            proof(s,'cash_checkpoint',str(scope))
            existing=(await(await conn.execute('SELECT count(*) n FROM cash_ledger_entries WHERE owner_id=%s AND account_kind=%s AND currency=%s',(who.id,*scope))).fetchone())['n']
            if existing and not any(key[0]=='cash' and link['original']['accountKind']==scope[0] and link['original']['currency']==scope[1] for key,link in applied.items()):block('target_cash_scope_not_empty',detail={'accountKind':scope[0],'currency':scope[1],'existingPostings':existing})
            pending=await(await conn.execute("SELECT 1 FROM internal_orders WHERE owner_id=%s AND account_kind=%s AND currency=%s AND status='pending' LIMIT 1",(who.id,*scope))).fetchone()
            if pending:block('target_scope_has_pending_reservations',detail=list(scope))
        events=[];linked_cash=set();normalized={};event_ids=[]
        for item in source['cash']:
            key=item['id'];scope=(item['accountKind'],item['currency'])
            if scope not in scopes:block('cash_scope_missing_from_manifest',key)
            account=accounts.get(item['sourceAccountId'])
            if item['sourceAccountId'] is not None and not account:block('cash_target_account_missing',key)
            if account and (account['account_kind']!=item['accountKind'] or item['currency'] not in account['currencies']):block('cash_target_scope_mismatch',key)
            if item['originalScope']=='unknown':block('original_cash_attribution_unknown',key)
            if item['originalScope']=='broker' and item['originalBrokerAccountId'] is None:block('original_broker_identity_missing',key)
            if item['originalScope']=='unallocated' and item['originalBrokerAccountId'] is not None:block('original_unallocated_identity_conflict',key)
            proof(item,'explicit_internal_allocation' if item['kind']=='allocation' else 'cash_opening' if item['kind']=='opening' else 'cash_posting',key)
            when=timestamp(item['occurredAt'],meta['timezone'])
            if when is None:block('cash_time_unknown',key)
            elif when>now:block('future_source_cash',key)
            if item['amount'] is None:block('original_cash_amount_unknown',key)
            if item['kind']=='allocation':
                if item['affectsOwner'] or not account:block('allocation_scope_invalid',key)
            elif not item['affectsOwner']:block('cash_owner_effect_invalid',key)
            if not account and item['kind']!='opening':block('unallocated_nonopening_requires_attribution',key)
            if item['kind'].startswith('trade_'):
                order=orders.get(item['orderId'])
                if not order or order['status']!='filled' or order['cashId']!=key:block('cash_fill_link_missing',key)
            elif item['orderId'] is not None:block('nontrade_cash_has_order_link',key)
            events.append((when,key,item))
        for order in source['orders']:
            key=order['id'];record=targets.get(order['recordId']);original=records.get(order['recordId']);account=accounts.get(order['sourceAccountId'])
            proof(order,'actual_fill' if order['status']=='filled' else 'order_intent',key)
            if not record or not original:block('order_record_mapping_missing',key)
            if not account:block('order_account_mapping_missing',key)
            if record and account and record['broker_account_id']!=account['id']:block('order_record_account_mismatch',key)
            if account and account['account_kind']!=order['accountKind']:block('order_account_kind_mismatch',key)
            if original and original['accountKind']!=order['accountKind']:block('source_record_account_kind_mismatch',key)
            if original:
                currency=MARKET_CURRENCY.get(original['market'])
                settlement='CNY' if original['market']=='HK' and original['accountMarket']=='CN' else currency
                if currency is None or order['currency']!=currency or order['settlementCurrency']!=settlement:block('source_security_settlement_mismatch',key)
            if account and order['settlementCurrency'] not in account['currencies']:block('order_account_currency_mismatch',key)
            if order['status']=='unknown':block('source_order_status_unknown',key)
            if order['fees'] is None or order['feeAuthority'] not in ('owner_recorded','broker_reported'):block('source_fee_unknown',key)
            if order['feeEvidenceId'] is None:block('independent_fee_evidence_missing',key)
            elif evidence[order['feeEvidenceId']]['kind']!=('broker_fee' if order['feeAuthority']=='broker_reported' else 'confirmed_fee'):block('independent_fee_evidence_kind_mismatch',key)
            if any(order[k] is None for k in ('quantity','price','amount','currency','settlementCurrency')):block('source_order_value_unknown',key)
            when=timestamp(order['occurredAt'],meta['timezone'])
            if when is None:block('order_time_unknown',key)
            elif when>now:block('future_source_order',key)
            if original and when and timestamp(original['opening']['occurredAt'],meta['timezone']) and when<timestamp(original['opening']['occurredAt'],meta['timezone']):block('order_precedes_verified_opening',key)
            if (order['accountKind'],order['settlementCurrency']) not in scopes:block('order_currency_scope_missing',key)
            if order['status']=='filled':
                if order['fillAuthority'] not in ('owner_recorded_history','broker_reported'):block('actual_fill_authority_unknown',key)
                posting=cash.get(order['cashId'])
                if posting is None:block('original_fill_cash_missing',key)
                else:
                    if posting['id'] in linked_cash:block('original_cash_link_reused',key)
                    linked_cash.add(posting['id'])
                    if posting['kind']!='trade_'+order['side'] or posting['orderId']!=key or posting['sourceAccountId']!=order['sourceAccountId'] or posting['accountKind']!=order['accountKind'] or posting['currency']!=order['settlementCurrency'] or timestamp(posting['occurredAt'],meta['timezone'])!=when:
                        block('original_fill_cash_identity_mismatch',key)
                    if posting['originalBrokerAccountId']!=order['originalBrokerAccountId']:block('original_fill_cash_broker_identity_mismatch',key)
                    if order['requestId'] and posting['requestId'] and UUID(order['requestId'])!=UUID(posting['requestId']):block('original_fill_cash_uuid_mismatch',key)
                if not any(order[k] is None for k in ('quantity','price','amount','fees','currency','settlementCurrency')) and record and when:
                    try:
                        normalized[key]=normalize({'requestId':order['requestId'] or (posting or {}).get('requestId') or self.event_uuid(who,source,'order',order),'recordId':record['id'],'recordRevision':record['revision'],'side':order['side'],'quantity':order['quantity'],'price':order['price'],'amount':order['amount'],'fees':order['fees'],'currency':order['currency'],'settlementCurrency':order['settlementCurrency'],'settlementAmount':order['settlementAmount'],'occurredAt':order['occurredAt'],'confirmedActualFill':True})
                    except HTTPException:block('source_fill_values_inconsistent',key)
            else:
                if order['fillAuthority']!='not_filled' or order['cashId'] is not None:block('nonfilled_intent_has_fill_or_cash',key)
                if order['intent'] is None:block('source_intent_conditions_missing',key)
                if order['side'] not in ('buy','sell') or decimal(order['quantity']) in (None,0) or decimal(order['price']) in (None,0):block('source_intent_values_unknown',key)
                if order['currency']!=order['settlementCurrency']:block('cross_currency_intent_requires_explicit_reapproval',key)
                if order['status'] in ('cancelled','canceled') and timestamp(order['cancelledAt'],meta['timezone']) is None:block('cancelled_intent_time_missing',key)
                if order['cancelledAt'] and when and timestamp(order['cancelledAt'],meta['timezone']) and timestamp(order['cancelledAt'],meta['timezone'])<when:block('cancellation_precedes_intent',key)
                if order['status']=='pending' and order['cancelledAt'] is not None:block('pending_intent_has_cancellation',key)
                event_ids.append(self.event_uuid(who,source,'order',order))
        events.sort(key=lambda e:(e[0] or datetime.min.replace(tzinfo=UTC),source['cash'].index(e[2])))
        ties={}
        for when,_,item in events:
            if when is not None and item['kind'] not in ('opening','allocation'):
                group=(item['accountKind'],item['currency'],when)
                ties.setdefault(group,[]).append(item['id'])
        for (kind,currency,when),ids in ties.items():
            if len(ids)>1:block('source_equal_time_causal_order_unproved',detail={'accountKind':kind,'currency':currency,'at':when.isoformat(),'originalIds':ids})
        # Financial values use one explicit precision context, including all differences.
        projections={};cash_projection={};steps=[]
        if not blockers:
            try:
                with localcontext() as context:
                    context.prec=80
                    positions={key:Position(decimal(r['opening']['quantity']),decimal(r['opening']['cost'],negative=True)) for key,r in records.items()}
                    history={key:[] for key in records};last_pnl={key:Decimal(0) for key in records}
                    balances={s:{'owner':Decimal(0),'accounts':{},'opened':set(),'globalOpened':False} for s in scopes}
                    prefix_positions=copy.deepcopy(positions);prefix_cash=copy.deepcopy(balances);seen_new=False
                    for when,key,item in events:
                        reused=('cash',key) in applied
                        if reused and seen_new:block('source_new_events_are_not_a_contiguous_tail',key)
                        if not reused:seen_new=True
                        scope=(item['accountKind'],item['currency']);balance=balances[scope];a=item['sourceAccountId'];amount=decimal(item['amount'],negative=True)
                        if a is None:
                            if item['kind']!='opening' or balance['globalOpened']:raise AccountingError('原全局期初重复或非法')
                            balance['globalOpened']=True
                        elif item['kind'] in ('opening','allocation'):
                            if a in balance['opened']:raise AccountingError('原账户期初重复')
                            if item['kind']=='allocation' and (not balance['globalOpened'] or amount>balance['owner']-sum(balance['accounts'].values())):raise AccountingError('原内部分配超出已证明未分配现金')
                            balance['opened'].add(a)
                        elif a not in balance['opened']:raise AccountingError('原账户现金缺少期初')
                        if item['kind']=='opening' and amount<0 or item['kind'] in ('allocation','external_deposit') and amount<0 or item['kind']=='external_withdrawal' and amount>0:raise AccountingError('原现金符号无效')
                        if item['kind'].startswith('trade_'):
                            order=orders[item['orderId']];rid=order['recordId'];command=normalized[order['id']];trade=trade_value(command)
                            result=apply_filled_trade(positions[rid],trade)
                            if result.cash is None or result.cash!=amount:raise AccountingError('原现金净额与已登记成交不守恒')
                            if result.cash_currency!=item['currency']:raise AccountingError('原现金结算币种不一致')
                            before_pnl=last_pnl[rid];history[rid].append(trade)
                            economics=replay_economic_trades(Position(decimal(records[rid]['opening']['quantity']),decimal(records[rid]['opening']['cost'],negative=True)),history[rid])
                            realized=None if trade.side=='buy' or economics.realized_pnl is None or before_pnl is None else economics.realized_pnl-before_pnl
                            last_pnl[rid]=economics.realized_pnl;positions[rid]=result.position
                            projections[order['id']]={'quantityAfter':str(result.position.quantity),'costAfter':None if result.position.cost is None else str(result.position.cost),'realizedPnl':None if realized is None else str(realized)}
                            event_ids.append(command['requestId'])
                        else:event_ids.append(self.event_uuid(who,source,'cash',item))
                        if item['affectsOwner']:balance['owner']+=amount
                        if a is not None:balance['accounts'][a]=balance['accounts'].get(a,Decimal(0))+amount
                        if balance['owner']<0 or a is not None and balance['accounts'][a]<0:raise AccountingError('原负现金需独立融资权威，不能套用普通手工现金')
                        exact(balance['owner'],negative=True)
                        if reused:
                            prefix_positions=copy.deepcopy(positions);prefix_cash=copy.deepcopy(balances)
                    await verify_target_prefix(conn,who,data,source,applied,prefix_positions,prefix_cash,targets,block)
                    for scope,balance in balances.items():
                        closing=scopes[scope];unallocated=balance['owner']-sum(balance['accounts'].values())
                        if balance['owner']!=decimal(closing['ownerTotal'],negative=True) or unallocated!=decimal(closing['unallocated'],negative=True) or balance['accounts']!={r['sourceAccountId']:decimal(r['amount'],negative=True) for r in closing['accounts']}:
                            block('source_cash_closing_mismatch',detail=list(scope))
                        cash_projection[':'.join(scope)]={'ownerTotal':str(balance['owner']),'unallocated':str(unallocated),'accounts':{data['accountMap'][k]:str(v) for k,v in balance['accounts'].items()}}
                    for rid,pos in positions.items():
                        if pos.quantity!=decimal(records[rid]['closing']['quantity']) or pos.cost!=decimal(records[rid]['closing']['cost'],negative=True):block('source_position_closing_mismatch',rid)
                        if records[rid]['closing']['quantity'] is None:block('source_position_closing_unknown',rid)
                    if len(event_ids)!=len(set(event_ids)):block('original_operation_uuid_reused')
            except (AccountingError,KeyError) as exc:block('source_ledger_not_reconcilable',detail=str(exc))
        # A source UUID cannot collide with an unrelated canonical posting, even in a different scope.
        reused_requests={str(row['original_uuid']) for row in applied.values() if row['original_uuid']}
        for kind,key in applied:
            if kind in ('cash','order'):reused_requests.add(self.event_uuid(who,source,kind,applied[kind,key]['original']))
        for request in set(event_ids)-reused_requests:
            if request==data['requestId']:block('batch_uuid_conflicts_with_source_uuid',request)
            if await(await conn.execute('SELECT 1 FROM cash_ledger_entries WHERE owner_id=%s AND request_id=%s UNION ALL SELECT 1 FROM trade_operations WHERE owner_id=%s AND request_id=%s',(who.id,request,who.id,request))).fetchone():block('source_uuid_conflicts_with_existing_operation',request)
        order_revision=await(await conn.execute('SELECT revision FROM internal_order_collections WHERE owner_id=%s',(who.id,))).fetchone()
        collection=await(await conn.execute('SELECT revision FROM portfolio_record_collections WHERE owner_id=%s',(who.id,))).fetchone()
        dependencies={'cashRevision':cash_revision,'recordsRevision':collection['revision'],'ordersRevision':order_revision['revision'] if order_revision else 0,'accounts':account_revisions,'records':record_revisions,'sourceHash':stored['sha256']}
        events=[event for event in events if ('cash',event[1]) not in applied]
        return {'ready':not blockers,'blockers':blockers,'sourceId':data['sourceId'],'sourceHash':stored['sha256'],'sourceOwner':meta['owner'],'targetUid':who.id,'mode':'verified_same_source_append_only_tail' if applied else 'empty_affected_financial_scopes','reusedSourceObjects':len(applied),'newCashPostings':sum(('cash',item['id']) not in applied for item in source['cash']),'newFilledOrders':sum(o['status']=='filled' and ('order',o['id']) not in applied for o in source['orders']),'financialApplied':False,'brokerExecution':False,'filledOrders':sum(o['status']=='filled' for o in source['orders']),'suspendedIntents':sum(o['status'] in ('pending','expired','rejected') for o in source['orders']),'cancelledIntents':sum(o['status'] in ('cancelled','canceled') for o in source['orders']),'cashPostings':len(source['cash']),'cash':cash_projection,'fills':projections},dependencies,source,normalized,events,accounts,targets

    async def preview(self,who,raw):
        data=self.command(who,raw)
        async with self.db.connection() as conn,conn.transaction():
            revision=await self.trading.lock(conn,who)
            result,dependencies,*_=await self.plan(conn,who,data,revision)
            if result['ready']:
                token=secrets.token_urlsafe(32)
                row=await(await conn.execute('INSERT INTO financial_import_previews(token_hash,owner_id,session_hash,fingerprint,dependencies) VALUES(%s,%s,%s,%s,%s) RETURNING expires_at',(digest(token),who.id,who.token_hash,fingerprint(data),Jsonb(dependencies)))).fetchone()
                result.update(preview=token,expiresAt=row['expires_at'].isoformat())
            return result

    async def previously_linked(self,conn,who,source,kind,item):
        return await(await conn.execute('SELECT 1 FROM financial_import_links WHERE owner_id=%s AND source_instance=%s AND source_owner=%s AND object_kind=%s AND original_id=%s',(who.id,source['source']['instance'],source['source']['owner'],kind,item['id']))).fetchone()

    async def link(self,conn,who,data,source,kind,item,target):
        meta=source['source']
        await conn.execute('INSERT INTO financial_import_links(owner_id,source_id,source_instance,source_owner,object_kind,original_id,original_uuid,source_version,source_sha256,target_id,operation_id,original) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',(who.id,data['sourceId'],meta['instance'],meta['owner'],kind,item['id'],item.get('requestId'),item['version'],data['sourceHash'],str(target),data['requestId'],Jsonb(item)))

    async def write_cash(self,conn,who,data,source,item,account):
        request=self.event_uuid(who,source,'cash',item)
        action='opening' if item['kind']=='allocation' else item['kind']
        command={'accountId':account['id'] if account else None,'accountKind':item['accountKind'],'currency':item['currency'],'amount':item['amount'],'occurredAt':item['occurredAt'],'action':action,'openingBasis':'allocate_verified_unallocated_checkpoint' if item['kind']=='allocation' else 'new_external_opening'}
        # Source withdrawals are already signed; the owning CashLedger API accepts their magnitude.
        if action=='external_withdrawal':command['amount']=str(-decimal(item['amount'],negative=True))
        if action=='reconcile_balance':
            _,_,before=await self.trading.cash.balances(conn,who.id,item['currency'],account['id'],item['accountKind'])
            with localcontext() as context:
                context.prec=80
                command['amount']=str(before+decimal(item['amount'],negative=True))
        _,delta,affects,_,_=await self.trading.cash.plan(conn,who,command,financial_source=True)
        if delta!=decimal(item['amount'],negative=True) or affects!=item['affectsOwner']:raise HTTPException(409,'原现金流水与平台归账规则不一致')
        identity=self.target_uuid(who,source,'cash',item)
        if action=='opening' and account:
            await conn.execute('INSERT INTO cash_ledger_accounts(owner_id,account_id,currency,opening_at,opening_basis,opening_request_id) VALUES(%s,%s,%s,%s,%s,%s)',(who.id,account['id'],item['currency'],item['occurredAt'],command['openingBasis'],request))
            await conn.execute("INSERT INTO broker_account_references(owner_id,account_id,kind,reference_id,currency) VALUES(%s,%s,'cash',%s,%s)",(who.id,account['id'],item['currency'],item['currency']))
        await conn.execute('INSERT INTO cash_ledger_entries(id,owner_id,account_id,account_kind,currency,request_id,kind,amount,affects_owner,occurred_at,note) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',(identity,who.id,account['id'] if account else None,item['accountKind'],item['currency'],request,item['kind'],delta,affects,item['occurredAt'],'Imported original cash posting'))
        await conn.execute('UPDATE cash_ledger_collections SET revision=revision+1 WHERE owner_id=%s',(who.id,))
        await self.link(conn,who,data,source,'cash',item,identity)
        return str(identity)

    async def write_fill(self,conn,who,data,source,order,posting,command):
        record=await self.trading.records.get(conn,who.id,command['recordId'])
        command={**command,'recordRevision':record['revision']}
        record,account,result,balance,total=await self.trading.plan(conn,who,command,financial_source=True)
        if result.cash!=decimal(posting['amount'],negative=True):raise HTTPException(409,'原现金与实际归账金额不符')
        trade_id=self.target_uuid(who,source,'order',order);cash_id=self.target_uuid(who,source,'cash',posting)
        await conn.execute('INSERT INTO trade_ledger(id,owner_id,request_id,record_id,account_id,account_kind,side,quantity,price,amount,fees,currency,settlement_currency,settlement_amount,cash_delta,cash_entry_id,previous_trade_id,before_record_revision,before_quantity,before_cost,after_quantity,after_cost,realized_pnl,input_payload,source,occurred_at,note) VALUES('+','.join(['%s']*27)+')',(trade_id,who.id,command['requestId'],record['id'],account['id'],account['account_kind'],command['side'],command['quantity'],command['price'],command['amount'],command['fees'],command['currency'],command['settlementCurrency'],command['settlementAmount'],result.cash,cash_id,record['trade_tip_id'],record['revision'],record['qty'],record['cost'],result.position.quantity,result.position.cost,result.realized_pnl,Jsonb(command),order['feeAuthority'],command['occurredAt'],'Imported original historical fill'))
        await conn.execute("UPDATE portfolio_records SET qty=%s,cost=%s,history_state='has_trades',trade_tip_id=%s,updated_at=clock_timestamp() WHERE owner_id=%s AND id=%s",(result.position.quantity,result.position.cost,trade_id,who.id,record['id']))
        await conn.execute('INSERT INTO cash_ledger_entries(id,owner_id,account_id,account_kind,currency,request_id,kind,amount,affects_owner,occurred_at,note,source_trade_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,true,%s,%s,%s)',(cash_id,who.id,account['id'],account['account_kind'],result.cash_currency,command['requestId'],'trade_'+command['side'],result.cash,command['occurredAt'],'Imported original cash posting',trade_id))
        await conn.execute('UPDATE cash_ledger_collections SET revision=revision+1 WHERE owner_id=%s',(who.id,))
        await conn.execute("INSERT INTO broker_account_references(owner_id,account_id,kind,reference_id,currency) VALUES(%s,%s,'order',%s,%s)",(who.id,account['id'],str(trade_id),result.cash_currency))
        receipt={'requestId':command['requestId'],'tradeId':str(trade_id),'cashEntryId':str(cash_id),'state':'completed','source':'legacy_imported','brokerExecution':False,'importOperationId':data['requestId'],**self.trading.projection(command,record,account,result,balance,total)}
        receipt['source']=order['feeAuthority'];receipt['provenance']='legacy_imported'
        await conn.execute('INSERT INTO trade_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,command['requestId'],fingerprint(command),Jsonb(receipt)))
        await self.link(conn,who,data,source,'order',order,trade_id)
        await self.link(conn,who,data,source,'cash',posting,cash_id)
        return str(trade_id)

    async def write_intent(self,conn,who,data,source,order,account,record):
        identity=self.target_uuid(who,source,'order',order)
        with localcontext() as context:
            context.prec=80
            reservation=decimal(order['quantity'])*decimal(order['price'])+decimal(order['fees']) if order['side']=='buy' else Decimal(0)
        status='cancelled' if order['status'] in ('cancelled','canceled') else 'imported_suspended'
        await conn.execute('INSERT INTO internal_orders(id,owner_id,account_id,account_kind,record_id,record_code,record_market,record_account_market,record_source,currency,side,quantity,limit_price,fees,reservation_cash,status,created_at,cancelled_at,note,order_type,import_original_status,import_original_intent) VALUES('+','.join(['%s']*22)+')',(identity,who.id,account['id'],account['account_kind'],record['id'],record['code'],record['market'],record['account_market'],record['source'],order['settlementCurrency'],order['side'],order['quantity'],order['price'],order['fees'],reservation,status,order['occurredAt'],order['cancelledAt'] if status=='cancelled' else None,'Imported old intent; not approved for execution','imported',order['status'],Jsonb(order['intent'])))
        await self.link(conn,who,data,source,'order',order,identity)
        return str(identity)

    async def submit(self,who,raw,preview):
        data=self.command(who,raw);hashed=fingerprint(data)
        if not isinstance(preview,str) or not 1<=len(preview)<=128:raise HTTPException(422,'导入预览凭证无效')
        async with self.db.connection() as conn,conn.transaction():
            revision=await self.trading.lock(conn,who)
            prior=await(await conn.execute('SELECT fingerprint,result FROM financial_import_operations WHERE owner_id=%s AND request_id=%s',(who.id,data['requestId']))).fetchone()
            if prior:
                if prior['fingerprint']!=hashed:raise HTTPException(409,'原导入UUID已用于其他内容')
                return prior['result']
            proof=await(await conn.execute('SELECT * FROM financial_import_previews WHERE owner_id=%s AND session_hash=%s AND token_hash=%s AND consumed_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE',(who.id,who.token_hash,digest(preview)))).fetchone()
            if not proof or proof['fingerprint']!=hashed:raise HTTPException(409,'导入预览过期、会话或输入已变化')
            result,dependencies,source,normalized,events,accounts,records=await self.plan(conn,who,data,revision)
            if dependencies!=proof['dependencies'] or not result['ready']:raise HTTPException(409,{'message':'导入目标或原账已变化，请重新预览','blockers':result['blockers']})
            await conn.execute('UPDATE financial_import_previews SET consumed_at=clock_timestamp() WHERE token_hash=%s',(digest(preview),))
            try:
                async with conn.transaction():
                    # The operation is inserted before link constraints are flushed per complete fill.
                    # Its final value is computed now; a failing mutation rolls it back with all ledgers.
                    receipt={**result,'requestId':data['requestId'],'state':'completed','financialApplied':True,'originalCashCopiedOnce':True,'sourceIdsPreserved':True}
                    await conn.execute('INSERT INTO financial_import_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,data['requestId'],hashed,Jsonb(receipt)))
                    for item in source['records']:
                        if not await self.previously_linked(conn,who,source,'record',item):await self.link(conn,who,data,source,'record',item,data['recordMap'][item['id']])
                    for index,(_,key,item) in enumerate(events):
                        account=accounts.get(item['sourceAccountId'])
                        if item['kind'].startswith('trade_'):
                            order=next(o for o in source['orders'] if o['id']==item['orderId'])
                            await self.write_fill(conn,who,data,source,order,item,normalized[order['id']])
                        else:await self.write_cash(conn,who,data,source,item,account)
                        if self.after_step:await self.after_step(conn,index,item)
                        # A filled record's tip must match EACH step before the next fill advances it.
                        await conn.execute('SET CONSTRAINTS ALL IMMEDIATE')
                        await conn.execute('SET CONSTRAINTS ALL DEFERRED')
                    for order in source['orders']:
                        if order['status']!='filled' and not await self.previously_linked(conn,who,source,'order',order):await self.write_intent(conn,who,data,source,order,accounts[order['sourceAccountId']],records[order['recordId']])
                    for original in source['records']:
                        row=await self.trading.records.get(conn,who.id,data['recordMap'][original['id']])
                        if row['qty']!=decimal(original['closing']['quantity']) or row['cost']!=decimal(original['closing']['cost'],negative=True):raise HTTPException(409,'导入后持仓数量或原登记成本对账不一致')
                    for scope,expected in result['cash'].items():
                        kind,currency=scope.split(':')
                        total,attributed,_=await self.trading.cash.balances(conn,who.id,currency,None,kind)
                        with localcontext() as context:
                            context.prec=80
                            if total!=Decimal(expected['ownerTotal']) or total-attributed!=Decimal(expected['unallocated']):raise HTTPException(409,'导入后原币总额或未分配现金不一致')
                        for account,balance in expected['accounts'].items():
                            total,attributed,actual=await self.trading.cash.balances(conn,who.id,currency,account,kind)
                            with localcontext() as context:
                                context.prec=80
                                if actual!=Decimal(balance) or total!=Decimal(expected['ownerTotal']) or total-attributed!=Decimal(expected['unallocated']):raise HTTPException(409,'导入后原币现金对账不一致')
                    await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'financial-source.imported',%s,%s)",(who.id,data['sourceId'],data['requestId']))
                    await conn.execute('SET CONSTRAINTS ALL IMMEDIATE')
            except (DatabaseError,HTTPException,RuntimeError):
                # Preserve only the bounded original-UUID failure after the savepoint removes every mutation.
                receipt={'requestId':data['requestId'],'state':'failed','financialApplied':False,'sourceId':data['sourceId'],'sourceHash':data['sourceHash'],'failure':'atomic_import_rejected','retry':'query_original_uuid_then_repreview'}
                await conn.execute('INSERT INTO financial_import_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,data['requestId'],hashed,Jsonb(receipt)))
        if self.after_commit:await self.after_commit(receipt)
        return receipt

    async def receipt(self,who,request):
        async with self.db.connection() as conn,conn.transaction():
            await source_read_lock(conn,who)
            row=await(await conn.execute('SELECT result FROM financial_import_operations WHERE owner_id=%s AND request_id=%s',(who.id,request))).fetchone()
            if not row:raise HTTPException(404,'原导入UUID尚无回执')
            return row['result']

    async def source_objects(self,who,source_id,kind,limit,offset):
        async with self.db.connection() as conn,conn.transaction():
            await source_read_lock(conn,who)
            row=await(await conn.execute('SELECT * FROM financial_import_sources WHERE owner_id=%s AND id=%s',(who.id,source_id))).fetchone()
            if not row:raise HTTPException(404,'封存原账不存在')
            source=parse_source(bytes(row['raw']));items=[]
            original_rows=source[{'record':'records','order':'orders','cash':'cash'}[kind]]
            for original in original_rows[offset:offset+limit]:
                link=await(await conn.execute('SELECT * FROM financial_import_links WHERE owner_id=%s AND source_instance=%s AND source_owner=%s AND object_kind=%s AND original_id=%s',(who.id,row['source_instance'],row['source_owner'],kind,original['id']))).fetchone()
                same=bool(link and link['original']==original)
                items.append({'originalId':original['id'],'originalVersion':original['version'],'original':original,'targetId':link['target_id'] if link else None,'originalOperationId':str(link['operation_id']) if link else None,'importSourceHash':link['source_sha256'] if link else None,'matchesImportedOriginal':same,'financialApplied':same and (kind=='cash' or kind=='order' and original['status']=='filled'),'retainedAsIntent':same and kind=='order' and original['status']!='filled'})
            return {'sourceId':str(source_id),'sourceHash':row['sha256'],'sourceOwner':row['source_owner'],'targetUid':who.id,'coverageComplete':source['source']['complete'],'snapshotItemCount':len(original_rows),'nextOffset':offset+len(items) if offset+len(items)<len(original_rows) else None,'items':items}
