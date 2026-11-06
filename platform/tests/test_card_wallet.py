"""Manual card amounts use synthetic identities in the fixture's physically verified isolated PG."""

import asyncio
from decimal import Decimal
from uuid import uuid4

import httpx
import psycopg
import pytest
from alcor_api.card_wallet_contract import money, replay
from alcor_api.native_app_auth import issue_grant
from alcor_api.security import digest
from fastapi import HTTPException

ROOT='/api/account/card-wallet'
KEY='synthetic/card.png'
PASSWORD='SyntheticWalletPass9'


async def owner(client,name='WalletOwner'):
    response=await client.post('/api/auth/register',json={'username':name,'password':PASSWORD})
    assert response.status_code==201,response.text
    response=await client.post('/api/session/login',json={'login':name,'password':PASSWORD})
    assert response.status_code==200,response.text
    client.headers['x-csrf-token']=response.json()['csrf']
    return response.json()['user']['id']


async def state(client,key=KEY):
    response=await client.get(ROOT,params={'cardKey':key})
    assert response.status_code==200,response.text
    return response.json()


async def draft(client,operation,amount=None,*,when='2020-01-01T00:00:00+00:00',key=KEY,currency='USD',**extra):
    return {'requestId':str(uuid4()),'expectedRevision':(await state(client,key))['revision'],'operation':operation,'cardKey':key,
            'occurredAt':when,'currency':currency,**({'amount':amount} if amount is not None else {}),**extra}


async def apply(client,operation,amount=None,**options):
    data=await draft(client,operation,amount,**options)
    preview=await client.post(ROOT+'/preview',json=data)
    assert preview.status_code==200,preview.text
    response=await client.post(ROOT+'/operations',json={'data':data,'preview':preview.json()['preview']})
    assert response.status_code==200,response.text
    return response.json(),data


def test_exact_decimal_replay_does_not_invent_an_opening():
    with pytest.raises(HTTPException):
        money(0.1)
    row={'id':uuid4(),'kind':'deposit','original_amount':Decimal('0.1'),'target_amount':None,'occurred_at':'2020','order_id':1}
    with pytest.raises(HTTPException):
        replay([row],None)
    value,_=replay([row],Decimal('100000000000.123456789123456789'))
    assert value==Decimal('100000000000.223456789123456789')


async def test_unknown_amount_real_zero_unit_and_no_other_ledger_writes(client,db):
    uid=await owner(client)
    assert (await state(client))['accounts']==[]
    assert (await client.put('/api/cards/holdings',json={'cardKey':KEY,'held':True})).status_code==200
    assert (await state(client))['accounts']==[]
    unknown=await draft(client,'deposit','1')
    denied=await client.post(ROOT+'/preview',json=unknown)
    assert denied.status_code==409 and '期初' in denied.json()['error']['message']
    receipt,_=await apply(client,'set_amount','0',currency=None)
    snapshot=await state(client)
    assert snapshot['accounts'][0]['amountKnown'] is True and Decimal(snapshot['accounts'][0]['amount'])==0
    assert snapshot['accounts'][0]['currency'] is None
    assert snapshot['historicalCoverageKnown'] is False
    assert (await client.get('/api/cards/amounts')).json()['amounts'][0]['amount']==0
    assert (await client.get(ROOT+'/history',params={'cardKey':KEY})).json()['items']==[]
    refused=await client.post(ROOT+'/preview',json=await draft(client,'deposit','1'))
    assert refused.status_code==409 and '币种未知' in refused.json()['error']['message']
    assert (await client.get(ROOT+'/operations/'+receipt['requestId'])).json()==receipt
    async with db.connection() as conn:
        for table in ('cash_ledger_entries','trade_ledger','portfolio_records'):
            assert (await(await conn.execute('SELECT count(*) AS n FROM '+table+' WHERE owner_id=%s',(uid,))).fetchone())['n']==0


async def test_backfill_absolute_adjustment_delete_and_same_time_order_are_real_pg_replayed(client,db):
    await owner(client)
    await apply(client,'set_amount','100')
    deposit,_=await apply(client,'deposit','50',when='2020-01-03T00:00:00+00:00')
    adjusted,_=await apply(client,'adjust','120',when='2020-01-04T00:00:00+00:00')
    late,_=await apply(client,'withdraw','10',when='2020-01-02T00:00:00+00:00')
    assert late['effects']['recordedEntry']['amount']=='10' and late['effects']['recordedEntry']['currency']=='USD'
    assert Decimal(late['effects']['delta'])==0
    assert Decimal((await state(client))['accounts'][0]['amount'])==120
    history=(await client.get(ROOT+'/history',params={'cardKey':KEY})).json()['items']
    rows={row['id']:row for row in history}
    assert Decimal(rows[adjusted['requestId']]['delta'])==-20
    assert Decimal(rows[deposit['requestId']]['balance'])==140
    assert rows[late['requestId']]['brokerLinked'] is False
    await apply(client,'delete_entry',entryId=late['requestId'],when='2020-01-05T00:00:00+00:00')
    history=(await client.get(ROOT+'/history',params={'cardKey':KEY})).json()['items']
    assert Decimal(next(row for row in history if row['id']==adjusted['requestId'])['delta'])==-30
    await apply(client,'delete_entry',entryId=adjusted['requestId'],when='2020-01-06T00:00:00+00:00')
    assert Decimal((await state(client))['accounts'][0]['amount'])==150
    # Equal-time mutations keep server order, and cancellation recomputes an absolute target rather than reusing its old delta.
    await apply(client,'adjust','130',when='2020-01-03T00:00:00+00:00')
    await apply(client,'withdraw','5',when='2020-01-03T00:00:00+00:00')
    assert Decimal((await state(client))['accounts'][0]['amount'])==125
    await apply(client,'delete_entry',entryId=deposit['requestId'],when='2020-01-07T00:00:00+00:00')
    assert Decimal((await state(client))['accounts'][0]['amount'])==125
    cancelled=(await client.get(ROOT+'/history',params={'cardKey':KEY,'includeDeleted':'true'})).json()['items']
    assert sum(row['cancelled'] for row in cancelled)==3
    with pytest.raises(psycopg.Error):
        async with db.connection() as conn:
            await conn.execute('UPDATE card_wallet_entries SET original_amount=999 WHERE id=%s',(deposit['requestId'],))


async def test_proof_binds_payload_session_revision_and_preference_generation(client,app):
    await owner(client)
    data=await draft(client,'set_amount','12.123456789123456789')
    preview=(await client.post(ROOT+'/preview',json=data)).json()
    altered=await client.post(ROOT+'/operations',json={'data':{**data,'amount':'13'},'preview':preview['preview']})
    assert altered.status_code==409
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as peer:
        login=await peer.post('/api/session/login',json={'login':'WalletOwner','password':PASSWORD})
        peer.headers['x-csrf-token']=login.json()['csrf']
        assert (await peer.post(ROOT+'/operations',json={'data':data,'preview':preview['preview']})).status_code==409
    await client.put('/api/cards/tags',json={'cardKey':KEY,'tags':['Changed during preview']})
    assert (await client.post(ROOT+'/operations',json={'data':data,'preview':preview['preview']})).status_code==409
    fresh=(await client.post(ROOT+'/preview',json=data)).json()
    results=await asyncio.gather(*(client.post(ROOT+'/operations',json={'data':data,'preview':fresh['preview']}) for _ in range(4)))
    assert all(result.status_code==200 for result in results),[result.text for result in results]
    assert all(result.json()==results[0].json() for result in results)
    assert Decimal((await state(client))['accounts'][0]['amount'])==Decimal('12.123456789123456789')
    assert (await client.post(ROOT+'/operations',json={'data':{**data,'amount':'14'},'preview':fresh['preview']})).status_code==409


async def test_unknown_opening_adjustment_negative_confirmation_and_broker_link_fail_closed(client,db):
    uid=await owner(client)
    data=await draft(client,'adjust','-5')
    proof=await client.post(ROOT+'/preview',json=data)
    assert proof.status_code==200 and proof.json()['effects']['needsNegativeConfirmation'] is True
    assert (await client.post(ROOT+'/operations',json={'data':data,'preview':proof.json()['preview']})).status_code==409
    data['allowNegativeBalance']=True
    proof=await client.post(ROOT+'/preview',json=data)
    committed=await client.post(ROOT+'/operations',json={'data':data,'preview':proof.json()['preview']})
    assert committed.status_code==200 and committed.json()['effects']['historyEffects'][0]['delta'] is None
    history=(await client.get(ROOT+'/history',params={'cardKey':KEY})).json()
    assert history['items'][0]['delta'] is None and history['items'][0]['currency']=='USD'
    broker=await client.post(ROOT+'/preview',json=await draft(client,'deposit','10',when='2020-01-02T00:00:00+00:00',fundAccount='broker'))
    assert broker.status_code==409 and '联动' in broker.json()['error']['message']
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) AS n FROM cash_ledger_entries WHERE owner_id=%s',(uid,))).fetchone())['n']==0
    await apply(client,'delete_entry',entryId=data['requestId'],when='2020-01-03T00:00:00+00:00')
    assert (await state(client))['accounts'][0]['amount'] is None


async def test_unknown_uuid_close_races_same_financial_lock_and_late_request_cannot_execute(client,db):
    await owner(client)
    data=await draft(client,'set_amount','17')
    preview=(await client.post(ROOT+'/preview',json=data)).json()
    path=ROOT+'/operations/'+data['requestId']
    closed=await client.post(path+'/close',json={})
    assert closed.json()=={'requestId':data['requestId'],'state':'closed','executed':False}
    assert (await client.post(ROOT+'/operations',json={'data':data,'preview':preview['preview']})).status_code==409
    assert (await state(client))['accounts']==[]
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) AS n FROM card_wallet_checkpoints')).fetchone())['n']==0


async def test_private_details_masked_at_rest_receipts_and_reveal_requires_current_owner_auth(client,app,db,settings):
    uid=await owner(client)
    identifier=str(uuid4())
    saved=await client.patch(ROOT+'/details',json={'requestId':identifier,'expectedRevision':0,'cardKey':KEY,'changes':{'number':'4111 1111 1111 1111','expiry':'12/2099','cvv':'9876','note':'Synthetic private descriptor'}})
    assert saved.status_code==200 and saved.json()['secretValuesIncluded'] is False,saved.text
    snapshot=await state(client)
    record=snapshot['details'][KEY]
    assert record['numberLast4']=='1111' and 'number' not in record and 'cvv' not in record and 'expiry' not in record
    receipt=await client.get(ROOT+'/operations/'+identifier)
    assert '4111' not in receipt.text and '9876' not in receipt.text and '12/2099' not in receipt.text
    async with db.connection() as conn:
        row=await(await conn.execute('SELECT * FROM card_wallet_details WHERE owner_id=%s',(uid,))).fetchone()
        assert '4111' not in str(row['metadata']) and '9876' not in str(row['metadata'])
        assert '4111' not in row['secret_ciphertext']
        user=await(await conn.execute('SELECT * FROM users WHERE id=%s',(uid,))).fetchone()
        grant=await issue_grant(conn,user,'portfolio.read','Synthetic no-wallet-scope')
    assert (await client.get(ROOT,headers={'authorization':'Bearer '+grant['access_token']})).status_code==403
    assert (await client.get('/api/cards/wallet',headers={'authorization':'Bearer '+grant['access_token']})).status_code==401
    revealed=await client.post(ROOT+'/details/reveal',json={'cardKey':KEY,'reveal':True})
    assert revealed.status_code==200 and revealed.json()['cvv']=='9876'
    token=client.cookies['alcor_session']
    async with db.connection() as conn:
        await conn.execute("UPDATE sessions SET created_at=clock_timestamp()-interval '16 minutes' WHERE token_hash=%s",(digest(token),))
        before=await(await conn.execute('SELECT created_at,expires_at FROM sessions WHERE token_hash=%s',(digest(token),))).fetchone()
    assert (await client.post(ROOT+'/details/reveal',json={'cardKey':KEY,'reveal':True})).status_code==403
    assert (await client.post(ROOT+'/details/reveal',json={'cardKey':KEY,'reveal':True,'password':'Incorrect'})).status_code==403
    result=await client.post(ROOT+'/details/reveal',json={'cardKey':KEY,'reveal':True,'password':PASSWORD})
    assert result.status_code==200 and result.json()['number']=='4111 1111 1111 1111'
    async with db.connection() as conn:
        assert await(await conn.execute('SELECT created_at,expires_at FROM sessions WHERE token_hash=%s',(digest(token),))).fetchone()==before
    path=settings.connection_secret_dir/'connections.key'
    key=path.read_bytes();path.unlink()
    try:
        unavailable=(await state(client))['details'][KEY]
        assert unavailable['secretState']=='unavailable' and unavailable['numberLast4'] is None
        assert not path.exists()
        assert (await client.post(ROOT+'/details/reveal',json={'cardKey':KEY,'reveal':True,'password':PASSWORD})).status_code==503
    finally:
        path.write_bytes(key);path.chmod(0o600)


async def test_legacy_financial_writes_return_original_receipts_and_keep_history(client,db):
    uid=await owner(client)
    created=await client.put('/api/cards/amounts',json={'cardKey':KEY,'amount':1,'currency':'USD'})
    assert created.status_code==200,created.text
    rid=created.headers['x-alcor-request-id']
    receipt=await client.get(ROOT+'/operations/'+rid)
    assert receipt.status_code==200 and receipt.json()['state']=='completed'
    assert receipt.json()['requestId']==rid
    added=await client.post('/api/cards/wallet',json={'cardKey':KEY,'kind':'deposit','amount':1,'currency':'USD'})
    assert added.status_code==200 and added.json()['balance']==2,added.text
    assert added.json()['entry']['brokerLinked'] is False
    replay=await client.put('/api/cards/amounts',json={'cardKey':KEY,'amount':1,'currency':'USD'},headers={'x-alcor-request-id':rid})
    assert replay.status_code==200 and replay.json()==created.json()
    assert Decimal((await state(client))['accounts'][0]['amount'])==2
    # Clearing a balance with recorded entries cannot discard its financial history.
    assert (await client.delete('/api/cards/amounts',params={'cardKey':KEY})).status_code==409
    assert (await client.delete('/api/cards/wallet',params={'id':str(uuid4())})).status_code==404
    removed=await client.delete('/api/cards/wallet',params={'id':added.json()['entry']['id']})
    assert removed.status_code==200 and removed.json()['balance']==1,removed.text
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) AS n FROM cash_ledger_entries WHERE owner_id=%s',(uid,))).fetchone())['n']==0
        assert (await(await conn.execute('SELECT count(*) AS n FROM card_wallet_entries WHERE owner_id=%s AND deleted_at IS NOT NULL',(uid,))).fetchone())['n']==1


async def test_wallet_retirement_clears_private_credentials_but_preserves_declared_financial_history(client,db,settings):
    from alcor_api.cli import create_user
    uid=await owner(client)
    await create_user(settings,'AnotherWalletAdmin',PASSWORD,role='admin')
    saved=await client.patch(ROOT+'/details',json={'requestId':str(uuid4()),'expectedRevision':0,'cardKey':KEY,'changes':{'number':'4111111111111111','cvv':'9876'}})
    assert saved.status_code==200
    receipt,_=await apply(client,'set_amount','23.123456789123456789')
    closed=await client.post('/api/v1/auth/delete-account',json={'password':PASSWORD})
    assert closed.status_code==200,closed.text
    async with db.connection() as conn:
        for table in ('card_wallet_details','card_wallet_previews'):
            assert (await(await conn.execute('SELECT count(*) AS n FROM '+table+' WHERE owner_id=%s',(uid,))).fetchone())['n']==0
        assert (await(await conn.execute("SELECT count(*) AS n FROM card_wallet_operations WHERE owner_id=%s AND kind='details'",(uid,))).fetchone())['n']==0
        retained=await(await conn.execute('SELECT amount FROM card_wallet_accounts WHERE owner_id=%s',(uid,))).fetchone()
        assert retained['amount']==Decimal('23.123456789123456789')
        assert (await(await conn.execute('SELECT count(*) AS n FROM card_wallet_checkpoints WHERE owner_id=%s',(uid,))).fetchone())['n']==1
        assert (await(await conn.execute('SELECT result FROM card_wallet_operations WHERE owner_id=%s AND request_id=%s',(uid,receipt['requestId']))).fetchone())['result']==receipt
    assert (await client.get(ROOT)).status_code==401


async def test_wallet_schema_fault_rolls_back_retirement_instead_of_leaving_secret_rows(client,db,settings):
    from alcor_api.cli import create_user
    uid=await owner(client)
    await create_user(settings,'AnotherWalletAdmin',PASSWORD,role='admin')
    assert (await client.patch(ROOT+'/details',json={'requestId':str(uuid4()),'expectedRevision':0,'cardKey':KEY,'changes':{'cvv':'9876'}})).status_code==200
    async with db.connection() as conn:
        await conn.execute('ALTER TABLE card_wallet_details RENAME TO hidden_card_wallet_details')
    try:
        closed=await client.post('/api/v1/auth/delete-account',json={'password':PASSWORD})
        assert closed.status_code==500
        async with db.connection() as conn:
            assert (await(await conn.execute('SELECT active FROM users WHERE id=%s',(uid,))).fetchone())['active'] is True
            assert (await(await conn.execute('SELECT count(*) AS n FROM hidden_card_wallet_details WHERE owner_id=%s',(uid,))).fetchone())['n']==1
    finally:
        async with db.connection() as conn:
            await conn.execute('ALTER TABLE hidden_card_wallet_details RENAME TO card_wallet_details')
