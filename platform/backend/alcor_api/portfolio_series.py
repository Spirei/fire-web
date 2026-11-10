"""Owned observed closes and effective trade evidence; never holdings-derived history."""

from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, localcontext
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from .actual_projection import PENDING_FEE_SQL
from .fee_repair_model import effective_projection
from .fee_repairs import hashed
from .market_contract import ZONES
from .market_history_reads import LicensedHistory
from .native_app_auth import CLIENT, authenticate
from .position_transfer_checkpoint import attach_openings
from .security import lock_mutation_identity
from .trade_amendment_history import attach_amendments, effective_rows


def packed(value):
    if isinstance(value,Decimal):return str(value)
    if isinstance(value,(datetime,date)):return value.isoformat()
    if isinstance(value,UUID):return str(value)
    if isinstance(value,dict):return {key:packed(item) for key,item in value.items()}
    if isinstance(value,(list,tuple)):return [packed(item) for item in value]
    return value


async def authorize(conn,who):
    await lock_mutation_identity(conn,who,require_admin=False)
    user=await(await conn.execute('SELECT role FROM users WHERE id=%s',(who.id,))).fetchone()
    if not user or user['role']!=who.role:raise HTTPException(403,'账号权限已变化')
    if getattr(who,'native_client',False):
        grant=await authenticate(conn,who.native_access_token,'portfolio.read')
        if grant['id']!=who.grant_id or grant['user_id']!=who.id or grant['client_id']!=CLIENT:
            raise HTTPException(401,'客户端连接已变化')


def period_analysis(orders,closes,coverage,start,through):
    totals={}
    with localcontext() as precision:
        precision.prec=160
        for order in orders:
            if not order.get('tradedAt') or order.get('amount') is None or order.get('fees') is None:
                continue
            local=datetime.fromisoformat(order['tradedAt']).astimezone(ZoneInfo(ZONES.get(order['market'],'UTC'))).date().isoformat()
            if not start<=local<=through:continue
            currency=order['currency']
            item=totals.setdefault(currency,{'currency':currency,'eventCount':0,'actualPaidKnownCount':0,
                'grossBuys':Decimal(0),'grossSells':Decimal(0),'actualPaidFeesObservedSubtotal':Decimal(0),
                'netDividendsObservedSubtotal':Decimal(0),'realizedPnlObservedSubtotal':Decimal(0),
                'unknownFeeCount':0,'unknownRealizedCount':0,'realizedPnlComplete':True})
            item['eventCount']+=1
            if order['side'] in ('buy','sell'):
                item['grossBuys' if order['side']=='buy' else 'grossSells']+=Decimal(order['amount'])
            if order['actualFeeKnown']:
                item['actualPaidKnownCount']+=1
                item['actualPaidFeesObservedSubtotal']+=Decimal(order['fees'])
                if order['side']=='dividend' and order['currency']==order['settlementCurrency']:
                    item['netDividendsObservedSubtotal']+=Decimal(order['amount'])-Decimal(order['fees'])
            else:
                item['unknownFeeCount']+=1
            if order['side'] in ('sell','dividend'):
                if order['realizedPnl'] is None:
                    item['unknownRealizedCount']+=1
                    item['realizedPnlComplete']=False
                else:item['realizedPnlObservedSubtotal']+=Decimal(order['realizedPnl'])
        trends=[]
        for rid,rows in closes.items():
            selected=[row for row in rows if start<=row['d']<=through]
            if not selected:continue
            first,last=selected[0],selected[-1]
            before,after=Decimal(first['c']),Decimal(last['c'])
            trends.append({'recordId':rid,'first':first,'last':last,'priceChange':str(after-before),
                'priceChangePct':str((after-before)/before*100) if before>0 else None,'observedBars':len(selected),
                'sourceRevision':last['sourceRevision'],'adjust':last['adjust'],'basis':'actual_observed_closes_not_account_return'})
    observed=bool(totals or trends)
    partial=bool(coverage['missing'] or any(item['unknownFeeCount'] or item['unknownRealizedCount'] for item in totals.values()))
    return packed({'state':'partial' if observed and partial else 'observed' if observed else 'unknown',
        'start':start,'through':through,'dateBasis':'exchange_local_calendar_dates',
        'basis':'observed_effective_trades_native_currency','byCurrency':list(totals.values()),'priceTrends':trends,
        'observedSubtotalsAreCompleteAccountReturn':False,
        'completePeriodReturn':{'state':'unknown','value':None,'timeWeightedReturn':None,'dailyAssetCurve':None,
            'reasons':['missing_verified_period_opening_nav','historical_cash_fx_observation_coverage_unknown']}})


class PortfolioSeries:
    def __init__(self,db,authority):
        self.db,self.authority=db,authority
        self.history=LicensedHistory(authority)

    async def read(self,who,*,days=330,account_kind=None,broker_account_id=None,record_id=None,
                   source_revision=None,adjust=None,start=None,through=None,before=None,expected_revision=None,
                   order_offset=0,order_limit=500,_snapshot_started=False):
        if type(days) is not int or not 60<=days<=1200 or type(order_offset) is not int or not 0<=order_offset<=5000 or type(order_limit) is not int or not 1<=order_limit<=5000:
            raise HTTPException(400,'期间或分页范围无效')
        if account_kind not in (None,'real','simulated') or adjust not in (None,'none','qfq','hfq'):
            raise HTTPException(400,'须选择明确真实/模拟账本及复权口径')
        try:
            revision=UUID(str(source_revision)) if source_revision else None
            today=datetime.now(UTC).date()
            end=date.fromisoformat(through) if through else today
            begin=date.fromisoformat(start) if start else end-timedelta(days=days-1)
            cursor=date.fromisoformat(before).isoformat() if before else None
            if begin>end or (end-begin).days>365*20:raise ValueError()
        except (ValueError,TypeError):raise HTTPException(400,'期间日期或来源版本无效') from None
        async with self.db.connection() as conn,conn.transaction():
            if not _snapshot_started:await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
            await authorize(conn,who)
            accounts=await(await conn.execute('SELECT id,account_kind FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 1001',(who.id,))).fetchall()
            if len(accounts)>1000:raise HTTPException(409,'账户范围超出完整读取预算')
            kinds={row['account_kind'] for row in accounts if row['account_kind'] in ('real','simulated') and (not broker_account_id or row['id']==broker_account_id)}
            if account_kind is None:
                if len(kinds)>1:raise HTTPException(409,'请明确选择真实或模拟账本，不合并两个账本')
                account_kind=next(iter(kinds)) if kinds else None
            if broker_account_id and not any(row['id']==broker_account_id and row['account_kind']==account_kind for row in accounts):
                raise HTTPException(404,'所选本人账户或账本不存在')
            selected=[row['id'] for row in accounts if row['account_kind']==account_kind and (not broker_account_id or row['id']==broker_account_id)]
            records=await(await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND broker_account_id=ANY(%s::text[]) AND (%s::text IS NULL OR id=%s) ORDER BY id LIMIT 201',
                (who.id,selected,record_id,record_id))).fetchall()
            if len(records)>200:raise HTTPException(409,'本次超过200个证券，请按账户或证券缩小范围')
            if record_id and not records:raise HTTPException(404,'本人所选证券不存在')
            await attach_openings(conn,who.id,records)
            ids=[row['id'] for row in records]
            trades=await(await conn.execute('SELECT t.*,'+PENDING_FEE_SQL+' AS actual_fee_pending FROM trade_ledger t WHERE t.owner_id=%s AND t.record_id=ANY(%s::text[]) AND t.account_kind=%s ORDER BY t.record_id,t.before_record_revision LIMIT 5001',(who.id,ids,account_kind))).fetchall()
            if len(trades)>5000:raise HTTPException(409,'完整有效成交超过5000条，请按账户或证券缩小范围')
            await attach_amendments(conn,who.id,trades)
            corrections=await(await conn.execute('SELECT c.* FROM trade_fee_corrections c JOIN trade_ledger t ON t.owner_id=c.owner_id AND t.id=c.trade_id WHERE c.owner_id=%s AND t.record_id=ANY(%s::text[]) ORDER BY c.id LIMIT 5001',(who.id,ids))).fetchall()
            projections=await(await conn.execute('SELECT * FROM trade_fee_projections WHERE owner_id=%s AND record_id=ANY(%s::text[]) ORDER BY record_id,before_record_revision LIMIT 5001',(who.id,ids))).fetchall()
            if len(corrections)>5000 or len(projections)>5000:raise HTTPException(409,'更正原始证据超过完整读取预算')
            grouped=defaultdict(list)
            for trade in trades:grouped[trade['record_id']].append(trade)
            fees={row['trade_id']:row['new_fees'] for row in corrections}
            orders,missing,closes,heads=[],[],{},[]
            public_records=[]
            for record in records:
                rid=record['id'];history=grouped[rid]
                actual_fees={row['id']:fees[row['id']] for row in history if row['id'] in fees and not row['actual_fee_pending']}
                try:projection=effective_projection(history,record,actual_fees,[row for row in projections if row['record_id']==rid]) if history else {}
                except (ValueError,ArithmeticError):
                    projection={};missing.append({'recordId':rid,'domain':'economic_history','state':'unverified_lineage_or_opening'})
                for root in effective_rows(history):
                    event=root.get('_effective_event') or root
                    fee_known=not root['actual_fee_pending']
                    effective_fee=actual_fees.get(root['id'],Decimal(str(event['fees']))) if fee_known else None
                    effective=projection.get(root['id'],{})
                    pnl=effective.get('realized_pnl') if fee_known and root['currency']==root['settlement_currency'] and effective.get('projectionScope')!='pre_transfer_original_registration' else None
                    event_id=event.get('id',root['id'])
                    orders.append(packed({'id':str(event_id),'recordId':rid,'brokerAccountId':root['account_id'],'accountKind':root['account_kind'],
                        'market':record['market'],'code':record['code'],'name':record['name'],'side':event['side'],'status':'filled',
                        'qty':Decimal(str(event['quantity'])),'price':Decimal(str(event['price'])),'amount':Decimal(str(event['amount'])),
                        'fees':effective_fee,'registeredFees':root['fees'],'actualFeeKnown':fee_known,
                        'feeAuthority':'verified_effective_owner_or_source_paid' if fee_known else 'registered_unverified_or_estimated',
                        'currency':root['currency'],'settlementCurrency':root['settlement_currency'],'settlementAmount':event.get('settlement_amount'),
                        'realizedPnl':pnl,'positionQtyBefore':effective.get('before_quantity'),'positionQtyAfter':effective.get('after_quantity'),
                        'tradedAt':event['occurred_at'],'createdAt':root['created_at'],'brokerExecution':False,
                        'lineage':{'rootTradeId':str(root['id']),'cashEntryId':str(root['cash_entry_id']),
                            'amendmentId':str(root['_latest_amendment']['id']) if root.get('_latest_amendment') else None,
                            'positionTransferId':str(record['position_transfer_id']) if record.get('position_transfer_id') else None}}))
                public_records.append(packed({'id':rid,'market':record['market'],'code':record['code'],'name':record['name'],
                    'brokerAccountId':record['broker_account_id'],'accountKind':account_kind,'currentQuantity':record['qty'],
                    'currentQuantityAuthority':'current_registered_record_not_a_historical_opening','revision':record['revision'],'deleted':record['deleted_at'] is not None}))
                # Retain real prices for cleared names with observed fills as well as current holdings.
                if record['deleted_at'] is not None or not history and (record['qty'] is None or record['qty']<=0):continue
                if sum(len(value) for value in closes.values())>=24000:
                    missing.append({'recordId':rid,'domain':'closes','state':'response_point_budget'});continue
                if record['market'] not in ZONES:
                    missing.append({'recordId':rid,'domain':'closes','state':'unsupported_market'});continue
                choices,retained=await self.history.choices(conn,who.id,record['market'],record['code'],frame='day',adjust=adjust,instrument='equity',session='REGULAR',kind='bars',revision=revision)
                if len(choices)!=1:
                    missing.append({'recordId':rid,'domain':'closes','state':'ambiguous_source_or_adjustment' if choices else 'retained_unavailable' if retained else 'missing_observations'});continue
                (source,series),(policy,query)=next(iter(choices.items()))
                head=await(await conn.execute('SELECT max(sequence) AS head,count(*) AS n FROM market_facts WHERE owner_id=%s AND source_revision=%s AND series_fingerprint=%s',(who.id,source,series))).fetchone()
                heads.append((rid,str(source),series,policy.fingerprint,head['head'],head['n']))
                point_limit=min(days,24000-sum(len(value) for value in closes.values()))
                rows=await(await conn.execute('''SELECT * FROM(SELECT DISTINCT ON(source_time) * FROM market_facts WHERE owner_id=%s AND source_revision=%s AND series_fingerprint=%s
                    AND (source_time AT TIME ZONE %s)::date<=%s::date AND (%s::date IS NULL OR (source_time AT TIME ZONE %s)::date<%s::date) ORDER BY source_time DESC,sequence DESC) latest ORDER BY source_time DESC LIMIT %s''',
                    (who.id,source,series,ZONES[record['market']],end.isoformat(),cursor,ZONES[record['market']],cursor,point_limit+1))).fetchall()
                if not rows:
                    missing.append({'recordId':rid,'domain':'closes','state':'missing_observations'});continue
                values=[]
                for fact in reversed(rows[:point_limit]):
                    try:
                        close=Decimal(str(fact['contents']['c']))
                        if not close.is_finite() or close<=0:raise ValueError()
                    except (ValueError,ArithmeticError,KeyError):
                        missing.append({'recordId':rid,'domain':'closes','state':'invalid_observation'});continue
                    values.append({'d':fact['source_time'].astimezone(ZoneInfo(ZONES[record['market']])).date().isoformat(),'c':str(close),
                        'factId':str(fact['id']),'pageId':str(fact['page_id']),'sourceRevision':str(source),'licenseRevision':policy.license_revision,
                        'adjust':query.adjust,'currency':fact['contents'].get('currency'),'marketTimezone':ZONES[record['market']]})
                closes[rid]=values
            from .database_migration_history import registered_orders
            imported_history=[row for row in await registered_orders(conn,who.id) if row['recordId'] in ids and row['accountKind']==account_kind and row['status']=='filled']
            orders.extend(packed(imported_history))
            orders.sort(key=lambda row:(row['tradedAt'] or '',row['createdAt'] or '',row['id']),reverse=True)
            token=hashed({'accountKind':account_kind,'account':broker_account_id,'record':record_id,'days':days,'source':str(revision),
                'adjust':adjust,'start':begin.isoformat(),'through':end.isoformat(),'records':records,'trades':trades,'fees':corrections,'projections':projections,'heads':heads,'registeredHistory':imported_history})
            if expected_revision is not None and expected_revision!=token:raise HTTPException(409,'金融或行情证据版本已变化，请重新读取第一页')
            coverage={'partial':bool(missing),'missing':missing,'historyCoverageKnown':False,'basis':'stored_observations_only_no_calendar_fill',
                'cashFxHistoricalCoverageKnown':False,'unassignedExcluded':True,'excludedUnknownKindAccounts':sum(row['account_kind'] not in ('real','simulated') for row in accounts),'accountKindsSeparated':True}
            analysis=period_analysis(orders,closes,coverage,begin.isoformat(),end.isoformat())
            return {'days':days,'asOf':datetime.now(UTC).isoformat(),'revision':token,'accountKind':account_kind,'records':public_records,
                'closes':closes,'orders':orders[order_offset:order_offset+order_limit],'periodAnalysis':analysis,'coverage':coverage,
                'pagination':{'orders':{'offset':order_offset,'limit':order_limit,'total':len(orders),'nextOffset':order_offset+order_limit if order_offset+order_limit<len(orders) else None},
                    'closes':{'before':cursor,'nextBefore':max((min(row['d'] for row in values) for values in closes.values() if values),default=None),'maxPoints':24000}},
                'financialWrites':False,'sourceCollection':False,'completeDailyAssetHistory':False}
