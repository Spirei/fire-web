"""Existing asset DTO projection from PG records, licensed quotes, FX and cash books."""

from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal, localcontext
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from .actual_projection import actual_record_dto, confirmed_actual_fees
from .broker_metadata import fingerprint
from .cash_overview import CashOverview
from .fee_repair_model import replay
from .fx_reference import FxWorker
from .legacy_broker_read import iso
from .market_quote_reads import BatchQuotes
from .position_transfer_checkpoint import economic_initial
from .trade_accounting import replay_economic_trades
from .trade_amendment_history import attach_amendments, effective_rows

CURRENCIES={'US':'USD','HK':'HKD','CN':'CNY','JP':'JPY','KR':'KRW','SG':'SGD','UK':'GBP','DE':'EUR','FR':'EUR','AU':'AUD','CA':'CAD','IN':'INR','BR':'BRL','TW':'TWD'}
ZONES={'US':'America/New_York','HK':'Asia/Hong_Kong','CN':'Asia/Shanghai','JP':'Asia/Tokyo','KR':'Asia/Seoul','SG':'Asia/Singapore','UK':'Europe/London','DE':'Europe/Berlin','FR':'Europe/Paris','AU':'Australia/Sydney','CA':'America/Toronto','IN':'Asia/Kolkata','BR':'America/Sao_Paulo','TW':'Asia/Taipei'}


def decimal(value):
    if value is None or isinstance(value,bool):return None
    try:
        result=Decimal(str(value))
        return result if result.is_finite() else None
    except (ValueError,ArithmeticError):return None


def display(value,places=None):
    if value is None:return None
    if places is not None:value=value.quantize(Decimal(1).scaleb(-places),rounding=ROUND_HALF_UP)
    return float(value)


def convert(value,source,target,rates):
    if value is None or source is None:return None
    if source==target:return value
    before,after=decimal(rates.get(source)),decimal(rates.get(target))
    return value/before*after if before is not None and after is not None and before>0 and after>0 else None


def complete_sum(values):
    return None if any(value is None for value in values) else sum(values,Decimal(0))


async def averages(conn,owner,records,actual):
    ids=[record['id'] for record in records]
    if not ids:return {},{}
    rows=await (await conn.execute('SELECT * FROM trade_ledger WHERE owner_id=%s AND record_id=ANY(%s) ORDER BY record_id,before_record_revision LIMIT 10001',(owner,ids))).fetchall()
    if len(rows)>10000:raise HTTPException(409,'完整成交成本超过读取上限')
    await attach_amendments(conn,owner,rows)
    paid=await confirmed_actual_fees(conn,owner,[row['id'] for row in rows])
    fees={row['trade_id']:row['actual_fee'] for row in paid}
    projections=await (await conn.execute('SELECT * FROM trade_fee_projections WHERE owner_id=%s AND record_id=ANY(%s)',(owner,ids))).fetchall()
    grouped={key:[] for key in ids}
    for row in rows:grouped[row['record_id']].append(row)
    result,cleared={},{}
    for record in records:
        rid=record['id'];history=grouped[rid]
        if not history or actual[rid]['cost'] is None or actual[rid].get('officialObservation'):
            continue
        try:
            initial,events=replay(history,record,fees,[row for row in projections if row['record_id']==rid])
            economics=replay_economic_trades(economic_initial(record,initial),events)
            active=effective_rows(history)
            latest={**active[-1],**active[-1].get('_effective_event',{})} if active else None
            if latest and latest['side']=='sell' and economics.position.quantity==0 and decimal(actual[rid]['qty'])==0:
                at=latest['occurred_at']
                cleared[rid]=datetime.fromisoformat(at) if isinstance(at,str) else at
            if economics.complete and economics.position.quantity==decimal(actual[rid]['qty']) and economics.position.quantity>0:
                result[rid]=economics.position.cost
        except ValueError:
            continue
    return result,cleared


async def snapshot(service,who,options):
    selected={'currency':options.get('currency','USD'),'costMethod':options.get('costMethod','diluted'),'usPrice':options.get('usPrice','observed')}
    if (not isinstance(selected['currency'],str) or len(selected['currency'])!=3 or not selected['currency'].isascii() or not selected['currency'].isupper()
            or selected['costMethod'] not in ('diluted','average_open') or selected['usPrice'] not in ('observed','regular')):
        raise HTTPException(400,'资产显示参数无效')
    async with service.context(who) as conn:
        original=await (await conn.execute('SELECT id,market,code,revision FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 10001',(who.id,))).fetchall()
        if len(original)>10000:raise HTTPException(409,'持仓超过完整读取上限')
    quoted=await BatchQuotes(service.market_authority).read(who,[{'id':row['id'],'market':row['market'],'code':row['code']} for row in original])
    fx=await FxWorker(service.db).snapshot(exact=True)
    async with service.context(who) as conn:
        rows=await (await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL ORDER BY id LIMIT 10001',(who.id,))).fetchall()
        if [(row['id'],row['market'],row['code'],row['revision']) for row in rows]!=[(row['id'],row['market'],row['code'],row['revision']) for row in original]:
            raise HTTPException(409,'持仓在读取报价期间已变化，请重新读取')
        for state in quoted['quoteStates'].values():
            if state.get('sourceRevision'):
                _,policy=await service.market_authority.config(conn,who.id,state['sourceRevision'])
                if policy.license_revision!=state['licenseRevision']:raise HTTPException(403,'报价来源许可已变化')
        actual={row['id']:await actual_record_dto(conn,who.id,row) for row in rows}
        average,cleared=await averages(conn,who.id,rows,actual)
        overview=await CashOverview(service.db).on_connection(conn,who)
        head=await (await conn.execute('SELECT revision FROM portfolio_record_collections WHERE owner_id=%s',(who.id,))).fetchone()
        accounts=await (await conn.execute('SELECT id,account_kind,holding_source FROM broker_accounts WHERE owner_id=%s AND deleted_at IS NULL',(who.id,))).fetchall()
        accounts={row['id']:row for row in accounts}
        now=(await (await conn.execute('SELECT clock_timestamp() AS at')).fetchone())['at']
        values=[];money={};kinds=set()
        with localcontext() as context:
            context.prec=80
            for row in rows:
                rid=row['id'];record=actual[rid];declaration,stored=await service.declaration(conn,who.id,row)
                basis='legacy_record_unit' if stored is None else 'owner_declared_unit' if declaration['identityMatches'] and declaration['kind']!='unknown' else 'unavailable'
                known=basis!='unavailable';qty=decimal(record['qty']);diluted=decimal(record['cost'])
                quote=quoted['quotes'].get(rid);state=quoted['quoteStates'].get(rid,{})
                valid_quote=quote and (row['market']!='US' or selected['usPrice']=='observed' or quote.get('session')=='REGULAR')
                price=decimal(state.get('priceExact')) if valid_quote else None
                source='quote' if price is not None else 'unavailable';price_at=state.get('sourceTime') if price is not None else None
                if price is None and (row['market']!='US' or selected['usPrice']=='observed'):
                    price=decimal(record['price'])
                    if price is not None:
                        source='record';price_at=(record.get('officialObservation') or {}).get('reportDate') or record['updatedAt']
                currency=CURRENCIES.get(row['market']);account=accounts.get(row['broker_account_id'])
                kind=account['account_kind'] if account else 'unknown'
                if qty is None or qty!=0:kinds.add(kind)
                cost=(diluted if selected['costMethod']=='diluted' else average.get(rid)) if known else None
                native_market=Decimal(0) if qty==0 else qty*price if known and qty is not None and qty>0 and price is not None and price>=0 else None
                native_cost=Decimal(0) if qty==0 else qty*cost if known and qty is not None and qty>0 and cost is not None else None
                native_pnl=native_market-native_cost if native_market is not None and native_cost is not None else None
                market_value=convert(native_market,currency,selected['currency'],fx['rates'])
                cost_value=convert(native_cost,currency,selected['currency'],fx['rates'])
                pnl_value=convert(native_pnl,currency,selected['currency'],fx['rates'])
                money[rid]=(market_value,cost_value,pnl_value,native_market,native_cost,native_pnl)
                reason=None if market_value is not None else 'instrument_unclassified' if not known else 'unsupported_position_quantity' if qty is None or qty<0 else 'missing_price' if price is None else 'missing_exchange_rate'
                market=row['account_market'] or row['market'];closed=cleared.get(rid)
                closed_today=bool(closed and row['market'] in ZONES and closed.astimezone(ZoneInfo(ZONES[row['market']])).date()==now.astimezone(ZoneInfo(ZONES[row['market']])).date())
                values.append({'recordId':rid,'recordRevision':row['revision'],'name':row['name'],'code':row['code'],'market':row['market'],
                    'accountMarket':market,'accountCurrency':CURRENCIES.get(market,'UNKNOWN'),'channel':'stock_connect' if row['market']=='HK' and market=='CN' else 'direct',
                    'broker':row['group_name'],'brokerAccountId':row['broker_account_id'],'accountKind':kind,'currency':currency,'instrument':declaration,
                    'valuationBasis':basis,'valuationUnitMultiplier':1 if known else None,'qty':display(qty),'price':display(price),'priceSource':source,'priceAt':price_at,
                    'priceAuthority':'licensed_quote_observation' if source=='quote' else 'official_reported_mark_price' if source=='record' and record.get('officialObservation') else 'owner_saved_record_mark' if source=='record' else 'unavailable',
                    'positionAsOf':(record.get('officialObservation') or {}).get('reportDate'),'officialObservation':record.get('officialObservation'),
                    'quoteSession':quote.get('session') if source=='quote' else None,'quoteSource':quote.get('source') if source=='quote' else None,'quoteCached':bool(quote.get('cached')) if source=='quote' else False,
                    'cost':display(cost),'dilutedCost':display(diluted) if known else None,'averageOpenCost':display(average.get(rid)) if known else None,
                    'costMethod':selected['costMethod'],'averageCostComplete':known and rid in average,'costUnavailableReason':None if cost is not None else 'instrument_unclassified' if not known else 'missing_verified_economic_opening' if selected['costMethod']=='average_open' else 'missing_actual_cost',
                    'cycleStartedAt':None,'nativeMarketValue':display(native_market,2),'nativeCostValue':display(native_cost,2),'nativeHoldingPnl':display(native_pnl,2),
                    'valuationCurrency':selected['currency'],'marketValue':display(market_value,2),'costValue':display(cost_value,2),'holdingPnl':display(pnl_value,2),
                    'holdingPnlPct':display(native_pnl/abs(native_cost)*100,2) if native_pnl is not None and native_cost not in (None,0) else None,
                    'dayPnl':None,'dayPnlPct':None,'dayPnlUnavailableReason':'missing_verified_day_opening_position_and_cashflows',
                    'weightPct':None,'clearedAt':iso(closed) if closed else None,'clearedToday':closed_today,'active':qty is None or qty!=0,
                    'valuationComplete':market_value is not None,'valuationUnavailableReason':reason,'rawRecord':record})
            active=[row for row in values if row['active']]
            scoped_books=[book for book in overview['books'] if book['currencies']]
            kinds.update(book['accountKind'] for book in scoped_books)
            separated=len(kinds)>1 or 'unknown' in kinds
            total_market=None if separated else complete_sum([money[row['recordId']][0] for row in active])
            total_cost=None if separated else complete_sum([money[row['recordId']][1] for row in active])
            cash_rows=scoped_books[0]['currencies'] if len(scoped_books)==1 and not separated else []
            cash_complete=bool(cash_rows) and all(row['complete'] and row['ownerBalance'] is not None for row in cash_rows)
            cash_values={row['currency']:decimal(row['ownerBalance']) for row in cash_rows}
            cash_total=complete_sum([convert(amount,currency,selected['currency'],fx['rates']) for currency,amount in cash_values.items()]) if cash_complete else None
            if cash_total is None:cash_complete=False
            asset_total=total_market+cash_total if total_market is not None and cash_total is not None else None
            for row in active:
                row['weightPct']=display(money[row['recordId']][0]/total_market*100,2) if total_market is not None and total_market>0 and money[row['recordId']][0] is not None else None
            markets=[]
            for market in sorted({row['market'] for row in values}):
                group=[row for row in active if row['market']==market]
                totals=[None if separated else complete_sum([money[row['recordId']][index] for row in group]) for index in (0,2,3,5)]
                markets.append({'market':market,'currency':CURRENCIES.get(market),'valuationCurrency':selected['currency'],
                    'nativeMarketValue':display(totals[2],2),'nativeHoldingPnl':display(totals[3],2),'positionCount':len(group),
                    'marketValue':display(totals[0],2),'holdingPnl':display(totals[1],2),
                    'date':now.astimezone(ZoneInfo(ZONES[market])).date().isoformat() if market in ZONES else None,'timeZone':ZONES.get(market),
                    'cash':None,'cashUnavailableReason':'currency_balances_not_allocated_to_markets','dayPnl':None,'sessionStatus':'unknown'})
        result={'accountId':who.id,'collectionRevision':head['revision'] if head else 0,'currency':selected['currency'],'options':selected,
            'positions':values,'markets':markets,'summary':{'totalMarket':display(total_market,2),'totalCost':display(total_cost,2),
                'holdingPnl':display(total_market-total_cost,2) if total_market is not None and total_cost is not None else None,
                'totalCash':display(cash_total,2),'totalAsset':display(asset_total,2),'holdingsComplete':total_market is not None,'costComplete':total_cost is not None,
                'cashComplete':cash_complete,'totalAssetComplete':asset_total is not None,'dayPnl':None,'dayPnlPct':None,'dayPnlUnavailableReason':'missing_verified_account_day_opening_nav',
                'unconvertedCurrencies':sorted({row['currency'] or 'UNKNOWN:'+row['market'] for row in active if money[row['recordId']][0] is None})},
            'cash':{'nativeBalancesByCurrency':{key:display(value) for key,value in cash_values.items()} if cash_complete else None,
                    'sourceComplete':cash_complete,'complete':cash_complete,'source':'platform_owner_kind_posted_cash_ledger','marketAllocationAvailable':False},
            'migration':{'coverageScope':'platform_owned_records_quotes_fx_cash_books','accountKindsSeparated':separated,'cashBooks':overview['books'],
                         'quoteStates':quoted['quoteStates'],'fxObservation':{key:value for key,value in fx.items() if key!='rates'},
                         'historicalCoverageKnown':False,'realTimePricesAssumed':False,'financialWrites':False}}
        result['snapshotRevision']=fingerprint(result)
        result['asOf']=iso(now)
        return result
