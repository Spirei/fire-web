from datetime import UTC,datetime
from decimal import Decimal
from uuid import uuid4
import copy
import json
from pathlib import Path
import pytest
from psycopg.errors import CheckViolation

from test_trading import setup,command as trade_command,submit as trade_submit
from test_trade_amendments import command,complete,P
from test_legacy_trade_corrections import native_headers,draft


async def two_buys(client):
    account,record=await setup(client,name='Action chain independent manual book')
    first,_=await trade_submit(client,trade_command(record,quantity='10',price='10',amount='100',fees='1',occurredAt='2026-09-01T12:00:00Z'))
    second,_=await trade_submit(client,trade_command(first['record'],quantity='10',price='20',amount='200',fees='2',occurredAt='2026-09-02T12:00:00Z'))
    data=await command(client,record['id'],first['tradeId'],price='15',fees='2.5')
    data.update(action='merge',members=[{'tradeId':first['tradeId'],'expectedAmendmentId':None},{'tradeId':second['tradeId'],'expectedAmendmentId':None}])
    data['replacement']['quantity']='20'
    return account,first,second,data


async def cash(client,account):
    response=await client.get('/api/cash/accounts/'+account);assert response.status_code==200,response.text
    currency=next(row for row in response.json()['currencies'] if row['currency']=='USD')
    assert currency['complete'];return Decimal(currency['balance'])


async def deletion(client,record,trade):
    data=await command(client,record,trade)
    data.update(action='delete',replacement=None)
    return data


@pytest.mark.asyncio
async def test_merge_delete_and_next_registration_share_one_effective_history_without_rewriting_originals(client,admin,db):
    account,first,second,data=await two_buys(client)
    async with db.connection() as conn:
        original=await(await conn.execute('SELECT * FROM trade_ledger ORDER BY id')).fetchall()
        original_cash=await(await conn.execute('SELECT * FROM cash_ledger_entries ORDER BY id')).fetchall()
    done,proof=await complete(client,data)
    assert proof['quantityBefore']==proof['quantityAfter']=='20' and Decimal(proof['costAfter'])==Decimal('15.125')
    golden=json.loads((Path(__file__).parent/'fixtures/trade-correction-action-legacy-golden.json').read_text())['vectors']
    assert abs(Decimal(str(golden['merged']['cost']))-Decimal(proof['costAfter']))<Decimal('1e-10')
    assert Decimal(proof['cashEffect']['delta'])==Decimal('.5') and await cash(client,account)==Decimal('697.5')
    current=(await client.get('/api/portfolio/records/'+first['recordId'])).json()['record']
    sale,_=await trade_submit(client,trade_command(current,side='sell',quantity='5',price='30',amount='150',fees='0',occurredAt=datetime.now(UTC).isoformat()))
    assert sale['record']['qty']=='15' and Decimal(sale['record']['cost'])==Decimal('10.167') and Decimal(sale['realizedPnl'])==Decimal('74.375')
    assert await cash(client,account)==Decimal('847.5')
    assert abs(Decimal(str(golden['later']['realized']))-Decimal(sale['realizedPnl']))<Decimal('1e-10')
    listing=await client.get('/api/trading/fills',params={'recordId':first['recordId']});assert listing.status_code==200,listing.text
    rows={row['id']:row for row in listing.json()['items']}
    assert rows[first['tradeId']]['effectiveActive'] and rows[first['tradeId']]['quantity']=='20'
    assert not rows[second['tradeId']]['effectiveActive'] and rows[second['tradeId']]['cash_delta'] is None and rows[second['tradeId']]['correction']['state']=='superseded'
    delete_sale=await deletion(client,first['recordId'],sale['tradeId']);deleted,_=await complete(client,delete_sale)
    assert deleted['replacementId'] is None and await cash(client,account)==Decimal('697.5')
    delete_merge=await deletion(client,first['recordId'],first['tradeId']);removed,_=await complete(client,delete_merge)
    assert removed['replacementId'] is None and await cash(client,account)==1000
    current=(await client.get('/api/portfolio/records/'+first['recordId'])).json()['record'];assert current['qty']=='0' and Decimal(current['cost'])==0
    # A fresh real registration starts from the corrected zero, while all raw
    # original quantity/cost/cash boundaries remain independently checkable.
    next_trade,_=await trade_submit(client,trade_command(current,quantity='1',price='40',amount='40',fees='0',occurredAt=datetime.now(UTC).isoformat()))
    assert next_trade['record']['qty']=='1' and Decimal(next_trade['record']['cost'])==40 and await cash(client,account)==960
    assert (await client.get(P+'/operations/'+data['requestId'])).json()==done
    assert (await client.get('/api/trading/operations/'+first['requestId'])).json()==first
    assert (await client.get('/api/trading/operations/'+second['requestId'])).json()==second
    async with db.connection() as conn:
        assert await(await conn.execute('SELECT * FROM trade_ledger WHERE id=ANY(%s) ORDER BY id',([row['id'] for row in original],))).fetchall()==original
        assert await(await conn.execute('SELECT * FROM cash_ledger_entries WHERE id=ANY(%s) ORDER BY id',([row['id'] for row in original_cash],))).fetchall()==original_cash
        members=await(await conn.execute('SELECT disposition,count(*) n FROM trade_correction_members GROUP BY disposition')).fetchall()
        assert {row['disposition']:row['n'] for row in members}=={'retained':1,'superseded':1,'deleted':2}


@pytest.mark.asyncio
@pytest.mark.parametrize('version',[1,2])
async def test_old_four_methods_merge_delete_preserve_original_uuid_views_and_real_zero(client,admin,db,version):
    account,record=await setup(client,name='Legacy exact merge and delete')
    headers=await native_headers(db,admin);prefix=f'/api/v{version}/account-assets'
    entered=[]
    for i,(price,fee) in enumerate(((10,1),(20,2))):
        state=(await client.get(prefix+'/trading',headers=headers)).json()['data']
        revision=record['revision'] if not entered else entered[-1]['data']['items'][0]['recordRevision']
        body=draft(admin,{'id':record['id'],'revision':revision},state,price=price,fees=fee,tradedAt=f'2026-09-0{i+1}T12:00:00Z')
        proof=await client.post(prefix+'/trading/preview',json=body,headers=headers);assert proof.status_code==200,proof.text
        registered=await client.post(prefix+'/trading/submissions',json={**body,'requestId':str(uuid4())},headers=headers);assert registered.status_code==200,registered.text
        entered.append(registered.json()['data'])
    state=(await client.get(prefix+'/trading',headers=headers)).json()['data'];orders=state['orders']
    time_source=next(row for row in orders if row['id']==entered[0]['data']['items'][0]['id'])
    merge={'requestId':str(uuid4()),'accountId':admin,'snapshotRevision':state['snapshotRevision'],'recordId':record['id'],'recordRevision':time_source['recordRevision'],'action':'merge',
      'orders':[{'id':row['id'],'revision':row['revision']} for row in orders],'timeSourceOrderId':time_source['id'],
      'replacement':{'qty':20,'price':15,'fees':0,'tradedAt':time_source['tradedAt']}}
    p=await client.post(prefix+'/trading/corrections/preview',json=merge,headers=headers);assert p.status_code==200,p.text
    assert p.json()['data']['cashDelta']==3 and p.json()['data']['feeBefore']==3 and p.json()['data']['feeAfter']==0
    payload={**merge,'previewRevision':p.json()['data']['previewRevision']}
    result=await client.post(prefix+'/trading/corrections',json=payload,headers=headers);assert result.status_code==200,result.text
    result=result.json()['data'];active=[row for row in result['data']['snapshot']['orders'] if row['status']=='filled'];assert len(active)==1 and active[0]['qty']==20 and active[0]['fees']==0
    assert (await client.post(prefix+'/trading/corrections',json=payload,headers=headers)).json()['data']==result
    state=(await client.get(prefix+'/trading',headers=headers)).json()['data'];order=next(row for row in state['orders'] if row['status']=='filled')
    delete={'requestId':str(uuid4()),'accountId':admin,'snapshotRevision':state['snapshotRevision'],'recordId':record['id'],'recordRevision':order['recordRevision'],'action':'delete','orders':[{'id':order['id'],'revision':order['revision']}]}
    p=await client.post(prefix+'/trading/corrections/preview',json=delete,headers=headers);assert p.status_code==200,p.text
    assert p.json()['data']['cashDelta']==300 and p.json()['data']['feeBefore']==0
    gone=await client.post(prefix+'/trading/corrections',json={**delete,'previewRevision':p.json()['data']['previewRevision']},headers=headers);assert gone.status_code==200,gone.text
    assert not [row for row in gone.json()['data']['data']['snapshot']['orders'] if row['status']=='filled']
    assert gone.json()['data']['data']['snapshot']['cash']['nativeBalancesByCurrency']['USD']==1000
    for original in entered+[result]:assert (await client.get(prefix+'/operations/'+original['requestId'],headers=headers)).json()['data']==original


@pytest.mark.asyncio
async def test_group_principal_stale_member_delete_oversell_and_atomic_cash_failure_do_not_change_book(client,admin,db):
    account,first,second,data=await two_buys(client)
    rounded=copy.deepcopy(data);rounded['replacement']['price']='15.00000001'
    assert (await client.post(P+'/preview',json=rounded)).status_code==409
    stale=copy.deepcopy(data);stale['members'][1]['expectedAmendmentId']=str(uuid4())
    assert (await client.post(P+'/preview',json=stale)).status_code==409
    proof=await client.post(P+'/preview',json=data);assert proof.status_code==200,proof.text
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT current_database() name')).fetchone())['name'].startswith('alcor_test_')
        before=await(await conn.execute('SELECT * FROM portfolio_records WHERE id=%s',(first['recordId'],))).fetchone()
        await conn.execute("CREATE FUNCTION synthetic_group_cash_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='trade_correction' THEN RAISE EXCEPTION 'synthetic interrupted grouped cash' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;CREATE TRIGGER synthetic_group_cash_failure BEFORE INSERT ON cash_ledger_entries FOR EACH ROW EXECUTE FUNCTION synthetic_group_cash_failure()",prepare=False)
    envelope={'data':data,'preview':proof.json()['previewRevision']}
    stopped=await client.post(P+'/operations',json=envelope);assert stopped.status_code==200 and stopped.json()['state']=='failed',stopped.text
    assert (await client.get(P+'/operations/'+data['requestId'])).json()==stopped.json()
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM trade_amendments')).fetchone()
        assert not await(await conn.execute('SELECT 1 FROM trade_correction_members')).fetchone()
        assert await(await conn.execute('SELECT * FROM portfolio_records WHERE id=%s',(first['recordId'],))).fetchone()==before
        await conn.execute('DROP TRIGGER synthetic_group_cash_failure ON cash_ledger_entries;DROP FUNCTION synthetic_group_cash_failure()',prepare=False)
    assert (await client.post(P+'/operations',json=envelope)).json()==stopped.json()
    data['requestId']=str(uuid4());done,_=await complete(client,data)
    current=(await client.get('/api/portfolio/records/'+first['recordId'])).json()['record']
    sale,_=await trade_submit(client,trade_command(current,side='sell',quantity='1',price='30',amount='30',fees='0',occurredAt=datetime.now(UTC).isoformat()))
    remove=await deletion(client,first['recordId'],first['tradeId'])
    denied=await client.post(P+'/preview',json=remove);assert denied.status_code==409,denied.text
    assert await cash(client,account)==Decimal('727.5')
    async with db.connection() as conn:
        # Even a direct DB attempt cannot append an unrelated/root member or
        # alter membership evidence after its original UUID has committed.
        with pytest.raises(CheckViolation):
            async with conn.transaction():await conn.execute("INSERT INTO trade_correction_members(owner_id,amendment_id,trade_id,disposition,before_event,target_replacement_id) SELECT owner_id,%s,id,'retained','{}'::jsonb,%s FROM trade_ledger WHERE id=%s",(done['amendmentId'],done['replacementId'],sale['tradeId']))
        assert (await(await conn.execute('SELECT count(*) n FROM trade_correction_members')).fetchone())['n']==2
