"""Explicit flat direction corrections replay the one immutable ledger, never a broker."""
from decimal import Decimal
from uuid import uuid4

import pytest
from test_trading import setup
from test_legacy_trade_corrections import native_headers


@pytest.mark.parametrize('net',[False,True])
async def test_flat_direction_replays_cost_cash_and_preserves_original(client,admin,db,net):
    account,record=await setup(client,**({'market':'HK','account_market':'CN','code':'00700','currency':'CNY'} if net else {}))
    headers={**await native_headers(db,admin),'x-alcor-trading-context':'nullable-v1'}
    prefix='/api/v2/orders'
    async def buy(qty,date,settlement):
        body={'requestId':str(uuid4()),'recordId':record['id'],'side':'buy','mode':'record','qty':qty,'price':'10','fees':'1',
              'tradedAt':date,'tif':'gtc','session':'REGULAR',**({'settlementAmount':settlement} if net else {})}
        response=await client.post(prefix,headers=headers,json=body)
        assert response.status_code==200,response.text
        return body,response.json()['data']['order']
    _,first=await buy('5','2026-09-01T12:00:00Z','51')
    body,wrong=await buy('2','2026-09-02T12:00:00Z','19')
    snap=(await client.get('/api/v2/account-assets/trading',headers=headers,params={'recordId':record['id']})).json()['data']
    current=next(row for row in snap['orders']if row['id']==wrong['id'])
    correction={'requestId':str(uuid4()),'accountId':admin,'snapshotRevision':snap['snapshotRevision'],'recordId':record['id'],
                'recordRevision':current['recordRevision'],'action':'amend','orders':[{'id':wrong['id'],'revision':current['revision']}],
                'replacement':{'qty':2,'price':12,'fees':1,'tradedAt':current['tradedAt'],'side':'sell'}}
    # Default F11 does not acquire the private flat adapter's new side field.
    denied=await client.post('/api/v2/account-assets/trading/corrections/preview',headers=headers,json=correction)
    assert denied.status_code==400,denied.text
    edit={**body,'requestId':str(uuid4()),'side':'sell','price':'12',**({'settlementAmount':'31'} if net else {})}
    changed=await client.put(prefix+'/'+wrong['id'],headers=headers,json=edit)
    assert changed.status_code==200,changed.text
    assert (await client.put(prefix+'/'+wrong['id'],headers=headers,json=edit)).json()==changed.json()
    replacement=changed.json()['data']['order']
    assert replacement['side']=='sell' and replacement['positionQtyAfter']==3
    history=await client.get('/api/trading/fills',params={'recordId':record['id']})
    assert history.status_code==200,history.text
    projected=next(row for row in history.json()['items'] if row['id']==wrong['id'])
    assert projected['side']=='sell' and projected['originalSide']=='buy'
    assert projected['cash_delta']==('31' if net else '23') and projected['registeredCashDelta']==('-19' if net else '-21')
    assert projected['settlement_currency']==('CNY' if net else 'USD')
    assert projected['settlement_amount']==('31' if net else None)
    assert projected['originalSettlementAmount']==('19' if net else None)
    series=await client.get('/api/portfolio/series',params={'recordId':record['id'],'accountKind':'real'})
    assert series.status_code==200,series.text
    series_order=next(row for row in series.json()['orders'] if row['lineage']['rootTradeId']==wrong['id'])
    assert series_order['side']=='sell' and series_order['lineage']['amendmentId']
    assert series_order['settlementAmount']==('31' if net else None)
    async with db.connection() as conn:
        source=await(await conn.execute('SELECT side,quantity,price,settlement_amount FROM trade_ledger WHERE owner_id=%s AND id=%s',(admin,wrong['id']))).fetchone()
        assert source=={'side':'buy','quantity':Decimal(2),'price':Decimal(10),'settlement_amount':Decimal(19) if net else None}
        row=await(await conn.execute('SELECT * FROM trade_amendments WHERE owner_id=%s',(admin,))).fetchone()
        assert row['flat_side_change'] is True and row['cash_delta']==(50 if net else 44)
        # Persisted display cost keeps the original cash-recovery convention;
        # economic moving-average realized P/L is independently replayed below.
        assert row['after_quantity']==3 and row['after_cost']==Decimal('9')
        assert row['after_realized']==Decimal('2.6')
        assert row['currency']==('CNY' if net else 'USD')
        assert row['replacement']['currency']==('HKD' if net else 'USD')
        balance=await(await conn.execute('SELECT sum(amount) value FROM cash_ledger_entries WHERE owner_id=%s AND account_id=%s',(admin,account))).fetchone()
        assert balance['value']==(980 if net else 972)
    if not net:
        snap=(await client.get('/api/v2/account-assets/trading',headers=headers,params={'recordId':record['id']})).json()['data']
        active=[row for row in snap['orders'] if row['id'] in (first['id'],replacement['id'])]
        mixed={**correction,'requestId':str(uuid4()),'snapshotRevision':snap['snapshotRevision'],'recordRevision':active[0]['recordRevision'],'action':'merge','timeSourceOrderId':first['id'],
               'orders':[{'id':row['id'],'revision':row['revision']} for row in active],
               'replacement':{'qty':7,'price':10,'fees':2,'tradedAt':first['tradedAt']}}
        refused=await client.post('/api/v2/account-assets/trading/corrections/preview',headers=headers,json=mixed)
        assert refused.status_code==409 and '同方向' in refused.text,refused.text
    # Removing the corrected sell restores the verified preceding buy, not a
    # reversal inferred from the immutable source's old buy direction.
    deleted=await client.request('DELETE',prefix+'/'+replacement['id'],headers=headers,json={'requestId':str(uuid4())})
    assert deleted.status_code==200,deleted.text
    async with db.connection() as conn:
        r=await(await conn.execute('SELECT qty,cost FROM portfolio_records WHERE owner_id=%s AND id=%s',(admin,record['id']))).fetchone()
        assert r=={'qty':Decimal(5),'cost':Decimal('10.2')}
        assert (await(await conn.execute('SELECT sum(amount) value FROM cash_ledger_entries WHERE owner_id=%s AND account_id=%s',(admin,account))).fetchone())['value']==949


async def test_flat_direction_rejects_unproved_negative_position_atomically(client,admin,db):
    account,record=await setup(client)
    headers=await native_headers(db,admin)
    body={'requestId':str(uuid4()),'recordId':record['id'],'side':'buy','mode':'record','qty':'2','price':'10','fees':'1',
          'tradedAt':'2026-09-01T12:00:00Z','tif':'gtc','session':'REGULAR'}
    original=await client.post('/api/v1/orders',headers=headers,json=body)
    assert original.status_code==200,original.text
    changed=await client.put('/api/v1/orders/'+original.json()['data']['order']['id'],headers=headers,json={**body,'requestId':str(uuid4()),'side':'sell'})
    assert changed.status_code==409,changed.text
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_amendments WHERE owner_id=%s',(admin,))).fetchone())['n']==0
        assert (await(await conn.execute('SELECT qty FROM portfolio_records WHERE owner_id=%s AND id=%s',(admin,record['id']))).fetchone())['qty']==2
        assert (await(await conn.execute('SELECT sum(amount) value FROM cash_ledger_entries WHERE owner_id=%s AND account_id=%s',(admin,account))).fetchone())['value']==979
