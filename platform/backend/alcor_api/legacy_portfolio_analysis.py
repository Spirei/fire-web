"""Legacy overview and evidence bundles over shared read authorities."""

import hashlib
import json
import math
from datetime import UTC, datetime
from decimal import Decimal, localcontext

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .legacy_portfolio import portfolio_member
from .legacy_optional_credentials import credentials_present
from .legacy_trading_snapshot import snapshot_in_transaction
from .market_worker import Bound
from .portfolio_overview import PortfolioOverview
from .portfolio_series import PortfolioSeries


def numeric(value):
    return None if value is None else float(value)


def single_book(result):
    books=[book for book in result['books'] if book['positions'] or book['accounts']]
    if len(books)>1:
        raise HTTPException(409,'真实与模拟账户必须分别读取，不合并旧总览')
    return books[0] if books else None


def overview_dto(result):
    book=single_book(result)
    positions=book['positions'] if book else []
    totals=book['totals'] if book else {}
    grouped={}
    with localcontext() as precision:
        precision.prec=160
        for position in positions:
            market=position['accountMarket']
            group=grouped.setdefault(market,{'count':0,'cost':Decimal(0),'market':Decimal(0),'pnl':Decimal(0),'currency':result['currency']})
            group['count']+=1
            converted=position['converted']
            for key,source in (('cost','cost'),('market','marketValue'),('pnl','unrealizedPnl')):
                value=converted[source]
                group[key]=None if value is None or group[key] is None else group[key]+Decimal(value)
    for group in grouped.values():
        for key in ('cost','market','pnl'):group[key]=numeric(group[key])
    unassigned=result['unassigned']['positions']
    missing=[p['recordId'] for p in positions if p['converted']['marketValue'] is None]
    complete=bool(book and book['completeness']['valuation'] and not unassigned)
    cash_complete=bool(book and book['completeness']['cash'])
    return {'count':len(positions),'currency':result['currency'],'complete':complete,
            'unconverted':sorted(set(missing+[p['recordId'] for p in unassigned])),
            'totalCost':numeric(totals.get('cost')),'totalMarket':numeric(totals.get('marketValue')),
            'totalPnl':numeric(totals.get('unrealizedPnl')),'totalPnlPct':numeric(totals.get('unrealizedPnlPct')),
            'totalCash':numeric(totals.get('cash')),'totalAsset':numeric(totals.get('totalAsset')),
            'cashSource':'recorded_cash_ledger','cashSourceComplete':cash_complete,
            'cashComplete':cash_complete,'totalAssetComplete':complete and cash_complete and totals.get('totalAsset') is not None,
            'unconvertedCurrencies':sorted({p['currency'] for p in positions if p['recordId'] in missing and p['currency']}),
            'byMarket':grouped,'valuation':[{'id':p['recordId'],'source':p['priceSource'],'at':p['priceAt']} for p in positions],
            'quoteStatus':{'pending':False,'cached':[p['recordId'] for p in positions if p['quoteCached'] is True],
                           'missing':result['quoteStatus']['missing']},
            'migration':{'revision':result['revision'],'accountKind':book['accountKind'] if book else None,
                         'fullWealthComplete':False,'unassignedExcluded':len(unassigned),'unknownValuesRemainNull':True,'collectionOnRead':False}}


def legacy_days(raw):
    try:value=float(raw) if raw is not None and raw.strip() else 0
    except ValueError:value=0
    if math.isnan(value) or value==0:value=330
    return int(min(1200,max(60,value)))


def mount_legacy_portfolio_analysis(app,db,authority):
    async def dispatch(request,*,series=False):
        headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'}
        try:
            credentials_present(request)
            who=await portfolio_member(request,db.settings,db)
            if not await app.state.read_rate_limit(db,'legacy-portfolio-analysis:'+who.id,40,window_seconds=60):
                raise HTTPException(429,'请求过于频繁')
            if not series:
                currency=request.query_params.get('currency','USD').upper()
                result=await PortfolioOverview(db,authority).read(who,currency=currency)
                return JSONResponse({'code':0,'message':'ok','data':overview_dto(result)},headers=headers)
            days=legacy_days(request.query_params.get('days'))
            async with db.connection() as conn,conn.transaction():
                await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
                bound=Bound(conn,db.settings)
                # Both material views use one snapshot; neither registers collection.
                result=await PortfolioSeries(bound,authority,automatic=True).read(who,days=days,adjust="none",order_limit=5000,_snapshot_started=True)
                _,snapshot=await snapshot_in_transaction(conn,who,strict=False)
                pending=await (await conn.execute("SELECT 1 FROM tasks WHERE owner_id=%s AND kind='market.history' AND status IN ('queued','running') LIMIT 1",(who.id,))).fetchone()
            allowed={row['id'] for row in result['records']}
            closes={rid:[{'d':point['d'],'c':numeric(point['c'])} for point in points] for rid,points in result['closes'].items()}
            orders=[row for row in snapshot['orders'] if row['recordId'] in allowed]
            output={'closes':closes,'orders':orders,'days':days,'pending':bool(pending),'at':int(datetime.now(UTC).timestamp()*1000),
                    'migration':{'revision':result['revision'],'coverage':result['coverage'],'periodAnalysis':result['periodAnalysis'],
                                 'materialBundleNotHistoricalAssetCurve':True,'pagination':result['pagination']}}
            encoded=json.dumps({'revision':result['revision'],'closes':closes,'orders':orders},sort_keys=True,separators=(',',':'),ensure_ascii=False)
            etag='W/"ps-'+hashlib.sha256(encoded.encode()).hexdigest()[:24]+'"'
            headers.update({'ETag':etag,'Cache-Control':'private, max-age=30, must-revalidate'})
            if request.headers.get('if-none-match')==etag:return Response(status_code=304,headers=headers)
            return JSONResponse(output,headers=headers)
        except HTTPException as exc:
            headers.update(exc.headers or {})
            if exc.status_code in (401,403):headers['X-Alcor-Retire-Context']='true'
            return JSONResponse({'code':getattr(exc,'business_code',exc.status_code*100+1),'message':str(exc.detail),'data':None},status_code=exc.status_code,headers=headers)

    @app.get('/api/v1/overview')
    async def overview_v1(request:Request):return await dispatch(request)

    @app.get('/api/v2/overview')
    async def overview_v2(request:Request):return await dispatch(request)

    @app.post('/api/v1/portfolio-series/prepare')
    @app.post('/api/v2/portfolio-series/prepare')
    async def prepare_series(request:Request):
        from .legacy_identity import body,native_identity
        from .market_history_demands import prepare
        from .security import lock_mutation_identity
        from uuid import UUID
        who=await portfolio_member(request,db.settings,db)
        if getattr(who,'native_client',False):who,_=await native_identity(request,db,'portfolio.write')
        raw=await body(request,('requestId','days'))
        if set(raw)!={'requestId','days'}:raise HTTPException(400,'组合历史需求字段无效')
        try:rid=UUID(str(raw['requestId']))
        except (ValueError,TypeError):raise HTTPException(400,'请求编号无效') from None
        if type(raw['days']) is not int or not 1<=raw['days']<=1200:raise HTTPException(400,'组合历史期间无效')
        async with db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who,require_admin=False)
            records=await (await conn.execute("SELECT DISTINCT market,code FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NULL AND qty>0 AND market IN ('US','HK','CN','JP','KR','SG') ORDER BY market,code LIMIT 101",(who.id,))).fetchall()
        if len(records)>100:raise HTTPException(409,'组合历史证券超过单次范围')
        if not records:return JSONResponse({'code':0,'message':'ok','data':{'requestId':str(rid),'state':'empty'}},headers={'Cache-Control':'private, no-store'})
        result=await prepare(authority,who,rid,[dict(r) for r in records],raw['days'])
        return JSONResponse({'code':0,'message':'ok','data':result},headers={'Cache-Control':'private, no-store'})

    @app.get('/api/v1/portfolio-series')
    async def series_v1(request:Request):return await dispatch(request,series=True)
