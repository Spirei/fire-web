"""Explicit target resolution, checked zero-opening creation; never estimated actual quantities."""

from hashlib import sha256

from fastapi import HTTPException

from .broker_accounts import broker_account
from .fee_repairs import hashed
from .portfolio_records import PortfolioRecords, normalize, symbol


async def resolve(conn, who, raw):
    if (not isinstance(raw,dict) or set(raw)-{'brokerAccountId','brokerRevision','market','code','name','accountMarket'}
            or not {'brokerAccountId','brokerRevision','market','code','name'}<=set(raw)
            or type(raw['brokerRevision']) is not int or raw['brokerRevision']<1
            or not isinstance(raw['name'],str) or not 1<=len(raw['name'].strip())<=100
            or raw['market'] not in ('US','HK','CN','JP','KR','SG','UK')):
        raise HTTPException(400,'买入账户目标无效')
    account=await broker_account(conn,who.id,raw['brokerAccountId'])
    if account['revision']!=raw['brokerRevision'] or account['holding_source']!='manual' or account['account_kind'] not in ('real','simulated'):
        raise HTTPException(409,'买入账户版本、身份或来源需重新核对')
    code=symbol(raw['code'],raw['market'])
    account_market='CN' if raw['market']=='HK' and raw.get('accountMarket')=='CN' else ''
    if raw.get('accountMarket','') not in ('',raw['market'],account_market):
        raise HTTPException(400,'目标账户市场无效')
    rows=await (await conn.execute('''SELECT * FROM portfolio_records WHERE owner_id=%s AND broker_account_id=%s AND market=%s
        AND code=%s AND account_market=%s AND deleted_at IS NULL ORDER BY id LIMIT 2 FOR UPDATE''',
        (who.id,account['id'],raw['market'],code,account_market))).fetchall()
    if len(rows)>1:
        raise HTTPException(409,'同账户重复证券，须先核对')
    record=rows[0] if rows else None
    target={**raw,'code':code,'name':record['name'] if record else raw['name'].strip(),'accountMarket':account_market,
            'brokerName':account['name'],'recordId':record['id'] if record else None,
            'recordRevision':record['revision'] if record else None,'createsRecord':record is None,
            'accountKind':account['account_kind']}
    target['targetRevision']=hashed(target)
    return account,record,target


async def create_empty(conn, who, account, target):
    records=PortfolioRecords(None)
    data=normalize({'name':target['name'],'code':target['code'],'market':target['market'],'accountMarket':target['accountMarket'],
                    'price':None,'cost':'0','qty':'0','group':account['name'],'brokerAccountId':account['id'],
                    'watchGroupId':'','note':'','source':'manual'})
    await records.check(conn,who.id,'create',None,data)
    key='bt-'+sha256((who.id+'|'+account['id']+'|'+target['market']+'|'+target['code']+'|'+target['accountMarket']).encode()).hexdigest()[:32]
    if await (await conn.execute('SELECT 1 FROM portfolio_records WHERE owner_id=%s AND id=%s',(who.id,key))).fetchone():
        raise HTTPException(409,'原目标记录仍保留历史，不能重新创建同身份')
    return await (await conn.execute('''INSERT INTO portfolio_records(owner_id,id,name,code,market,account_market,price,cost,qty,group_name,
        broker_account_id,watch_group_id,note,source,history_state) VALUES(%s,%s,%s,%s,%s,%s,NULL,0,0,%s,%s,NULL,'','manual','empty') RETURNING *''',
        (who.id,key,data['name'],data['code'],data['market'],data['accountMarket'],data['group'],account['id']))).fetchone()
