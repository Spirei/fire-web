"""Schedule observations are private information, never authority to mint cash."""
import json
from uuid import uuid4

import httpx
from alcor_api.dividend_chain import DividendChain
from alcor_api.security import Identity
from price_alerts_candidate.source_fixture import announcement
from test_trading import setup


async def append(db, owner, **changes):
    async with db.connection() as conn:
        row = await (await conn.execute('SELECT u.id,u.username,u.role,s.token_hash,s.expires_at FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=%s AND s.client_id=\'new-web\' LIMIT 1',(owner,))).fetchone()
    return await DividendChain(db).append(Identity(**row,csrf=''),announcement(**changes))


async def facts(db):
    async with db.connection() as conn:
        return {t:await(await conn.execute('SELECT row_to_json(t) AS row FROM '+t+' t ORDER BY 1::text')).fetchall() for t in ('dividend_announcement_revisions','dividend_receipts','trade_ledger','cash_ledger_entries','market_streams','tasks')}


async def test_owner_schedule_latest_revision_paging_unknowns_and_all_gets_are_pure(client,admin,db,app):
    first = await append(db,admin)
    revised = announcement(sourceRevision='source-v2',expectedPreviousRevision=first['revision'])
    revised['raw']['statement']='每10股派息0USD'
    revised['sourceBytes']=json.dumps(revised['raw'],ensure_ascii=False)
    await append(db,admin,**revised)
    await append(db,admin,sourceEventId='second-actual-announcement')
    before=await facts(db)
    url='/api/market/dividend-schedule?market=US&code=AAPL&limit=1'
    r=await client.get(url)
    assert r.status_code==200,r.text
    data=r.json()
    assert len(data['dividends'])==1 and data['nextCursor'] is not None
    assert data['automaticCollection'] is data['automaticEstimatedSettlement'] is False
    assert data['holding'] is None and data['coverage']=={'complete':False,'partial':True}
    second=(await client.get(url+'&before='+str(data['nextCursor']))).json()
    assert len(second['dividends'])==1 and second['nextCursor'] is None
    assert second['dividends'][0]['amount']=='0' and second['dividends'][0]['cashReceipt'] is False
    assert (await client.get('/api/market/dividend-schedule?market=US&code=AAPL&market=HK')).status_code==400
    assert (await client.get('/api/market/dividend-schedule?market=US&code=AAPL&recordId='+str(uuid4()))).status_code==404
    assert await facts(db)==before
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as anon:
        assert (await anon.get(url)).status_code==401
    login=await client.post('/api/auth/login',json={'username':'AdminOne','password':'Synthetic9Pass'})
    assert login.status_code==200,login.text
    legacy=await client.get('/api/v1/dividends?market=US&code=AAPL')
    assert legacy.status_code==200,legacy.text
    old=legacy.json()['data']
    assert old['stale'] is True and old['stalenessVerified'] is False
    assert old['dividends'][1]['amount']==0 and old['dividends'][1]['amountText']=='0'
    assert await facts(db)==before


async def test_old_estimated_settlement_is_rejected_without_any_ledger_or_task_change(client,admin,db):
    _account,record=await setup(client)
    await append(db,admin)
    login=await client.post('/api/auth/login',json={'username':'AdminOne','password':'Synthetic9Pass'})
    assert login.status_code==200
    before=await facts(db)
    rejected=await client.post('/api/v1/dividends',json={'recordId':record['id']})
    assert rejected.status_code==409,rejected.text
    assert await facts(db)==before
    schedule=await client.get('/api/v1/dividends',params={'market':'US','code':'AAPL','recordId':record['id']})
    assert schedule.status_code==200,schedule.text
    holding=schedule.json()['data']['holding']
    assert holding['historyCompletenessVerified'] is False
    assert holding['rows'][0]['booked'] is None
    assert holding['rows'][0]['expectation']['quantity'] is None
    assert await facts(db)==before


async def test_actual_receipt_uuid_event_and_owner_guards_preserve_cash_currency_and_simulation(client,admin,db,app,settings):
    from alcor_api.cli import create_user
    from test_account_admin import login
    from test_notification_composition import statement
    _,real=await setup(client)
    _sim_account,sim=await setup(client,name='Synthetic simulation',account_kind='simulated')
    command=statement(real,eventReference='actual-statement-event')
    preview=await client.post('/api/dividends/receipts/preview',json=command)
    assert preview.status_code==200,preview.text
    payload={'data':command,'preview':preview.json()['preview']}
    saved=await client.post('/api/dividends/receipts/operations',json=payload)
    assert saved.status_code==200,saved.text
    result=saved.json()
    assert result['requestId']==command['requestId'] and result['cashDelta']=='8.0'
    before=await facts(db)
    assert (await client.post('/api/dividends/receipts/operations',json=payload)).json()==result
    assert (await client.post('/api/dividends/receipts/operations',json={'data':{**command,'grossAmount':'11'},'preview':preview.json()['preview']})).status_code==409
    # Event identity prevents a new UUID from duplicating the same statement.
    duplicate=statement({**real,'revision':result['record']['revision']},eventReference='actual-statement-event')
    assert (await client.post('/api/dividends/receipts/preview',json=duplicate)).status_code==409
    assert await facts(db)==before
    await create_user(settings,'DividendOther','Synthetic9Pass',role='user')
    peer=await login(app,'DividendOther')
    try:
        assert (await peer.get('/api/dividends/receipts/operations/'+command['requestId'])).status_code==404
    finally:
        await peer.aclose()
    # The same external reference in a distinct simulated account is not real-account cash.
    simulated=statement(sim,eventReference='actual-statement-event')
    p=await client.post('/api/dividends/receipts/preview',json=simulated)
    assert p.status_code==200,p.text
    s=await client.post('/api/dividends/receipts/operations',json={'data':simulated,'preview':p.json()['preview']})
    assert s.status_code==200,s.text
    async with db.connection() as conn:
        rows=await(await conn.execute('SELECT account_kind,currency,amount FROM cash_ledger_entries WHERE request_id=ANY(%s)',([command['requestId'],simulated['requestId']],))).fetchall()
        assert {(row['account_kind'],row['currency'],str(row['amount'])) for row in rows}=={('real','USD','8.0'),('simulated','USD','8.0')}


async def test_schedule_refuses_corrupted_saved_original_or_interpretation(client,admin,db):
    await append(db,admin)
    url='/api/market/dividend-schedule?market=US&code=AAPL'
    assert (await client.get(url)).status_code==200
    # Controlled isolated restore damage, bypassing the normal immutable trigger.
    async with db.connection() as conn,conn.transaction():
        await conn.execute('ALTER TABLE dividend_announcement_revisions DISABLE TRIGGER immutable_dividend_announcement')
        await conn.execute("UPDATE dividend_announcement_revisions SET normalized=jsonb_set(normalized,'{amount}','\"999\"')")
        await conn.execute('ALTER TABLE dividend_announcement_revisions ENABLE TRIGGER immutable_dividend_announcement')
    assert (await client.get(url)).status_code==503
    before=await facts(db)
    assert (await client.get(url)).status_code==503
    assert await facts(db)==before


# The shared fixture serves synthetic loopback documents, never a real provider.
from test_notification_composition_restore import controlled_provider  # noqa: F401


async def test_collected_schedule_reparses_exact_bound_source_page_without_fetching_again(client,admin,app,db,controlled_provider):
    from alcor_api.dividend_sources import Target
    from alcor_api.dividend_source_worker import cycle
    port,state=controlled_provider
    app.state.dividend_sources.targets={'schedule-fixture':Target(id='schedule-fixture',source='eastmoney',host='127.0.0.1',port=port,addresses=('127.0.0.1',),approved_access=True,fixture=True,scheme='http',allow_plaintext=True).validate('test')}
    from dataclasses import asdict
    app.state.settings.dividend_source_targets=[asdict(t) for t in app.state.dividend_sources.targets.values()]
    configured=await client.post('/api/dividends/sources',json={'requestId':str(uuid4()),'targetId':'schedule-fixture','market':'CN','code':'600000','periodFrom':None,'periodThrough':None})
    assert configured.status_code==201,configured.text
    queued=await client.post('/api/dividends/sources/tasks',json={'request_id':str(uuid4()),'data':{'configRevision':configured.json()['revision']}})
    assert queued.status_code==202,queued.text
    assert (await cycle(app.state.dividend_sources,uuid4()))['state']=='succeeded'
    calls=len(state['requests']);before=await facts(db)
    result=await client.get('/api/market/dividend-schedule?market=CN&code=600000')
    assert result.status_code==200,result.text
    value=result.json()['dividends'][0]
    assert value['amount']=='0.25' and value['cashReceipt'] is False
    assert value['currency']=='CNY' and value['rawSha256']
    assert len(state['requests'])==calls and await facts(db)==before
    async with db.connection() as conn,conn.transaction():
        await conn.execute('ALTER TABLE dividend_source_pages DISABLE TRIGGER immutable_dividend_source_page')
        await conn.execute("UPDATE dividend_source_pages SET raw_bytes=convert_to('corrupt','UTF8')")
        await conn.execute('ALTER TABLE dividend_source_pages ENABLE TRIGGER immutable_dividend_source_page')
    assert (await client.get('/api/market/dividend-schedule?market=CN&code=600000')).status_code==503
    assert len(state['requests'])==calls


async def test_schedule_never_borrows_another_owners_same_security_announcement(client,admin,settings,app,db):
    from alcor_api.cli import create_user
    from test_account_admin import login
    await append(db,admin)
    other=await create_user(settings,'OtherSchedule','Synthetic9Pass',role='admin')
    peer=await login(app,'OtherSchedule')
    try:
        empty=await peer.get('/api/market/dividend-schedule?market=US&code=AAPL')
        assert empty.status_code==200 and empty.json()['dividends']==[]
        await append(db,other,sourceEventId='other-owner-event')
        peer_data=(await peer.get('/api/market/dividend-schedule?market=US&code=AAPL')).json()
        mine=(await client.get('/api/market/dividend-schedule?market=US&code=AAPL')).json()
        assert len(peer_data['dividends'])==len(mine['dividends'])==1
        assert peer_data['dividends'][0]['revision']!=mine['dividends'][0]['revision']
        assert peer_data['dividends'][0]['sourceEventId']=='other-owner-event'
    finally:
        await peer.aclose()
