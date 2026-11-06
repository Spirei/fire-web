from uuid import uuid4
import httpx
import pytest
from alcor_api.cli import create_user
from test_cash_ledger import account,command,submit


@pytest.mark.asyncio
async def test_cash_history_is_read_only_original_currency_bounded_versioned_and_owner_scoped(client,admin,app,db,settings):
    aid=await account(client)
    async with db.connection() as conn:
        before=await(await conn.execute('SELECT * FROM cash_ledger_collections')).fetchall()
    empty=await client.get('/api/cash/accounts/'+aid+'/entries')
    assert empty.status_code==200 and empty.headers['cache-control']=='no-store' and empty.json()['items']==[] and empty.json()['total']==0 and empty.json()['revision']==0,empty.text
    assert empty.json()['coverageScope']=='platform_registered_entries_only'
    async with db.connection() as conn:assert await(await conn.execute('SELECT * FROM cash_ledger_collections')).fetchall()==before
    await submit(client,command(aid,amount='100'))
    await submit(client,command(aid,'external_deposit','2'))
    await submit(client,command(aid,'external_withdrawal','1'))
    await submit(client,command(aid,amount='0',currency='HKD'))
    path='/api/cash/accounts/'+aid+'/entries'
    first=await client.get(path,params={'limit':2});assert first.status_code==200 and len(first.json()['items'])==2,first.text
    page=first.json();assert page['total']==4 and page['nextOffset']==2
    assert (await client.get(path,params={'limit':2,'offset':2})).status_code==409
    tail=await client.get(path,params={'limit':2,'offset':2,'revision':page['revision']});assert tail.status_code==200 and tail.json()['nextOffset'] is None
    items=page['items']+tail.json()['items'];assert len({row['id'] for row in items})==4
    assert any(row['currency']=='HKD' and row['registeredAmount']=='0' for row in items)
    assert any(row['currency']=='USD' and row['registeredAmount']=='-1' for row in items)
    assert all(row['receipt']=={'kind':'cash','requestId':row['requestId']} for row in items)
    for row in items:
        receipt=await client.get('/api/cash/operations/'+row['receipt']['requestId'])
        assert receipt.status_code==200 and receipt.json()['entryId']==row['id']
    usd=await client.get(path,params={'currency':'USD'});assert usd.status_code==200 and usd.json()['total']==3 and all(row['currency']=='USD' for row in usd.json()['items'])
    for params in ({'currency':'EUR'},{'limit':101},{'offset':-1}):assert (await client.get(path,params=params)).status_code==422
    await submit(client,command(aid,'external_deposit','1'))
    assert (await client.get(path,params={'offset':2,'revision':page['revision']})).status_code==409
    await create_user(settings,'OtherCashHistory','Synthetic9Pass')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as other:
        login=await other.post('/api/session/login',json={'login':'OtherCashHistory','password':'Synthetic9Pass'});assert login.status_code==200
        other.headers['x-csrf-token']=login.json()['csrf']
        assert (await other.get(path)).status_code==404


@pytest.mark.asyncio
async def test_independent_external_credit_does_not_spend_or_fabricate_unknown_order_reservations(client,admin,db):
    aid=await account(client)
    await submit(client,command(aid,amount='0'))
    async with db.connection() as conn:
        await conn.execute("INSERT INTO broker_account_references VALUES(%s,%s,'order','unknown-pending-reservation','USD')",(admin,aid))
    deposited,_=await submit(client,command(aid,'external_deposit','5'))
    assert deposited['balanceAfter']=='5'
    denied=await client.post('/api/cash/preview',json=command(aid,'external_withdrawal','1'))
    assert denied.status_code==409
    history=(await client.get('/api/cash/accounts/'+aid+'/entries')).json()
    assert history['total']==2 and {row['registeredAmount'] for row in history['items']}=={'0','5'}


@pytest.mark.asyncio
async def test_account_reconciliation_cannot_spend_its_own_existing_reservation(client,admin):
    from test_trading import setup
    from test_internal_orders import command as order_command,submit as order_submit
    aid,record=await setup(client)
    await order_submit(client,order_command(record))
    rejected=await client.post('/api/cash/preview',json=command(aid,'reconcile_balance','20'))
    assert rejected.status_code==409,rejected.text
    own=(await client.get('/api/cash/accounts/'+aid)).json()['currencies'][0]
    assert own['balance']=='1000'
    assert (await client.post('/api/cash/preview',json=command(aid,'reconcile_balance','21'))).status_code==200
