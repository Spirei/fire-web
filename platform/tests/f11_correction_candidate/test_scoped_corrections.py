"""F11 installed original-source corrections, never fake global-complete scope."""
import asyncio
from decimal import Decimal
from uuid import uuid4

import pytest
from actual_fee_test_support import actual_case, actual_operation
from legacy_fee_source_fixture import old_pg
from test_legacy_trade_corrections import native_headers
from test_trade_amendments import case, command, P

__all__=['old_pg']


@pytest.mark.parametrize('version',[1,2])
async def test_installed_original_scoped_old_preview_submit_receipt_and_unknown_owner_total(client,admin,app,old_pg,pg,tmp_path,version):
    async with actual_case(client,admin,app,old_pg,pg,tmp_path,fee='1.11') as (approved,hosted,_grant,_source,account,fill,actual):
        headers={**await native_headers(hosted.state.db,admin),'x-alcor-trading-context':'nullable-v1','x-alcor-trade-fees':'details-v1'}
        base=f'/api/v{version}/account-assets'
        assert (await approved.get(base+'/trading',params={'recordId':fill['recordId']},headers=headers)).status_code==409
        await actual_operation(approved,actual)
        assert (await approved.get(base+'/trading',headers=headers)).status_code==409
        response=await approved.get(base+'/trading',params={'recordId':fill['recordId']},headers=headers)
        assert response.status_code==200,response.text
        snapshot=response.json()['data']
        assert snapshot['projectionScope']['recordId']==fill['recordId'] and snapshot['projectionScope']['ownerComplete'] is False
        assert snapshot['cash']['complete'] is False and snapshot['cash']['balancesByCurrency'] is None
        original=next(row for row in snapshot['orders']if row['id']==fill['tradeId'])
        data={'requestId':str(uuid4()),'accountId':admin,'snapshotRevision':snapshot['snapshotRevision'],
            'recordId':fill['recordId'],'recordRevision':original['recordRevision'],'action':'amend',
            'orders':[{'id':original['id'],'revision':original['revision']}],
            'replacement':{'qty':original['qty'],'price':11,'fees':1.11,'tradedAt':original['tradedAt']}}
        proof=await approved.post(base+'/trading/corrections/preview',headers=headers,json=data)
        assert proof.status_code==200,proof.text
        posted={**data,'previewRevision':proof.json()['data']['previewRevision']}
        changed=await approved.post(base+'/trading/corrections',headers=headers,json=posted)
        assert changed.status_code==200,changed.text
        assert Decimal(str(proof.json()['data']['cashDelta']))==-10
        assert (await approved.post(base+'/trading/corrections',headers=headers,json=posted)).json()==changed.json()
        receipt=await approved.get(base+'/operations/'+data['requestId'],headers=headers)
        assert receipt.status_code==200,receipt.text
        async with hosted.state.db.connection() as conn:
            raw=await(await conn.execute('SELECT fees,cash_delta FROM trade_ledger WHERE id=%s',(fill['tradeId'],))).fetchone()
            assert raw=={'fees':Decimal(0),'cash_delta':Decimal(-100)}
            assert (await(await conn.execute('SELECT count(*) n FROM trade_amendments WHERE owner_id=%s',(admin,))).fetchone())['n']==1
            evidence=(await(await conn.execute('SELECT evidence FROM trade_amendments WHERE owner_id=%s',(admin,))).fetchone())['evidence']
            authority=evidence['members'][0]['sourceAuthority']
            assert authority['manifestId']==_source['manifestId']
            original_source=await(await conn.execute('SELECT raw FROM legacy_source_manifests WHERE owner_id=%s AND id=%s',(admin,authority['manifestId']))).fetchone()
            import hashlib
            assert hashlib.sha256(bytes(original_source['raw'])).hexdigest()==authority['sourceRawSha256']
        assert (await approved.get(base+'/trading',params={'recordId':'foreign-missing'},headers=headers)).status_code==404
        from test_trading import command as trade_command,submit as trade_submit
        from datetime import UTC,datetime
        record=(await approved.get('/api/portfolio/records/'+fill['recordId'])).json()['record']
        when=datetime.now(UTC).isoformat()  # Synthetic new fill after the source's verified cutover.
        await trade_submit(approved,trade_command(record,quantity='10',price='11',amount='110',fees='1.11',occurredAt=when))
        snap=(await approved.get(base+'/trading',params={'recordId':fill['recordId']},headers=headers)).json()['data']
        members=[row for row in snap['orders'] if row['status']=='filled']
        assert len(members)==2
        selected=next(row for row in members if row['id']!=fill['tradeId'] and row['tradedAt']==original['tradedAt'])
        merge={'requestId':str(uuid4()),'accountId':admin,'snapshotRevision':snap['snapshotRevision'],
            'recordId':fill['recordId'],'recordRevision':members[0]['recordRevision'],'action':'merge',
            'orders':[{'id':row['id'],'revision':row['revision']}for row in members],
            'timeSourceOrderId':selected['id'],
            'replacement':{'qty':20,'price':11,'fees':2.22,'tradedAt':selected['tradedAt']}}
        merged=await approved.post(base+'/trading/corrections/preview',headers=headers,json=merge)
        assert merged.status_code==200,merged.text
        merge_result=await approved.post(base+'/trading/corrections',headers=headers,json={**merge,'previewRevision':merged.json()['data']['previewRevision']})
        assert merge_result.status_code==200,merge_result.text
        snap=(await approved.get(base+'/trading',params={'recordId':fill['recordId']},headers=headers)).json()['data']
        live=next(row for row in snap['orders']if row['status']=='filled')
        delete={'requestId':str(uuid4()),'accountId':admin,'snapshotRevision':snap['snapshotRevision'],
            'recordId':fill['recordId'],'recordRevision':live['recordRevision'],'action':'delete',
            'orders':[{'id':live['id'],'revision':live['revision']}]}
        erased=await approved.post(base+'/trading/corrections/preview',headers=headers,json=delete)
        assert erased.status_code==200,erased.text
        erased_result=await approved.post(base+'/trading/corrections',headers=headers,json={**delete,'previewRevision':erased.json()['data']['previewRevision']})
        assert erased_result.status_code==200,erased_result.text
        assert (await approved.get(base+'/operations/'+data['requestId'],headers=headers)).json()==receipt.json()
        balance=(await approved.get('/api/cash/accounts/'+account)).json()['currencies'][0]
        assert Decimal(balance['balance'])==1000 and balance['complete']
        async with hosted.state.db.connection() as conn:
            assert (await(await conn.execute('SELECT count(*) n FROM trade_amendments WHERE owner_id=%s',(admin,))).fetchone())['n']==3



async def test_correction_snapshot_rechecks_revoked_actor_before_private_history(client,admin,app,db,monkeypatch):
    _,buy,_=await case(client)
    service=app.state.trade_amendments;original=service.snapshot
    async def revoked(who,record_id):
        async with db.connection() as conn:await conn.execute('DELETE FROM sessions WHERE token_hash=%s',(who.token_hash,))
        return await original(who,record_id)
    monkeypatch.setattr(service,'snapshot',revoked)
    response=await client.get(P,params={'recordId':buy['recordId']})
    assert response.status_code==401,response.text
    assert buy['tradeId']not in response.text


async def test_same_original_uuid_concurrent_submit_writes_single_amendment_and_cash_delta(client,admin,db):
    _,buy,_=await case(client)
    data=await command(client,buy['recordId'],buy['tradeId'])
    proof=await client.post(P+'/preview',json=data);assert proof.status_code==200,proof.text
    raw={'data':data,'preview':proof.json()['previewRevision']}
    first,second=await asyncio.gather(client.post(P+'/operations',json=raw),client.post(P+'/operations',json=raw))
    assert first.status_code==second.status_code==200
    assert first.json()==second.json() and first.json()['state']=='completed'
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_amendments WHERE owner_id=%s',(admin,))).fetchone())['n']==1
        assert (await(await conn.execute("SELECT count(*) n FROM cash_ledger_entries WHERE owner_id=%s AND kind='trade_correction'",(admin,))).fetchone())['n']==1


async def test_explicit_simulated_record_scope_never_combines_real_book_or_unknown_owner_totals(client,admin,db):
    from test_trading import setup,command as trade_command,submit as trade_submit
    real,real_record=await setup(client,name='Actual separate book',account_kind='real')
    simulation,sim_record=await setup(client,name='Simulation separate book',account_kind='simulated')
    real_fill,_=await trade_submit(client,trade_command(real_record))
    sim_fill,_=await trade_submit(client,trade_command(sim_record))
    headers={**await native_headers(db,admin),'x-alcor-trading-context':'nullable-v1'}
    base='/api/v2/account-assets'
    assert (await client.get(base+'/trading',headers=headers)).status_code==409
    snapshot=(await client.get(base+'/trading',params={'recordId':sim_record['id']},headers=headers)).json()['data']
    assert snapshot['projectionScope']['accountKind']=='simulated'
    assert snapshot['cash']['nativeBalancesByCurrency'] is None
    assert all(row['recordId']==sim_record['id']for row in snapshot['orders'])
    row=next(r for r in snapshot['orders']if r['id']==sim_fill['tradeId'])
    data={'requestId':str(uuid4()),'accountId':admin,'snapshotRevision':snapshot['snapshotRevision'],
        'recordId':sim_record['id'],'recordRevision':row['recordRevision'],'action':'amend',
        'orders':[{'id':row['id'],'revision':row['revision']}],
        'replacement':{'qty':2,'price':11,'fees':1,'tradedAt':row['tradedAt']}}
    async with db.connection() as conn:
        before=await(await conn.execute('SELECT * FROM cash_ledger_entries WHERE owner_id=%s AND account_id=%s ORDER BY id',(admin,real))).fetchall()
    foreign=await client.post(base+'/trading/corrections/preview',headers=headers,json={**data,'requestId':str(uuid4()),'accountId':'foreign-owner'})
    assert foreign.status_code==404,foreign.text
    proof=await client.post(base+'/trading/corrections/preview',headers=headers,json=data)
    assert proof.status_code==200,proof.text
    done=await client.post(base+'/trading/corrections',headers=headers,json={**data,'previewRevision':proof.json()['data']['previewRevision']})
    assert done.status_code==200,done.text
    async with db.connection() as conn:
        assert await(await conn.execute('SELECT * FROM cash_ledger_entries WHERE owner_id=%s AND account_id=%s ORDER BY id',(admin,real))).fetchall()==before
        changed=await(await conn.execute("SELECT account_kind,account_id FROM cash_ledger_entries WHERE owner_id=%s AND kind='trade_correction'",(admin,))).fetchone()
        assert changed=={'account_kind':'simulated','account_id':simulation}
