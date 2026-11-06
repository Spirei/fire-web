"""Resolve an uncertain native financing commit once, then preserve its original UUID."""
from fastapi import HTTPException
from psycopg.types.json import Jsonb


async def submit(service,who,raw,preview):
    data=service.normalize_command(raw);fingerprint=service.command_fingerprint(data)
    try:
        return await service._submit_ledger(who,raw,preview)
    except Exception as error:
        if isinstance(error,HTTPException) and error.status_code in (401,403):raise
        async with service.db.connection() as conn,conn.transaction():
            await service.lock(conn,who)
            prior=await(await conn.execute('SELECT fingerprint,result FROM trade_operations WHERE owner_id=%s AND request_id=%s',(who.id,data['requestId']))).fetchone()
            if prior:
                if prior['fingerprint']!=fingerprint:raise HTTPException(409,'原UUID已用于其他操作') from None
                return prior['result']
            if await(await conn.execute('SELECT 1 FROM cash_ledger_entries WHERE owner_id=%s AND request_id=%s',(who.id,data['requestId']))).fetchone():raise HTTPException(409,'原UUID已用于其他现金操作') from None
            status=error.status_code if isinstance(error,HTTPException) else 503
            result={'requestId':data['requestId'],'kind':'financed_recorded_trade','state':'failed','status':status,'code':40902 if status==409 else status*100+1,'message':str(error.detail) if isinstance(error,HTTPException) else '融资登记未完成，请只读查询原UUID回执','data':None}
            await conn.execute('INSERT INTO trade_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,data['requestId'],fingerprint,Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'trading.financing_failed',%s,%s)",(who.id,data['requestId'],data['requestId']))
            return result


async def submit_cash(service,who,raw,preview):
    from .cash_ledger import fingerprint as cash_fingerprint
    from .cash_ledger import normalize
    data=normalize(raw);fingerprint=cash_fingerprint(data)
    try:
        return await service._submit_ledger(who,raw,preview)
    except Exception as error:
        if isinstance(error,HTTPException) and error.status_code in (401,403):raise
        async with service.db.connection() as conn,conn.transaction():
            await service.lock(conn,who)
            prior=await(await conn.execute('SELECT fingerprint,result FROM cash_ledger_operations WHERE owner_id=%s AND request_id=%s',(who.id,data['requestId']))).fetchone()
            if prior:
                if prior['fingerprint']!=fingerprint:raise HTTPException(409,'原UUID已用于其他现金操作') from None
                return prior['result']
            if await(await conn.execute('SELECT 1 FROM cash_ledger_entries WHERE owner_id=%s AND request_id=%s UNION ALL SELECT 1 FROM trade_operations WHERE owner_id=%s AND request_id=%s',(who.id,data['requestId'],who.id,data['requestId']))).fetchone():raise HTTPException(409,'原UUID已用于其他现金或成交操作') from None
            status=error.status_code if isinstance(error,HTTPException) else 503
            result={'requestId':data['requestId'],'kind':'cash_reconcile','state':'failed','status':status,'code':40902 if status==409 else status*100+1,'message':str(error.detail) if isinstance(error,HTTPException) else '负余额修正未完成，请只读查询原UUID回执','data':None}
            await conn.execute('INSERT INTO cash_ledger_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(who.id,data['requestId'],fingerprint,Jsonb(result)))
            await conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'cash.financing_failed',%s,%s)",(who.id,data['requestId'],data['requestId']))
            return result
