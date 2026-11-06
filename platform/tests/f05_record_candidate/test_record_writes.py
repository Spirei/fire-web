"""Old HTTP writes use the sole record authority and preserve financial originals."""
from uuid import uuid4

import pytest
from alcor_api.cli import create_user
from test_legacy_portfolio import PASSWORD, grant, record, register
from test_trading import command as trade_command
from test_trading import setup as trade_setup
from test_trading import submit as trade_submit


def body(**changes):
    return {'name':'Synthetic old record','code':'ZZZ','market':'US','price':None,'cost':0,'qty':0,'group':'','note':'',**changes}


@pytest.mark.parametrize('version',[None,1,2])
async def test_old_crud_success_cas_uuid_failure_receipts_and_bodyless_delete(client,db,version):
    owner=await register(client)
    headers=await grant(db,owner) if version else {}
    root=f'/api/v{version}/records' if version else '/api/records'
    rid=str(uuid4());raw=body(requestId=rid)
    response=await client.post(root,json=raw,headers=headers)
    assert response.status_code==(200 if version else 201),response.text
    created=response.json()['data'] if version else response.json();identifier=created['id']
    assert created['qty']==0 and created['price']==''
    receipt_path=root+'/operations/'+rid
    first=await client.get(receipt_path,headers=headers)
    assert first.status_code==200,first.text
    original=first.json()['data'] if version else first.json()
    assert original['state']=='completed' and original['record']['id']==identifier
    duplicate=await client.post(root,json=raw,headers=headers)
    assert duplicate.status_code==409
    assert (await client.get(receipt_path,headers=headers)).json()==first.json()
    updated=await client.put(root+'/'+identifier,json=body(requestId=str(uuid4()),revision=created['revision'],note='edited'),headers=headers)
    assert updated.status_code==200,updated.text
    current=updated.json()['data'] if version else updated.json()
    assert current['note']=='edited'
    stale_id=str(uuid4())
    stale=await client.put(root+'/'+identifier,json=body(requestId=stale_id,revision=created['revision'],note='stale'),headers=headers)
    assert stale.status_code==409,stale.text
    failed=(await client.get(root+'/operations/'+stale_id,headers=headers)).json()
    failed=failed['data'] if version else failed
    assert failed['state']=='failed' and failed['record'] is None
    mismatch=await client.put(root+'/'+identifier,json=body(requestId=str(uuid4()),revision=current['revision']),headers={**headers,'x-alcor-request-id':str(uuid4())})
    assert mismatch.status_code==400
    malformed=await client.request('DELETE',root+'/'+identifier,content=b'{broken',headers={**headers,'content-type':'application/json'})
    assert malformed.status_code==400
    deleted=await client.request('DELETE',root+'/'+identifier,headers=headers)
    assert deleted.status_code==200,deleted.text
    assert deleted.json()==({'code':0,'message':'ok','data':{'deleted':True}} if version else {'ok':True})
    assert (await client.get(receipt_path,headers=headers)).json()==first.json()
    async with db.connection() as conn:
        row=await(await conn.execute('SELECT qty,deleted_at FROM portfolio_records WHERE owner_id=%s AND id=%s',(owner,identifier))).fetchone()
        assert row['qty']==0 and row['deleted_at'] is not None


@pytest.mark.parametrize('version',[1,2])
async def test_old_native_record_scope_owner_and_explicit_invalid_token_never_borrow_cookie(client,db,settings,version):
    owner=await register(client);created=await record(db,owner,qty='0',cost='0')
    identifier=created['recordId'];root=f'/api/v{version}/records'
    reader=await grant(db,owner,'portfolio.read')
    denied=await client.post(root,json=body(requestId=str(uuid4())),headers=reader)
    assert denied.status_code==403
    other=await create_user(settings,'OtherRecordOwner',PASSWORD,role='user')
    foreign=await grant(db,other)
    for method in ('PUT','DELETE'):
        value=body(requestId=str(uuid4()),revision=1) if method=='PUT' else {'requestId':str(uuid4()),'revision':1}
        response=await client.request(method,root+'/'+identifier,json=value,headers=foreign)
        assert response.status_code==404,response.text
    assert (await client.get(root+'/'+identifier,headers=foreign)).status_code==404
    invalid=await client.post(root,json=body(),headers={'Authorization':'Bearer invalid'})
    assert invalid.status_code==401
    async with db.connection() as conn:
        row=await(await conn.execute('SELECT qty,revision,deleted_at FROM portfolio_records WHERE owner_id=%s AND id=%s',(owner,identifier))).fetchone()
        assert row['qty']==0 and row['revision']==1 and row['deleted_at'] is None
        assert not await(await conn.execute('SELECT 1 FROM portfolio_compatibility_receipts WHERE owner_id=%s',(owner,))).fetchone()


async def web_create(client,code):
    response=await client.post('/api/records',json=body(code=code))
    assert response.status_code==201,response.text
    return response.json()


async def test_old_batch_delete_second_child_failure_rolls_back_parent_and_every_tombstone(client,db):
    owner=await register(client)
    rows=[await web_create(client,'SYN1'),await web_create(client,'SYN2')]
    ids=sorted(row['id'] for row in rows);rid=str(uuid4())
    async with db.connection() as conn:
        await conn.execute('CREATE SEQUENCE f05_delete_attempts')
        await conn.execute("""CREATE FUNCTION f05_fail_second_delete() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.result->>'kind'='delete' THEN
            IF nextval('f05_delete_attempts')=2 THEN RAISE EXCEPTION 'synthetic second child failure'; END IF;
          END IF; RETURN NEW; END $$""")
        await conn.execute('CREATE TRIGGER f05_fail_delete BEFORE INSERT ON portfolio_record_operations FOR EACH ROW EXECUTE FUNCTION f05_fail_second_delete()')
    response=await client.post('/api/records/batch-delete',json={'ids':ids},headers={'x-alcor-request-id':rid})
    assert response.status_code==503,response.text
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT last_value FROM f05_delete_attempts')).fetchone())['last_value']==2
        rows=await(await conn.execute('SELECT deleted_at,revision FROM portfolio_records WHERE owner_id=%s AND id=ANY(%s)',(owner,ids))).fetchall()
        assert len(rows)==2 and all(row['deleted_at'] is None and row['revision']==1 for row in rows)
        assert not await(await conn.execute("SELECT 1 FROM portfolio_record_operations WHERE owner_id=%s AND result->>'kind'='delete'",(owner,))).fetchone()
        assert not await(await conn.execute('SELECT 1 FROM portfolio_compatibility_receipts WHERE owner_id=%s AND request_id=%s',(owner,rid))).fetchone()
        assert not await(await conn.execute('SELECT 1 FROM portfolio_batch_previews WHERE owner_id=%s',(owner,))).fetchone()


async def test_old_batch_delete_only_owned_snapshot_and_original_receipt_stays_immutable(client,db,settings):
    await register(client)
    first=await web_create(client,'OWN1');second=await web_create(client,'OWN2')
    other=await create_user(settings,'OtherBatchOwner',PASSWORD,role='user')
    foreign=await record(db,other,qty='0',cost='0')
    rid=str(uuid4());value={'ids':[first['id'],foreign['recordId'],second['id'],first['id']]}
    done=await client.post('/api/records/batch-delete',json=value,headers={'x-alcor-request-id':rid})
    assert done.status_code==200 and done.json()=={'ok':True,'deleted':2},done.text
    receipt=(await client.get('/api/records/operations/'+rid)).json()
    assert receipt['state']=='completed' and set(receipt['recordIds'])=={first['id'],second['id']}
    assert len(receipt['childRequestIds'])==2
    assert (await client.post('/api/records/batch-delete',json=value,headers={'x-alcor-request-id':rid})).status_code in (404,409)
    assert (await client.get('/api/records/operations/'+rid)).json()==receipt
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT deleted_at FROM portfolio_records WHERE owner_id=%s AND id=%s',(other,foreign['recordId']))).fetchone())['deleted_at'] is None


async def financial_originals(db,owner):
    async with db.connection() as conn:
        return {table:[row['value'] for row in await(await conn.execute(f'SELECT row_to_json(t)::text AS value FROM {table} t WHERE owner_id=%s ORDER BY id',(owner,))).fetchall()] for table in ('trade_ledger','cash_ledger_entries')}


async def test_old_financial_record_delete_update_batch_and_clear_preserve_original_trade_cash(client,admin,db):
    _account,position=await trade_setup(client)
    await trade_submit(client,trade_command(position))
    before=await financial_originals(db,admin)
    assert before['trade_ledger'] and before['cash_ledger_entries']
    headers=await grant(db,admin)
    snapshot=(await client.get('/api/v2/records/'+position['id'],headers=headers)).json()['data']
    refused=await client.request('DELETE','/api/v2/records/'+position['id'],headers=headers,json={'requestId':str(uuid4()),'revision':snapshot['revision']})
    assert refused.status_code==409,refused.text
    changed=await client.put('/api/v2/records/'+position['id'],headers=headers,json=body(requestId=str(uuid4()),revision=snapshot['revision'],code='DIFFERENT',qty=0))
    assert changed.status_code==409,changed.text
    login=await client.post('/api/auth/login',json={'username':'AdminOne','password':'Synthetic9Pass'})
    assert login.status_code==200,login.text
    empty=await web_create(client,'EMPTY')
    batch=await client.post('/api/records/batch-delete',json={'ids':[empty['id'],position['id']]})
    assert batch.status_code==409,batch.text
    listing=await client.get('/api/records');revision=int(listing.headers['x-alcor-records-revision'])
    clear=await client.request('DELETE','/api/records',json={'password':'Synthetic9Pass','collectionRevision':revision})
    assert clear.status_code==409,clear.text
    assert await financial_originals(db,admin)==before
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM portfolio_records WHERE owner_id=%s AND id=ANY(%s) AND deleted_at IS NOT NULL',(admin,[empty['id'],position['id']]))).fetchone()


async def test_old_clear_requires_current_owned_collection_and_keeps_tombstone_receipt(client,db,settings):
    owner=await register(client)
    first=await web_create(client,'CLEAR1');second=await web_create(client,'CLEAR2')
    foreign_owner=await create_user(settings,'OtherClearOwner',PASSWORD,role='user')
    foreign=await record(db,foreign_owner,qty='0',cost='0')
    listing=await client.get('/api/records');revision=int(listing.headers['x-alcor-records-revision'])
    for raw,status in [({'password':PASSWORD},409),({'password':PASSWORD,'collectionRevision':revision-1},409),({'password':'wrong','collectionRevision':revision},403)]:
        denied=await client.request('DELETE','/api/records',json=raw)
        assert denied.status_code==status,denied.text
    rid=str(uuid4())
    removed=await client.request('DELETE','/api/records',json={'password':PASSWORD,'collectionRevision':revision},headers={'x-alcor-request-id':rid})
    assert removed.status_code==200,removed.text
    assert removed.json()=={'ok':True,'records':2,'orders':0,'activities':0,'fundTransactions':0,'financialAndAuditHistoryRetained':True}
    receipt=(await client.get('/api/records/operations/'+rid)).json()
    assert receipt['kind']=='clear' and receipt['deleted']==2 and set(receipt['recordIds'])=={first['id'],second['id']}
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) AS n FROM portfolio_records WHERE owner_id=%s AND deleted_at IS NOT NULL',(owner,))).fetchone())['n']==2
        assert (await(await conn.execute('SELECT deleted_at FROM portfolio_records WHERE owner_id=%s AND id=%s',(foreign_owner,foreign['recordId']))).fetchone())['deleted_at'] is None
        assert not await(await conn.execute('SELECT 1 FROM trade_ledger WHERE owner_id=%s',(owner,))).fetchone()
