"""Internal flat net mode must not expand old F11 HTTP or fabricate FX/fee cash."""
import copy
from uuid import uuid4
from decimal import Decimal

from psycopg import errors
from psycopg.types.json import Jsonb

from test_trading import setup
from test_legacy_trade_corrections import native_headers
from alcor_api.source_snapshot import canonical, sha


async def test_net_is_internal_only_and_db_cannot_substitute_hkd_amount_for_cny_cash(client,admin,db):
    _,record=await setup(client,market='HK',account_market='CN',code='00700',currency='CNY')
    headers={**await native_headers(db,admin),'x-alcor-trading-context':'nullable-v1'}
    fill={'requestId':str(uuid4()),'recordId':record['id'],'side':'buy','mode':'record','qty':'2','price':'10','fees':'1',
          'tradedAt':'2026-09-01T12:00:00Z','tif':'gtc','session':'REGULAR','settlementAmount':'19'}
    created=await client.post('/api/v2/orders',headers=headers,json=fill)
    assert created.status_code==200,created.text
    trade=created.json()['data']['order']
    snap=(await client.get('/api/v2/account-assets/trading',headers=headers,params={'recordId':record['id']})).json()['data']
    original=next(row for row in snap['orders']if row['id']==trade['id'])
    command={'requestId':str(uuid4()),'accountId':admin,'snapshotRevision':snap['snapshotRevision'],
        'recordId':record['id'],'recordRevision':original['recordRevision'],'action':'amend',
        'orders':[{'id':original['id'],'revision':original['revision']}],
        'replacement':{'qty':2,'price':12,'fees':1,'tradedAt':original['tradedAt']}}
    refused=await client.post('/api/v2/account-assets/trading/corrections/preview',headers=headers,json=command)
    assert refused.status_code==409,refused.text
    assert (await client.post('/api/v2/account-assets/trading/corrections/preview',headers=headers,
        json={**command,'allow_flat_net_settlement':True})).status_code==400
    assert (await client.post('/api/v2/account-assets/trading/corrections/preview',headers=headers,
        json={**command,'replacement':{**command['replacement'],'settlementAmount':23}})).status_code==400
    amended=await client.put('/api/v2/orders/'+trade['id'],headers=headers,json={**fill,'requestId':str(uuid4()),'price':'12','settlementAmount':'23'})
    assert amended.status_code==200,amended.text
    async with db.connection() as conn:
        row=await(await conn.execute('SELECT * FROM trade_amendments WHERE owner_id=%s',(admin,))).fetchone()
        assert row['currency']=='CNY' and row['cash_basis']=='flat_actual_net'
        assert row['replacement']['currency']=='HKD' and row['replacement']['settlement_currency']=='CNY'
        assert Decimal(row['replacement']['amount'])==24 and Decimal(row['replacement']['settlement_amount'])==23
        assert row['cash_delta']==-4 and row['after_cost']==Decimal('12.5')
        # Rebuild an exact current CAS/evidence proposal but lie about cash delta:
        # HKD 24+fee1 is not the actual CNY net23. The DB guard must reject it.
        current=await(await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s',(admin,record['id']))).fetchone()
        bad=dict(row);bad.update(id=uuid4(),request_id=uuid4(),replacement_id=uuid4(),previous_amendment_id=row['id'],
            previous_record_amendment_id=row['id'],before_record_revision=current['revision'],before_quantity=current['qty'],
            before_cost=current['cost'],before_event=row['replacement'],replacement={**row['replacement'],'settlement_amount':'25'},cash_delta=Decimal(-3))
        evidence=copy.deepcopy(row['evidence']);evidence.update(beforeEvent=bad['before_event'],replacement=bad['replacement'])
        evidence['members'][0].update(beforeEvent=bad['before_event'],previousAmendmentId=str(row['id']))
        bad.update(evidence=evidence,evidence_raw=canonical(evidence),evidence_sha256=sha(canonical(evidence)))
        columns=[key for key in bad if key!='created_at']
        values=[Jsonb(bad[key])if key in ('evidence','before_event','replacement')else bad[key]for key in columns]
        import pytest
        with pytest.raises(errors.CheckViolation) as rejected:
            async with conn.transaction():
                await conn.execute('INSERT INTO trade_amendments('+','.join(columns)+') VALUES('+','.join(['%s']*len(columns))+')',values)
        assert 'cash and quantity must exactly conserve' in str(rejected.value)
        assert (await(await conn.execute('SELECT count(*) n FROM trade_amendments WHERE owner_id=%s',(admin,))).fetchone())['n']==1
