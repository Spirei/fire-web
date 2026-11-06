"""Legacy dividend schedules project owner announcements and actual receipt evidence only."""

import math
from decimal import Decimal

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .dividend_chain import DividendChain, announcement_view
from .dividend_schedule_evidence import verify_schedule_original
from .legacy_history_bars import history_member
from .legacy_identity import assert_native_origin
from .market_contract import code
from .security import lock_mutation_identity

HEADERS = {'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'}


def mount_dividend_schedule(app, authority, rate_limit):
    db = authority.db
    chain = DividendChain(db)

    async def read(request:Request):
        legacy = request.url.path.startswith('/api/v1/')
        try:
            assert_native_origin(request,db.settings)
            ip = request.client.host if request.client else 'unknown'
            if not await rate_limit(db,'dividends:'+ip,60,window_seconds=60) or not await rate_limit(db,'dividends',300,window_seconds=60):
                raise HTTPException(429,'请求过于频繁，请稍后再试')
            params = request.query_params
            if set(params)-{'market','code','recordId','limit','before'} or any(len(params.getlist(key))!=1 for key in params):
                raise ValueError('query')
            market = params.get('market','').strip().upper()
            if market not in ('US','HK','CN'):
                raise HTTPException(400,'暂不支持该市场')
            symbol = code(market,params.get('code',''))
            limit = int(params.get('limit','100'))
            before = int(params['before']) if 'before' in params else None
            record_id = params.get('recordId','').strip()
            if not 1<=limit<=100 or before is not None and before<1 or len(record_id)>100:
                raise ValueError('pagination')
            who = await history_member(request,db,1 if legacy else None)
            async with db.connection() as conn,conn.transaction():
                await conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
                await lock_mutation_identity(conn,who,require_admin=False)
                await authority.authorize_read(conn,who)
                if record_id:
                    exists = await (await conn.execute('SELECT 1 FROM portfolio_records WHERE owner_id=%s AND id=%s AND market=%s AND code=%s AND deleted_at IS NULL',
                                                       (who.id,record_id,market,symbol))).fetchone()
                    if not exists:
                        raise HTTPException(404,'本人证券记录不存在')
                rows = await (await conn.execute('''SELECT * FROM (SELECT DISTINCT ON(source,source_event_id) * FROM dividend_announcement_revisions
                    WHERE owner_id=%s AND market=%s AND code=%s ORDER BY source,source_event_id,version DESC) latest
                    WHERE (%s::bigint IS NULL OR sequence<%s) ORDER BY sequence DESC LIMIT %s''',(who.id,market,symbol,before,before,limit+1))).fetchall()
                more,rows = len(rows)>limit,rows[:limit]
                dividends,holding = [],[]
                for row in rows:
                    await verify_schedule_original(conn,row)
                    evidence = announcement_view(row)
                    value = {**row['normalized'],'revision':str(row['revision']),'source':row['source'],
                             'sourceEventId':row['source_event_id'],'sourceRevision':row['source_revision'],
                             'rawSha256':row['raw_sha256'],'capturedAt':row['captured_at'].isoformat(),
                             'cashReceipt':False,'evidence':evidence}
                    if legacy and value.get('amount') is not None:
                        exact = value['amount']
                        numeric = float(Decimal(exact))
                        value.update(amountText=exact,amount=numeric if math.isfinite(numeric) and (numeric!=0 or Decimal(exact)==0) else None)
                    dividends.append(value)
                    if record_id:
                        entitlement = await chain._entitlement(conn,who,record_id,row['revision'],None)
                        linked = entitlement['actualReceipts']
                        holding.append({'exDate':value.get('exDate'),'payDate':value.get('payDate'),
                                        'heldQty':entitlement['quantity'],'booked':True if linked else None,
                                        'phase':'booked' if linked else 'info','expectation':entitlement})
                sources = list(dict.fromkeys(row['source'] for row in rows))
                value = {'market':market,'code':symbol,'source':sources[0] if len(sources)==1 else 'mixed' if sources else 'unknown','sources':sources,
                         'cached':True,'stale':True if legacy else None,'stalenessVerified':False,'dividends':dividends,
                         'holding':{'firstBuyDate':None,'rows':holding,'historyCompletenessVerified':False} if record_id else None,
                         'nextCursor':rows[-1]['sequence'] if more else None,'coverage':{'complete':False,'partial':more},
                         'automaticCollection':False,'automaticEstimatedSettlement':False}
            return JSONResponse({'code':0,'message':'ok','data':value} if legacy else value,headers=HEADERS)
        except (ValueError,TypeError,OverflowError):
            status,message,headers = 400,'股票代码或分页参数无效',dict(HEADERS)
        except HTTPException as exc:
            status,message,headers = exc.status_code,str(exc.detail),{**HEADERS,**(exc.headers or {})}
        if status in (401,403):
            headers['X-Alcor-Retire-Context']='true'
        return JSONResponse({'error':{'code':status*100+1,'message':message}},status_code=status,headers=headers)

    app.add_api_route('/api/market/dividend-schedule',read,methods=['GET'])
    app.add_api_route('/api/v1/dividends',read,methods=['GET'])
