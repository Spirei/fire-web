"""Remaining flat compatibility uses append-only notes and actual dividend proof."""
from decimal import Decimal
from uuid import uuid4

import pytest
from test_flat_workflow import fill
from test_legacy_trade_corrections import native_headers
from test_trading import setup


@pytest.mark.asyncio
async def test_note_only_and_combined_financial_note_are_append_only_cas_and_atomic(client,admin,db):
    _,record=await setup(client)
    headers=await native_headers(db,admin)
    created=await client.post('/api/v1/orders',headers=headers,json={**fill(record),'note':'original source note'})
    assert created.status_code==200,created.text
    trade=created.json()['data']['order'];tid=trade['id']
    change={'requestId':str(uuid4()),'note':'current display note','orderRevision':trade['revision'],'noteRevision':0}
    noted=await client.put('/api/v1/orders/'+tid,headers=headers,json=change)
    assert noted.status_code==200,noted.text
    assert noted.json()['data']['metadataOnly'] and noted.json()['data']['financialHistoryChanged'] is False
    assert noted.json()['data']['order']['note']=='current display note'
    assert noted.json()['data']['order']['originalNote']=='original source note'
    assert noted.json()['data']['order']['noteRevision']==1
    assert (await client.put('/api/v1/orders/'+tid,headers=headers,json=change)).json()==noted.json()
    stale=await client.put('/api/v1/orders/'+tid,headers=headers,json={**change,'requestId':str(uuid4()),'note':'stale overwrite'})
    assert stale.status_code==409,stale.text
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM trade_amendments WHERE owner_id=%s',(admin,))).fetchone()
        assert (await(await conn.execute('SELECT note FROM trade_ledger WHERE owner_id=%s AND id=%s',(admin,tid))).fetchone())['note']=='original source note'
    combined={**fill(record),'requestId':str(uuid4()),'price':'11','note':'financial and note together','orderRevision':trade['revision'],'noteRevision':1}
    changed=await client.put('/api/v1/orders/'+tid,headers=headers,json=combined)
    assert changed.status_code==200,changed.text
    replacement=changed.json()['data']['order']
    assert replacement['note']=='financial and note together' and replacement['noteRevision']==2
    assert replacement['originalNote']=='original source note'
    current=(await client.get('/api/v2/orders',headers=headers)).json()['data']['orders']
    assert next(row for row in current if row['id']==replacement['id'])['note']=='financial and note together'
    async with db.connection() as conn:
        before={table:await(await conn.execute('SELECT * FROM '+table+' WHERE owner_id=%s ORDER BY 1,2',(admin,))).fetchall() for table in ('trade_ledger','trade_amendments','cash_ledger_entries','legacy_flat_order_operations')}
        await conn.execute("CREATE FUNCTION reject_synthetic_flat_parent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic final parent receipt failure'; END $$")
        await conn.execute('CREATE TRIGGER reject_synthetic_flat_parent BEFORE INSERT ON legacy_flat_order_operations FOR EACH ROW EXECUTE FUNCTION reject_synthetic_flat_parent()')
    failed=await client.put('/api/v2/orders/'+replacement['id'],headers=headers,json={**combined,'requestId':str(uuid4()),'price':'12','note':'must rollback both','orderRevision':replacement['revision'],'noteRevision':2})
    assert failed.status_code>=500,failed.text
    async with db.connection() as conn:
        for table,rows in before.items():
            assert await(await conn.execute('SELECT * FROM '+table+' WHERE owner_id=%s ORDER BY 1,2',(admin,))).fetchall()==rows
    observed=(await client.get('/api/v2/orders',headers=headers)).json()['data']['orders']
    assert next(row for row in observed if row['id']==replacement['id'])['noteRevision']==2


@pytest.mark.asyncio
@pytest.mark.parametrize('version',[1,2])
async def test_flat_dividend_requires_actual_receipt_and_uses_single_income_cash_authority(client,admin,db,version):
    _,record=await setup(client)
    headers=await native_headers(db,admin);path=f'/api/v{version}/orders'
    missing=await client.post(path,headers=headers,json={**fill(record),'side':'dividend','qty':'100','price':'20','fees':'0'})
    assert missing.status_code==409 and 'actualReceipt' in missing.json()['message'],missing.text
    rid=str(uuid4())
    actual={'requestId':rid,'recordId':record['id'],'recordRevision':record['revision'],'eventReference':'Synthetic actual dividend '+rid,
        'grossAmount':'100','withheldTax':'15','processingFee':'2','currency':'USD','settlementCurrency':'USD','occurredAt':'2026-09-01T12:00:00Z','confirmedActualReceipt':True,'note':'actual statement receipt'}
    command={'requestId':rid,'recordId':record['id'],'side':'dividend','qty':'999','price':'999','fees':'17','actualReceipt':actual}
    incomplete_id=str(uuid4())
    incomplete={key:value for key,value in actual.items() if key!='withheldTax'}
    incomplete['requestId']=incomplete_id
    rejected=await client.post(path,headers=headers,json={**command,'requestId':incomplete_id,'actualReceipt':incomplete})
    assert rejected.status_code==422,rejected.text
    entered=await client.post(path,headers=headers,json=command)
    assert entered.status_code==200,entered.text
    value=entered.json()['data'];assert value['legacyQuantityPriceApplied'] is False and value['pending'] is False
    assert value['order']['side']=='dividend' and value['order']['amount']==100 and value['order']['fees']==17
    assert value['actualReceipt']['grossAmount']=='100' and value['actualReceipt']['withheldTax']=='15'
    assert (await client.post(path,headers=headers,json=command)).json()==entered.json()
    async with db.connection() as conn:
        trade=await(await conn.execute('SELECT quantity,price,amount,fees,cash_delta FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone()
        assert trade=={'quantity':Decimal(0),'price':Decimal(0),'amount':Decimal(100),'fees':Decimal(17),'cash_delta':Decimal(83)}
        assert (await(await conn.execute('SELECT count(*) n FROM dividend_receipts WHERE owner_id=%s',(admin,))).fetchone())['n']==1
        assert (await(await conn.execute("SELECT sum(amount) total FROM cash_ledger_entries WHERE owner_id=%s AND currency='USD'",(admin,))).fetchone())['total']==Decimal(1083)
    another=str(uuid4())
    duplicate=await client.post(path,headers=headers,json={**command,'requestId':another,'actualReceipt':{**actual,'requestId':another}})
    assert duplicate.status_code==409,duplicate.text


@pytest.mark.asyncio
async def test_note_revision_chain_uses_declared_revision_not_transaction_timestamp(client,admin,db):
    from psycopg.types.json import Jsonb
    _,record=await setup(client)
    headers=await native_headers(db,admin)
    entered=await client.post('/api/v1/orders',headers=headers,json={**fill(record),'note':'retained original'})
    assert entered.status_code==200,entered.text
    tid=entered.json()['data']['order']['id']
    async with db.connection() as conn:
        for revision,when in ((1,'2026-11-03T20:00:00Z'),(2,'2026-11-03T19:00:00Z')):
            rid=str(uuid4())
            result={'requestId':rid,'noteDeclaration':{'rootTradeId':tid,'recordId':record['id'],'note':'revision '+str(revision),'noteRevision':revision,'priorNoteRevision':revision-1}}
            await conn.execute('INSERT INTO legacy_flat_order_operations(owner_id,request_id,fingerprint,result,created_at) VALUES(%s,%s,%s,%s,%s)',(admin,rid,'synthetic retained metadata',Jsonb(result),when))
    response=await client.get('/api/v1/orders',headers=headers)
    assert response.status_code==200,response.text
    row=next(row for row in response.json()['data']['orders'] if row['id']==tid)
    assert row['note']=='revision 2' and row['noteRevision']==2 and row['originalNote']=='retained original'
    async with db.connection() as conn:
        duplicate={'noteDeclaration':{'rootTradeId':tid,'recordId':record['id'],'note':'duplicate revision','noteRevision':2,'priorNoteRevision':1}}
        await conn.execute('INSERT INTO legacy_flat_order_operations(owner_id,request_id,fingerprint,result) VALUES(%s,%s,%s,%s)',(admin,uuid4(),'synthetic conflicting metadata',Jsonb(duplicate)))
    rejected=await client.get('/api/v1/orders',headers=headers)
    assert rejected.status_code==409,rejected.text


@pytest.mark.asyncio
@pytest.mark.parametrize('version',[1,2])
async def test_flat_supplied_malformed_credentials_never_fall_back_to_valid_cookie(client,admin,db,version):
    _,record=await setup(client)
    valid=await native_headers(db,admin)
    entered=await client.post(f'/api/v{version}/orders',headers=valid,json=fill(record))
    assert entered.status_code==200,entered.text
    tid=entered.json()['data']['order']['id']
    async with db.connection() as conn:
        before={table:await(await conn.execute('SELECT * FROM '+table+' WHERE owner_id=%s ORDER BY 1,2',(admin,))).fetchall() for table in ('trade_ledger','trade_amendments','cash_ledger_entries','legacy_flat_order_operations')}
    for headers in ([('authorization','')],[('authorization','Bearer ')],[('authorization','Bearer invalid'),('authorization','Bearer invalid')]):
        read=await client.get(f'/api/v{version}/orders',headers=headers)
        assert read.status_code==401,read.text
        write=await client.put(f'/api/v{version}/orders/'+tid,headers=headers,json={'requestId':str(uuid4()),'note':'must not use valid owner cookie'})
        assert write.status_code==401,write.text
    async with db.connection() as conn:
        for table,rows in before.items():
            assert await(await conn.execute('SELECT * FROM '+table+' WHERE owner_id=%s ORDER BY 1,2',(admin,))).fetchall()==rows
