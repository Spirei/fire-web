"""Synthetic native intents, explicit actual declarations and immutable financial receipts."""
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from legacy_fee_source_fixture import old_pg  # noqa: F401
from test_legacy_trade_corrections import native_headers
from test_trading import command as fill_command
from test_trading import setup


async def context(client,headers,version=2):
    response=await client.get(f'/api/v{version}/account-assets/trading',headers={**headers,'x-alcor-trading-context':'nullable-v1'})
    assert response.status_code==200,response.text
    return response.json()['data']


def intent(owner,record,snapshot,**changes):
    return {'requestId':str(uuid4()),'accountId':owner,'recordId':record['id'],'recordRevision':record['revision'],
            'snapshotRevision':snapshot['snapshotRevision'],'side':'buy','mode':'order','orderType':'limit','qty':2,'price':10,'fees':1,'tif':'gtc','session':'REGULAR',**changes}


async def create_intent(client,owner,record,headers,version=2,**changes):
    raw=intent(owner,record,await context(client,headers,version),**changes)
    prefix=f'/api/v{version}/account-assets/trading'
    proof=await client.post(prefix+'/preview',json=raw,headers=headers)
    assert proof.status_code==200,proof.text
    submitted=await client.post(prefix+'/submissions',json={**raw,'previewRevision':proof.json()['data']['previewRevision']},headers=headers)
    assert submitted.status_code==200,submitted.text
    receipt=submitted.json()['data'];assert receipt['state']=='completed'
    return receipt['data']['items'][0],raw,receipt


async def observation(client,owner,record,order,headers,**changes):
    view=await context(client,headers)
    return {'requestId':str(uuid4()),'accountId':owner,'snapshotRevision':view['snapshotRevision'],
            'orderRevision':order['revision'],'recordRevision':record['revision'],**changes}


async def confirm_observation(client,oid,raw,headers):
    path=f'/api/trading/orders/{oid}/observations'
    proof=await client.post(path+'/preview',json=raw,headers=headers)
    assert proof.status_code==200,proof.text
    done=await client.post(path+'/submissions',json={'data':raw,'preview':proof.json()['preview'],'confirm':True},headers=headers)
    assert done.status_code==200,done.text
    return done.json()


async def ledger(db,owner):
    async with db.connection() as conn:
        return {table:await(await conn.execute(f'SELECT row_to_json(t)::text AS value FROM {table} t WHERE owner_id=%s ORDER BY id',(owner,))).fetchall() for table in ('trade_ledger','cash_ledger_entries')}


@pytest.mark.parametrize('version',[1,2])
async def test_base_asset_snapshot_is_installed_owned_typed_pure_and_scope_checked(client,admin,db,version):
    await setup(client)
    headers=await native_headers(db,admin,'portfolio.read')
    path=f'/api/v{version}/account-assets'
    before=await ledger(db,admin)
    result=await client.get(path,headers=headers)
    assert result.status_code==200,result.text
    data=result.json()['data'];assert data['accountId']==admin and data['currency']=='USD'
    assert 'summary' in data and 'positions' in data
    assert (await client.get(path+'?costMethod=unsupported',headers=headers)).status_code==400
    assert (await client.get(path+'?currency=USD&currency=HKD',headers=headers)).status_code==400
    assert (await client.get(path,headers={'authorization':'Bearer invalid'})).status_code==401
    assert (await client.get(path)).status_code==401
    assert await ledger(db,admin)==before


@pytest.mark.parametrize('version',[1,2])
async def test_old_native_create_amend_wait_cancel_and_original_uuid_keep_cash_originals(client,admin,db,version):
    _account,record=await setup(client)
    headers=await native_headers(db,admin,'portfolio.read orders.read orders.write orders.cancel')
    before=await ledger(db,admin)
    order,raw,created=await create_intent(client,admin,record,headers,version)
    assert order['status']=='pending' and order['reservedCash']=='21'
    operation=f'/api/v{version}/account-assets/operations/'+raw['requestId']
    original=await client.get(operation,headers=headers);assert original.status_code==200,original.text
    assert original.json()['data']==created
    assert (await client.post(f'/api/v{version}/account-assets/trading/submissions',json=raw,headers=headers)).status_code==409
    updated=intent(admin,record,await context(client,headers,version),orderRevision=order['revision'],price=12,note='Explicit old amendment')
    prefix=f'/api/v{version}/account-assets/trading/orders/'+order['id']
    proof=await client.post(prefix+'/preview',json=updated,headers=headers);assert proof.status_code==200,proof.text
    changed=await client.put(prefix,json={**updated,'previewRevision':proof.json()['data']['previewRevision']},headers=headers)
    assert changed.status_code==200,changed.text
    order=changed.json()['data']['data']['items'][0]
    assert order['limitPrice']=='12' and order['revision']==2
    raw_observation=await observation(client,admin,record,order,headers)
    observed=await client.post(f'/api/v{version}/account-assets/trading/orders/'+order['id']+'/observations',json=raw_observation,headers=headers)
    assert observed.status_code==200,observed.text
    assert observed.json()['data']['data']['observationState']=='waiting'
    listed=await client.get(f'/api/v{version}/account-assets/orders?scope=all',headers=headers)
    assert listed.status_code==200,listed.text
    selected={'orderId':order['id'],'recordId':record['id'],'market':'US','code':'AAPL','revision':order['revision'],'recordRevision':record['revision']}
    cancel={'requestId':str(uuid4()),'accountId':admin,'orders':[selected]}
    cancelled=await client.post(f'/api/v{version}/account-assets/orders/cancellations',json=cancel,headers=headers)
    assert cancelled.status_code==200,cancelled.text
    assert cancelled.json()['data']['data']['items'][0]['status']=='cancelled'
    assert (await client.get(operation,headers=headers)).json()==original.json()
    assert await ledger(db,admin)==before


async def test_actual_owner_fill_parent_and_oco_children_reserve_once_execute_one_cancel_sibling(client,admin,db):
    _account,record=await setup(client)
    headers=await native_headers(db,admin,'portfolio.read orders.read orders.write orders.cancel')
    attached={'session':'REGULAR','tif':'gtc','takeProfit':{'percent':10,'orderType':'limit','fees':1},'stopLoss':{'percent':10,'orderType':'limit','fees':1}}
    order,_raw,_=await create_intent(client,admin,record,headers,attachments=attached)
    explicit=fill_command(record,occurredAt=datetime.now(UTC).isoformat())
    observe=await observation(client,admin,record,order,headers,actualFill=explicit)
    done=await confirm_observation(client,order['id'],observe,headers)
    assert done['observationState']=='ready_actual_fill' and done['order']['status']=='filled'
    assert len(done['children'])==2 and done['trade'] and done['brokerExecution'] is False
    async with db.connection() as conn:
        legs=await(await conn.execute('SELECT order_id,role FROM internal_order_family_legs WHERE owner_id=%s',(admin,))).fetchall()
    by_role={row['role']:str(row['order_id']) for row in legs}
    profit=next(row for row in done['children'] if row['id']==by_role['take_profit'])
    sibling=next(row for row in done['children'] if row['id']==by_role['stop_loss'])
    async with db.connection() as conn:
        original_trade=await(await conn.execute('SELECT row_to_json(t)::text AS value FROM trade_ledger t WHERE owner_id=%s',(admin,))).fetchone()
        position=await(await conn.execute('SELECT revision FROM portfolio_records WHERE owner_id=%s AND id=%s',(admin,record['id']))).fetchone()
    record={**record,'revision':position['revision']}
    explicit=fill_command(record,side='sell',price='11',amount='22',occurredAt=datetime.now(UTC).isoformat())
    executed=await confirm_observation(client,profit['id'],await observation(client,admin,record,profit,headers,actualFill=explicit),headers)
    assert executed['order']['status']=='filled' and executed['cancelledSiblings']
    async with db.connection() as conn:
        rows=await(await conn.execute('SELECT id,status FROM internal_orders WHERE owner_id=%s AND id=ANY(%s::uuid[])',(admin,[profit['id'],sibling['id']]))).fetchall()
        assert {str(row['id']):row['status'] for row in rows}=={profit['id']:'filled',sibling['id']:'cancelled'}
        assert await(await conn.execute('SELECT row_to_json(t)::text AS value FROM trade_ledger t WHERE owner_id=%s ORDER BY created_at,id LIMIT 1',(admin,))).fetchone()==original_trade
        assert (await(await conn.execute('SELECT qty FROM portfolio_records WHERE owner_id=%s AND id=%s',(admin,record['id']))).fetchone())['qty']==0
    query=await client.get('/api/trading/orders/observations/operations/'+observe['requestId'],headers=headers)
    assert query.status_code==200 and query.json()==done


async def test_actual_record_mode_attachments_create_only_after_atomic_trade_receipt(client,admin,db):
    _account,record=await setup(client)
    headers=await native_headers(db,admin)
    raw=intent(admin,record,await context(client,headers),mode='record',tradedAt=datetime.now(UTC).isoformat(),attachments={'session':'REGULAR','tif':'gtc','takeProfit':{'percent':10,'orderType':'limit','fees':1},'stopLoss':{'percent':10,'orderType':'limit','fees':1}})
    proof=await client.post('/api/v2/account-assets/trading/preview',json=raw,headers=headers)
    assert proof.status_code==200,proof.text
    done=await client.post('/api/v2/account-assets/trading/submissions',json=raw,headers=headers)
    assert done.status_code==200,done.text
    result=done.json()['data'];assert result['state']=='completed'
    async with db.connection() as conn:
        family=await(await conn.execute('SELECT * FROM internal_order_families WHERE owner_id=%s',(admin,))).fetchone()
        assert family['parent_order_id'] is None and family['parent_trade_id'] is not None
        children=await(await conn.execute('SELECT * FROM internal_order_family_legs WHERE owner_id=%s',(admin,))).fetchall()
        assert len(children)==2
        assert (await(await conn.execute('SELECT count(*) AS n FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone())['n']==1


async def test_canonical_exact_price_preview_cannot_authorize_adjacent_decimal(client,admin,db):
    _account,record=await setup(client,amount='100000')
    headers=await native_headers(db,admin)
    raw=intent(admin,record,await context(client,headers),qty='0.00000001',price='100000000000.00000001',fees='0')
    proof=await client.post('/api/trading/order-intents/preview',json={'data':raw},headers=headers)
    assert proof.status_code==200,proof.text
    changed={**raw,'price':'100000000000.00000002','previewRevision':proof.json()['previewRevision']}
    refused=await client.post('/api/trading/order-intents/operations',json={'data':changed},headers=headers)
    assert refused.status_code==409,refused.text
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM internal_orders WHERE owner_id=%s',(admin,))).fetchone()


@pytest.mark.asyncio
async def test_native_explicit_deadline_is_retained_and_expires_without_financial_write(client,admin,db):
    _account,record=await setup(client)
    headers=await native_headers(db,admin)
    deadline=(datetime.now(UTC)-timedelta(seconds=5)).isoformat()
    order,_raw,_receipt=await create_intent(client,admin,record,headers,expiresAt=deadline)
    view=await context(client,headers)
    assert next(row for row in view['orders'] if row['id']==order['id'])['expiresAt']==deadline
    before=await ledger(db,admin)
    raw=await observation(client,admin,record,order,headers)
    done=await client.post('/api/v2/account-assets/trading/orders/'+order['id']+'/observations',json=raw,headers=headers)
    assert done.status_code==200,done.text
    assert done.json()['data']['data']['observationState']=='expired',done.text
    assert await ledger(db,admin)==before


@pytest.mark.asyncio
async def test_installed_source_global_unknown_keeps_owned_native_scope_usable(client,admin,app,old_pg,pg,tmp_path):  # noqa: F811
    from actual_fee_test_support import actual_case
    from test_trading_account_scope import new_account
    async with actual_case(client,admin,app,old_pg,pg,tmp_path) as (approved,_hosted,_grant,_exported,_source_account,source_fill,_confirmation):
        _account,record=await new_account(approved,datetime.now(UTC).isoformat())
        headers=await native_headers(app.state.db,admin)
        global_read=await approved.get('/api/v2/account-assets/trading',headers={**headers,'x-alcor-trading-context':'nullable-v1'})
        assert global_read.status_code==409,global_read.text
        scoped=await approved.get('/api/v2/account-assets/trading',params={'recordId':record['id']},headers={**headers,'x-alcor-trading-context':'nullable-v1'})
        assert scoped.status_code==200,scoped.text
        view=scoped.json()['data']
        assert view['projectionScope']['recordId']==record['id']
        raw=intent(admin,record,view)
        proof=await approved.post('/api/v2/account-assets/trading/preview',json=raw,headers=headers)
        assert proof.status_code==200,proof.text
        done=await approved.post('/api/v2/account-assets/trading/submissions',json={**raw,'previewRevision':proof.json()['data']['previewRevision']},headers=headers)
        assert done.status_code==200,done.text
        assert done.json()['data']['data']['items'][0]['recordId']==record['id']
        reread=await approved.get('/api/v2/account-assets/trading',params={'recordId':record['id']},headers={**headers,'x-alcor-trading-context':'nullable-v1'})
        excess=intent(admin,record,reread.json()['data'],qty=101,price=10)
        denied=await approved.post('/api/v2/account-assets/trading/preview',json=excess,headers=headers)
        assert denied.status_code==409,denied.text
        unknown=await approved.get('/api/v2/account-assets/trading',params={'recordId':source_fill['recordId']},headers={**headers,'x-alcor-trading-context':'nullable-v1'})
        assert unknown.status_code==409,unknown.text
        account_view=await approved.get('/api/v2/account-assets/trading',params={'brokerAccountId':_account},headers={**headers,'x-alcor-trading-context':'nullable-v1'})
        assert account_view.status_code==200,account_view.text
        assert account_view.json()['data']['projectionScope']['kind']=='owned_account'
        assert account_view.json()['data']['cash']['balancesByCurrency'] is None
        async with app.state.db.connection() as conn:
            broker=await(await conn.execute('SELECT revision FROM broker_accounts WHERE owner_id=%s AND id=%s',(admin,_account))).fetchone()
        target=intent(admin,record,account_view.json()['data'])
        target.pop('recordId');target.pop('recordRevision')
        target['buyTarget']={'brokerAccountId':_account,'brokerRevision':broker['revision'],'market':'US','code':'TARGETNEW','name':'Explicit new target'}
        planned=await approved.post('/api/v2/account-assets/trading/preview',json=target,headers=headers)
        assert planned.status_code==200,planned.text
        async with app.state.db.connection() as conn:
            assert not await(await conn.execute("SELECT 1 FROM portfolio_records WHERE owner_id=%s AND code='TARGETNEW'",(admin,))).fetchone()
        posted=await approved.post('/api/v2/account-assets/trading/submissions',json={**target,'targetRevision':planned.json()['data']['targetRevision'],'previewRevision':planned.json()['data']['previewRevision']},headers=headers)
        assert posted.status_code==200,posted.text
        child=posted.json()['data']['data']['items'][0]
        assert child['accountId']==_account
        account_view=await approved.get('/api/v2/account-assets/trading',params={'brokerAccountId':_account},headers={**headers,'x-alcor-trading-context':'nullable-v1'})
        filled={**target,'requestId':str(uuid4()),'snapshotRevision':account_view.json()['data']['snapshotRevision'],'mode':'record','tradedAt':datetime.now(UTC).isoformat(),
                'buyTarget':{**target['buyTarget'],'code':'TARGETFILL','name':'Explicit actual target'}}
        actual_proof=await approved.post('/api/v2/account-assets/trading/preview',json=filled,headers=headers)
        assert actual_proof.status_code==200,actual_proof.text
        actual_done=await approved.post('/api/v2/account-assets/trading/submissions',json={**filled,'targetRevision':actual_proof.json()['data']['targetRevision']},headers=headers)
        assert actual_done.status_code==200,actual_done.text
        assert actual_done.json()['data']['state']=='completed'
        assert actual_done.json()['data']['data']['items'][0]['code']=='TARGETFILL'
        async with app.state.db.connection() as conn:
            assert (await(await conn.execute('SELECT count(*) n FROM internal_orders WHERE owner_id=%s',(admin,))).fetchone())['n']==2


@pytest.mark.asyncio
@pytest.mark.parametrize('kind',['trigger_buy','trigger_sell','rebound_buy','rebound_sell'])
async def test_fixed_threshold_custom_intent_remains_original_without_quote_or_actual_fill(client,admin,db,kind):
    _account,record=await setup(client)
    headers=await native_headers(db,admin)
    deadline=(datetime.now(UTC)+timedelta(days=2)).date().isoformat()
    before=await ledger(db,admin)
    order,_raw,_receipt=await create_intent(client,admin,record,headers,orderType=kind,tif='custom',expiresAt=deadline,triggerPrice=9)
    view=await context(client,headers)
    row=next(row for row in view['orders'] if row['id']==order['id'])
    assert (row['orderType'],row['tif'],row['expiresAt'],float(row['triggerPrice']))==(kind,'custom',deadline,9)
    raw=await observation(client,admin,record,order,headers)
    done=await client.post('/api/v2/account-assets/trading/orders/'+order['id']+'/observations',json=raw,headers=headers)
    assert done.status_code==200,done.text
    assert done.json()['data']['data']['observationState']=='waiting',done.text
    assert await ledger(db,admin)==before


@pytest.mark.asyncio
async def test_licensed_saved_quote_triggers_four_conditions_without_real_fill_or_cash(client,admin,app):
    from dataclasses import asdict
    from zoneinfo import ZoneInfo

    from alcor_api.market_authority import Policy
    from alcor_api.market_calendar import Calendars
    from alcor_api.market_contract import Query, canonical
    from alcor_api.market_worker import claim, execute, schedule

    db=app.state.db
    _account,record=await setup(client)
    headers=await native_headers(db,admin)
    orders=[]
    for kind in ('trigger_buy','trigger_sell','rebound_buy','rebound_sell'):
        order,_raw,_receipt=await create_intent(client,admin,record,headers,orderType=kind,triggerPrice=11 if kind in ('trigger_buy','rebound_sell') else 9,session='EXTENDED')
        orders.append(order)
    authority=app.state.market_authority
    authority.policy_provider=None
    authority.policies=(Policy('intent-quotes','controlled_market','fixture-v1','controlled-endpoint','controlled-fingerprint',admin,'synthetic-license-v1',('latest',),('US',),True),)
    installed=await client.post('/api/market/sources',json={'request_id':str(uuid4()),'policy_id':'intent-quotes'})
    assert installed.status_code==200,installed.text
    revision=installed.json()['revision']
    now=datetime.now(UTC)
    hhmm=now.astimezone(ZoneInfo('America/New_York')).strftime('%H:%M')
    session='PRE' if '04:00'<=hhmm<'09:30' else 'REGULAR' if '09:30'<=hhmm<'16:00' else 'AFTER' if '16:00'<=hhmm<'20:00' else 'OVERNIGHT'
    query=Query('latest','US','AAPL',session=session)
    demand=await client.post('/api/market/demands',json={'request_id':str(uuid4()),'source_revision':revision,'query':asdict(query),'expected_revision':0})
    assert demand.status_code==200,demand.text
    await Calendars(db).ensure_builtin()
    local=now.astimezone(ZoneInfo('America/New_York'))
    trading_date=local.date()+timedelta(days=1) if session=='OVERNIGHT' and local.hour>=20 else local.date()
    async with db.connection() as conn:
        calendar=await(await conn.execute('SELECT d.status FROM market_calendar_active a JOIN market_calendar_days d ON d.revision=a.revision WHERE a.singleton AND d.market=%s AND d.day=%s',('US',trading_date))).fetchone()
    if not calendar or calendar['status'] not in ('trading','half_day'):
        pytest.skip('Current real source/session day has no verified trading calendar; never fabricate readiness')
    class ControlledTransport:
        fixture=True
        calls=0
        async def read(self,policy,query,cursor):
            self.calls+=1
            return canonical({'query':asdict(query),'licenseRevision':policy.license_revision,'facts':[{'at':datetime.now(UTC).isoformat(),'price':'10','currency':'USD','session':session,'cached':False}],'nextCursor':None}).encode(),'controlled_http_response_body'
    transport=ControlledTransport()
    assert await schedule(authority)==1
    task=await claim(db,uuid4())
    assert await execute(authority,task,transport)=='observed'
    before=await ledger(db,admin)
    for order in orders:
        raw=await observation(client,admin,record,order,headers)
        done=await client.post('/api/v2/account-assets/trading/orders/'+order['id']+'/observations',json=raw,headers=headers)
        assert done.status_code==200,done.text
        assert done.json()['data']['data']['observationState']=='needs_actual_fill',done.text
    assert await ledger(db,admin)==before and transport.calls==1


@pytest.mark.asyncio
async def test_japanese_actual_record_uses_explicit_yen_book_without_usd_defaults(client,admin,db):
    from test_cash_ledger import command as cash_command
    from test_cash_ledger import submit as cash_submit
    created=await client.post('/api/broker-accounts',json={'request_id':str(uuid4()),'name':'Synthetic yen account','provider_id':'ibkr','account_kind':'real','currency':'JPY','currencies':['JPY']})
    assert created.status_code==201,created.text
    account=created.json()['data']['id']
    await cash_submit(client,cash_command(account,currency='JPY',amount='10000',occurredAt=(datetime.now(UTC)-timedelta(seconds=1)).isoformat()))
    preview=await client.post('/api/portfolio/records/preview',json={'kind':'create','data':{'name':'Synthetic Japanese security','code':'7203','market':'JP','price':None,'qty':'0','cost':'0','group':'','note':'','brokerAccountId':account}})
    assert preview.status_code==200,preview.text
    done=await client.post('/api/portfolio/records/confirm',json={'previewId':preview.json()['previewId'],'requestId':str(uuid4())})
    assert done.status_code==200,done.text
    record=done.json()['record']
    headers=await native_headers(db,admin)
    raw=intent(admin,record,await context(client,headers),mode='record',price=100,tradedAt=datetime.now(UTC).isoformat())
    planned=await client.post('/api/v2/account-assets/trading/preview',json=raw,headers=headers)
    assert planned.status_code==200,planned.text
    assert planned.json()['data']['currency']=='JPY'
    posted=await client.post('/api/v2/account-assets/trading/submissions',json=raw,headers=headers)
    assert posted.status_code==200,posted.text
    async with db.connection() as conn:
        trade=await(await conn.execute('SELECT currency,settlement_currency,cash_delta FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone()
        assert trade['currency']==trade['settlement_currency']=='JPY'
        assert str(trade['cash_delta'])=='-201'


@pytest.mark.asyncio
async def test_mixed_real_simulated_owner_uses_explicit_record_scope_without_merging_books(client,admin,db):
    from test_cash_ledger import command as cash_command
    from test_cash_ledger import submit as cash_submit
    account,record=await setup(client)
    simulated=await client.post('/api/broker-accounts',json={'request_id':str(uuid4()),'name':'Separate simulated book','provider_id':'ibkr','account_kind':'simulated','currency':'USD','currencies':['USD']})
    assert simulated.status_code==201,simulated.text
    await cash_submit(client,cash_command(simulated.json()['data']['id'],accountKind='simulated',amount='1000000'))
    headers=await native_headers(db,admin)
    assert (await client.get('/api/v2/account-assets/trading',headers={**headers,'x-alcor-trading-context':'nullable-v1'})).status_code==409
    scoped=await client.get('/api/v2/account-assets/trading',params={'recordId':record['id']},headers={**headers,'x-alcor-trading-context':'nullable-v1'})
    assert scoped.status_code==200,scoped.text
    raw=intent(admin,record,scoped.json()['data'])
    over=await client.post('/api/v2/account-assets/trading/preview',json={**raw,'requestId':str(uuid4()),'qty':101},headers=headers)
    assert over.status_code==409,over.text
    proof=await client.post('/api/v2/account-assets/trading/preview',json=raw,headers=headers)
    assert proof.status_code==200,proof.text
    posted=await client.post('/api/v2/account-assets/trading/submissions',json={**raw,'previewRevision':proof.json()['data']['previewRevision']},headers=headers)
    assert posted.status_code==200,posted.text
    order=posted.json()['data']['data']['items'][0]
    assert order['accountId']==account and order['accountKind']=='real'
    before=await ledger(db,admin)
    scoped=await client.get('/api/v2/account-assets/trading',params={'recordId':record['id']},headers={**headers,'x-alcor-trading-context':'nullable-v1'})
    watch={'requestId':str(uuid4()),'accountId':admin,'snapshotRevision':scoped.json()['data']['snapshotRevision'],'orderRevision':order['revision'],'recordRevision':record['revision']}
    observed=await client.post('/api/v2/account-assets/trading/orders/'+order['id']+'/observations',json=watch,headers=headers)
    assert observed.status_code==200,observed.text
    assert observed.json()['data']['data']['observationState']=='waiting'
    assert await ledger(db,admin)==before
