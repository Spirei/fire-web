"""Synthetic F27 read purity, revision paging and real cash-authority transfer."""
from decimal import Decimal
from uuid import uuid4

import pytest
from psycopg.errors import CheckViolation
from test_card_wallet import KEY, ROOT, apply, draft, owner, state
from test_cash_ledger import account, command, submit


async def test_gets_do_not_initialize_and_history_is_complete_or_explicitly_bounded(client, db):
    uid = await owner(client)
    for path in (ROOT, ROOT+'/history?cardKey='+KEY, '/api/cards/wallet?cardKey='+KEY,
                 '/api/cards/amounts', '/api/cards'):
        response = await client.get(path)
        assert response.status_code == 200, response.text
    assert (await client.get(ROOT+'/operations/'+str(uuid4()))).status_code == 404
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM card_wallet_collections WHERE owner_id=%s', (uid,))).fetchone())['n'] == 0
    await apply(client, 'set_amount', '0')
    # Retained immutable synthetic facts, not 5,001 HTTP mutations. No cash entries are invented.
    async with db.connection() as conn:
        row = await (await conn.execute('SELECT basis_id FROM card_wallet_accounts WHERE owner_id=%s AND card_key=%s', (uid, KEY))).fetchone()
        await conn.execute("INSERT INTO card_wallet_entries(owner_id,id,card_key,basis_id,kind,original_amount,currency,delta,balance,occurred_at,projection_revision) SELECT %s,gen_random_uuid(),%s,%s,'deposit',1,'USD',1,n,'2020-01-01'::timestamptz+n*interval '1 second',1 FROM generate_series(1,101) n", (uid, KEY, row['basis_id']))
    full = await client.get('/api/cards/wallet', params={'cardKey': KEY})
    assert full.status_code == 200 and len(full.json()['entries']) == 101, full.text
    assert full.json()['entries'][0]['delta'] == 1 and full.json()['entries'][0]['balance'] == 101
    assert isinstance(full.json()['entries'][0]['delta'], (float,int))
    first = (await client.get(ROOT+'/history', params={'cardKey':KEY,'limit':100})).json()
    assert len(first['items']) == 100 and first['nextCursor']
    assert (await client.get(ROOT+'/history', params={'cardKey':KEY,'limit':100,'after':first['nextCursor']})).status_code == 409
    second = await client.get(ROOT+'/history', params={'cardKey':KEY,'limit':100,'after':first['nextCursor'],'revision':first['revision']})
    assert second.status_code == 200 and len(second.json()['items']) == 1
    assert len({r['id'] for r in first['items']+second.json()['items']}) == 101
    async with db.connection() as conn:
        await conn.execute('UPDATE card_wallet_collections SET revision=revision+1 WHERE owner_id=%s', (uid,))
        await conn.execute("INSERT INTO card_wallet_entries(owner_id,id,card_key,basis_id,kind,original_amount,currency,delta,balance,occurred_at,projection_revision) SELECT %s,gen_random_uuid(),%s,%s,'deposit',1,'USD',1,n,'2020-01-01'::timestamptz+n*interval '1 second',1 FROM generate_series(102,5001) n", (uid, KEY, row['basis_id']))
    assert (await client.get(ROOT+'/history', params={'cardKey':KEY,'after':first['nextCursor'],'revision':first['revision']})).status_code == 409
    oversized = await client.get('/api/cards/wallet', params={'cardKey':KEY})
    assert oversized.status_code == 409 and '5000' in oversized.text
    assert (await client.get(ROOT+'/history', params={'cardKey':KEY,'limit':100})).status_code == 200


async def test_broker_forward_reverse_preserves_original_cash_and_stale_is_atomic(client, db, settings):
    uid = await owner(client)
    aid = await account(client)
    await submit(client, command(aid, amount='1000'))
    await apply(client, 'set_amount', '10', when='2026-09-01T00:00:00Z')
    async def linked(operation, amount, when):
        cash = (await client.get('/api/cash/accounts/'+aid)).json()
        broker = (await client.get('/api/broker-accounts/'+aid)).json()
        data = await draft(client, operation, amount, when=when, fundAccount='broker',
            accountId=aid, accountKind='real', cashRevision=cash['revision'], accountRevision=broker['revision'])
        p = await client.post(ROOT+'/preview', json=data)
        assert p.status_code == 200, p.text
        return data, p.json()
    data, preview = await linked('deposit','25','2026-09-02T00:00:00Z')
    assert Decimal(preview['effects']['brokerTransfer']['cashDelta']) == -25
    result = await client.post(ROOT+'/operations', json={'data':data,'preview':preview['preview']})
    assert result.status_code == 200, result.text
    assert (await client.post(ROOT+'/operations', json={'data':data,'preview':preview['preview']})).json() == result.json()
    assert Decimal((await state(client))['accounts'][0]['amount']) == 35
    assert Decimal((await client.get('/api/cash/accounts/'+aid)).json()['currencies'][0]['registeredBalance']) == 975
    async with db.connection() as conn:
        original = await (await conn.execute('SELECT c.* FROM cash_ledger_entries c JOIN card_wallet_cash_links l ON l.cash_entry_id=c.id WHERE l.owner_id=%s AND l.request_id=%s', (uid,data['requestId']))).fetchone()
    # Exact-looking cash reversals cannot bypass the paired card mutation/link.
    from alcor_api.cli import create_user
    foreign=await create_user(settings,'CashForeign','Synthetic9Pass')
    for changes in ({}, {'currency':'HKD'}, {'owner_id':foreign}):
        with pytest.raises(CheckViolation):
            async with db.connection() as conn, conn.transaction():
                await conn.execute('UPDATE card_wallet_entries SET deleted_at=clock_timestamp() WHERE owner_id=%s AND id=%s',(uid,data['requestId']))
                await conn.execute("INSERT INTO cash_ledger_entries(id,owner_id,account_id,account_kind,currency,request_id,kind,amount,affects_owner,occurred_at,note,reversal_entry_id) VALUES(%s,%s,%s,%s,%s,%s,'external_deposit',25,true,'2026-09-03'::timestamptz,'',%s)",
                    (uuid4(),changes.get('owner_id',uid),aid,'real',changes.get('currency','USD'),uuid4(),original['id']))
    async with db.connection() as conn:
        retained=await(await conn.execute('SELECT deleted_at FROM card_wallet_entries WHERE owner_id=%s AND id=%s',(uid,data['requestId']))).fetchone()
        assert retained['deleted_at'] is None
    withdrawn, p = await linked('withdraw','5','2026-09-03T00:00:00Z')
    saved = await client.post(ROOT+'/operations', json={'data':withdrawn,'preview':p['preview']})
    assert saved.status_code == 200, saved.text
    stale, p = await linked('deposit','1','2026-09-04T00:00:00Z')
    await submit(client, command(aid,'external_deposit','1',occurredAt='2026-09-04T00:00:00Z'))
    assert (await client.post(ROOT+'/operations',json={'data':stale,'preview':p['preview']})).status_code == 409
    assert Decimal((await state(client))['accounts'][0]['amount']) == 30
    reversal,_ = await apply(client,'delete_entry',entryId=data['requestId'],when='2026-09-05T00:00:00Z')
    assert reversal['effects']['brokerTransfer']['reversalOf'] == data['requestId']
    assert Decimal((await state(client))['accounts'][0]['amount']) == 5
    assert Decimal((await client.get('/api/cash/accounts/'+aid)).json()['currencies'][0]['registeredBalance']) == 1006
    async with db.connection() as conn:
        rows = await (await conn.execute('SELECT * FROM card_wallet_cash_links WHERE owner_id=%s', (uid,))).fetchall()
        assert len(rows) == 3
        assert (await (await conn.execute('SELECT count(*) AS n FROM cash_ledger_entries WHERE owner_id=%s', (uid,))).fetchone())['n'] == 5


async def test_linked_reversal_cannot_silently_make_card_negative_or_mix_book_currency(client,app,db):
    import httpx
    uid=await owner(client)
    aid=await account(client)
    await submit(client,command(aid,amount='100'))
    await apply(client,'set_amount','0',when='2026-09-01T00:00:00Z')
    async def data(kind,amount,when,**extra):
        cash=(await client.get('/api/cash/accounts/'+aid)).json()
        broker=(await client.get('/api/broker-accounts/'+aid)).json()
        return await draft(client,kind,amount,when=when,fundAccount='broker',accountId=aid,accountKind='real',cashRevision=cash['revision'],accountRevision=broker['revision'],**extra)
    deposit=await data('deposit','25','2026-09-02T00:00:00Z')
    p=await client.post(ROOT+'/preview',json=deposit)
    assert p.status_code==200,p.text
    assert (await client.post(ROOT+'/operations',json={'data':deposit,'preview':p.json()['preview']})).status_code==200
    withdrawal=await data('withdraw','20','2026-09-03T00:00:00Z')
    p=await client.post(ROOT+'/preview',json=withdrawal)
    assert p.status_code==200,p.text
    assert (await client.post(ROOT+'/operations',json={'data':withdrawal,'preview':p.json()['preview']})).status_code==200
    for changes in ({'accountKind':'simulated'},{'currency':'HKD'}):
        raw=await data('deposit','1','2026-09-04T00:00:00Z')
        rejected=await client.post(ROOT+'/preview',json={**raw,**changes})
        assert rejected.status_code==409,rejected.text
    reversal=await draft(client,'delete_entry',entryId=deposit['requestId'],when='2026-09-04T00:00:00Z')
    p=await client.post(ROOT+'/preview',json=reversal)
    assert p.status_code==200 and p.json()['effects']['needsNegativeConfirmation'] is True,p.text
    denied=await client.post(ROOT+'/operations',json={'data':reversal,'preview':p.json()['preview']})
    assert denied.status_code==409,denied.text
    assert Decimal((await state(client))['accounts'][0]['amount'])==5
    assert Decimal((await client.get('/api/cash/accounts/'+aid)).json()['currencies'][0]['registeredBalance'])==95
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as peer:
        await owner(peer,'WalletForeign')
        assert (await peer.get(ROOT+'/operations/'+deposit['requestId'])).status_code==404
        raw=await draft(peer,'deposit','1',fundAccount='broker',accountId=aid,accountKind='real',cashRevision=0,accountRevision=1)
        assert (await peer.post(ROOT+'/preview',json=raw)).status_code in (404,409)
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) AS n FROM cash_ledger_entries WHERE owner_id=%s',(uid,))).fetchone())['n']==3
