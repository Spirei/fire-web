"""Synthetic old flat HTTP/workbook workflows over the shared ledger only."""
import asyncio
import hashlib
import io
import json
import zipfile
from decimal import Decimal
from uuid import uuid4

import httpx
import pytest
from alcor_api.cli import create_user
from alcor_api.legacy_order_workbooks import HEADERS, build_xlsx, read_sheet
from alcor_api.legacy_trading_snapshot import fee_transport
from test_legacy_trade_corrections import native_headers
from test_trading import setup


def fill(record, **changes):
    return dict(requestId=str(uuid4()),recordId=record['id'],side='buy',mode='record',qty='2',price='10',fees='1',tradedAt='2026-09-01T12:00:00Z',tif='gtc',session='REGULAR',**changes)


def workbook(**changes):
    row={'订单状态':'已成交','市场':'美国','股票代码':'AAPL','方向':'买入','币种':'USD','委托时间':'2026-09-01T12:00:00Z','成交均价':'10','成交数量':'2','成交金额':'20','费用':'1',**changes}
    headers=HEADERS+['费用']
    return build_xlsx([('订单',[headers,[row.get(k,'') for k in headers]])])


@pytest.mark.asyncio
@pytest.mark.parametrize('version',[1,2])
async def test_old_flat_record_crud_concurrent_uuid_retains_original(client,admin,db,version):
    _,record=await setup(client)
    headers=await native_headers(db,admin);prefix=f'/api/v{version}/orders'
    body=fill(record)
    requests=await asyncio.gather(*[client.post(prefix,json=body,headers=headers) for _ in range(2)])
    assert [r.status_code for r in requests]==[200,200],[r.text for r in requests]
    assert requests[0].json()==requests[1].json()
    trade=requests[0].json()['data']['order'];tid=trade['id']
    listed=await client.get(prefix,headers=headers)
    assert listed.status_code==200,listed.text
    assert listed.json()['data']['settledOnRead'] is False
    wrong_units=await client.put(prefix+'/'+tid,json={**body,'requestId':str(uuid4()),'settlementAmount':'23'},headers=headers)
    assert wrong_units.status_code in (400,409),wrong_units.text
    edit={**body,'requestId':str(uuid4()),'price':'11'}
    amended=await client.put(prefix+'/'+tid,json=edit,headers=headers)
    assert amended.status_code==200,amended.text
    assert (await client.put(prefix+'/'+tid,json=edit,headers=headers)).json()==amended.json()
    async with db.connection() as conn:
        original=await(await conn.execute('SELECT amount,fees FROM trade_ledger WHERE id=%s',(tid,))).fetchone()
        assert original=={'amount':Decimal(20),'fees':Decimal(1)}
        assert (await(await conn.execute('SELECT count(*) n FROM trade_amendments WHERE owner_id=%s',(admin,))).fetchone())['n']==1
    changed=await client.post(prefix,json={**body,'qty':'3'},headers=headers)
    assert changed.status_code==409,changed.text
    receipt=await client.get('/api/trading/history/operations/'+body['requestId'],headers=headers)
    assert receipt.status_code==200 and fee_transport(receipt.json()['result'],False)==requests[0].json()['data']
    replacement=amended.json()['data']['order']['id']
    removed=await client.request('DELETE',prefix+'/'+replacement,json={'requestId':str(uuid4())},headers=headers)
    assert removed.status_code==200,removed.text
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone())['n']==1
    readonly=await native_headers(db,admin,scope='portfolio.read orders.read')
    denied=await client.post(prefix,json={**body,'requestId':str(uuid4())},headers=readonly)
    assert denied.status_code in (401,403),denied.text


@pytest.mark.asyncio
async def test_workbook_explicit_preview_submit_original_replay_and_currency_evidence(client,admin,db):
    _,record=await setup(client)
    headers=await native_headers(db,admin)
    raw=workbook();mappings=json.dumps({'1':{'recordId':record['id']}})
    preview=await client.post('/api/trading/history/import/preview',headers=headers,files={'file':('synthetic.xlsx',raw)},data={'mappings':mappings})
    assert preview.status_code==200,preview.text
    plan=preview.json();assert plan['rows'][0]['state']=='ready' and plan['rows'][0]['fees']=='1'
    assert plan['sourceSha256']==hashlib.sha256(raw).hexdigest()
    original=await client.get('/api/trading/history/import/sources/'+plan['sourceId']+'/original',headers=headers)
    assert original.status_code==200 and original.content==raw
    command={'requestId':str(uuid4()),'previewId':plan['previewId'],'confirm':True}
    submitted=await client.post('/api/trading/history/import/submissions',json=command,headers=headers)
    assert submitted.status_code==200,submitted.text
    assert submitted.json()['imported']==1 and submitted.json()['partial'] is False
    assert (await client.post('/api/trading/history/import/submissions',json=command,headers=headers)).json()==submitted.json()
    assert (await client.get('/api/trading/history/import/operations/'+command['requestId'],headers=headers)).json()==submitted.json()
    export=await client.get('/api/v1/orders/export?scope=all&detail=1',headers=headers)
    assert export.status_code==200,export.text
    rows=read_sheet(export.content);assert rows[0]['成交数量']=='2' and rows[0]['币种']=='USD'
    bad=await client.post('/api/trading/history/import/preview',headers=headers,files={'file':('wrong-currency.xlsx',workbook(币种='EUR'))},data={'mappings':mappings})
    assert bad.status_code==200 and bad.json()['rows'][0]['state']=='blocked',bad.text
    assert '币种' in bad.json()['rows'][0]['reason']
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone())['n']==1


def test_workbook_exact_decimal_lexeme_and_entity_guard():
    exact='0.12345678';raw=workbook(成交均价=exact,成交数量='1',成交金额=exact)
    assert read_sheet(raw)[0]['成交均价']==exact
    with zipfile.ZipFile(io.BytesIO(raw)) as source:
        files={name:source.read(name) for name in source.namelist()}
    files['xl/worksheets/sheet1.xml']=files['xl/worksheets/sheet1.xml'].decode().encode('utf-16')
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as target:
        for name,value in files.items():target.writestr(name,value)
    with pytest.raises(Exception) as raised:read_sheet(out.getvalue())
    assert 'UTF-8' in str(raised.value) or '有效' in str(raised.value)


@pytest.mark.asyncio
async def test_pending_put_preserves_original_gtc_extended_and_attachments_then_patch_cancel(client,admin,db):
    _,record=await setup(client)
    headers=await native_headers(db,admin)
    snapshot=(await client.get('/api/v2/account-assets/trading',headers=headers)).json()['data']
    data={'requestId':str(uuid4()),'accountId':admin,'recordId':record['id'],'recordRevision':record['revision'],'snapshotRevision':snapshot['snapshotRevision'],'side':'buy','mode':'order','orderType':'limit','qty':'2','price':'10','fees':'1','tif':'gtc','session':'EXTENDED',
          'attachments':{'session':'EXTENDED','tif':'gtc','takeProfit':{'percent':'5.12345678','orderType':'market','fees':'0'}}}
    preview=await client.post('/api/trading/order-intents/preview',json={'data':data})
    assert preview.status_code==200,preview.text
    submitted=await client.post('/api/trading/order-intents/operations',json={'data':{**data,'previewRevision':preview.json()['previewRevision']}})
    assert submitted.status_code==200,submitted.text
    async with db.connection() as conn:
        before=await(await conn.execute('SELECT * FROM internal_order_contexts WHERE owner_id=%s ORDER BY order_revision DESC LIMIT 1',(admin,))).fetchone()
    oid=str(before['order_id'])
    edit={'requestId':str(uuid4()),'side':'buy','qty':'2','price':'11','fees':'1'}
    amended=await client.put('/api/v1/orders/'+oid,json=edit,headers=headers)
    assert amended.status_code==200,amended.text
    async with db.connection() as conn:
        after=await(await conn.execute('SELECT draft FROM internal_order_contexts WHERE owner_id=%s AND order_id=%s ORDER BY order_revision DESC LIMIT 1',(admin,oid))).fetchone()
        assert after['draft']['tif']=='gtc' and after['draft']['session']=='EXTENDED'
        assert after['draft']['attachmentsExact']==before['draft']['attachmentsExact']
        assert not await(await conn.execute('SELECT 1 FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone()
    cancelled=await client.patch('/api/v1/orders/'+oid,json={'requestId':str(uuid4())},headers=headers)
    assert cancelled.status_code==200,cancelled.text
    listed=await client.get('/api/v2/orders',headers=headers)
    assert next(row for row in listed.json()['data']['orders'] if row['id']==oid)['status']=='cancelled'


@pytest.mark.asyncio
async def test_old_workbook_apply_requires_plan_and_foreign_owner_cannot_read_source_or_receipt(client,admin,db,app,settings):
    _,record=await setup(client)
    headers=await native_headers(db,admin);raw=workbook()
    no_plan=await client.post('/api/v1/orders/import',headers=headers,files={'file':('synthetic.xlsx',raw)},data={'requestId':str(uuid4())})
    assert no_plan.status_code==409,no_plan.text
    preview=await client.post('/api/v1/orders/import?dryRun=1',headers=headers,files={'file':('synthetic.xlsx',raw)},data={'mappings':json.dumps({'1':{'recordId':record['id']}})})
    assert preview.status_code==200,preview.text
    rid=str(uuid4())
    applied=await client.post('/api/v1/orders/import',headers=headers,files={'file':('synthetic.xlsx',raw)},data={'requestId':rid})
    assert applied.status_code==200 and applied.json()['imported']==1,applied.text
    replay=await client.post('/api/v1/orders/import',headers=headers,files={'file':('synthetic.xlsx',raw)},data={'requestId':rid})
    assert replay.status_code==200 and replay.json()==applied.json(),replay.text
    await create_user(settings,'SyntheticFlatForeign','Synthetic9Pass')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as other:
        login=await other.post('/api/session/login',json={'login':'SyntheticFlatForeign','password':'Synthetic9Pass'})
        assert login.status_code==200,login.text
        other.headers['x-csrf-token']=login.json()['csrf']
        for path in ('/api/trading/history/import/sources/'+preview.json()['sourceId']+'/original','/api/trading/history/import/operations/'+rid):
            denied=await other.get(path)
            assert denied.status_code==404,denied.text
    duplicate=await client.post('/api/trading/history/import/preview',headers=headers,files={'file':('same.xlsx',raw)})
    assert duplicate.status_code==200 and duplicate.json()['rows'][0]['state']=='duplicate',duplicate.text


@pytest.mark.asyncio
async def test_connect_workbook_requires_explicit_net_cny_and_preserves_ledger_currency(client,admin,db):
    _,_record=await setup(client,market='HK',account_market='CN',code='00700',currency='CNY')
    headers=await native_headers(db,admin)
    raw=workbook(市场='香港',股票代码='00700',币种='HKD',账户归属='中国',结算币种='CNY',实际结算净额='19.12345678')
    preview=await client.post('/api/trading/history/import/preview',headers=headers,files={'file':('connect.xlsx',raw)})
    assert preview.status_code==200,preview.text
    assert preview.json()['rows'][0]['state']=='ready',preview.text
    assert preview.json()['rows'][0]['settlementAmount']=='19.12345678'
    submitted=await client.post('/api/trading/history/import/submissions',headers=headers,json={'requestId':str(uuid4()),'previewId':preview.json()['previewId'],'confirm':True})
    assert submitted.status_code==200 and submitted.json()['imported']==1,submitted.text
    async with db.connection() as conn:
        trade=await(await conn.execute('SELECT currency,settlement_currency,settlement_amount,cash_delta FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone()
        assert trade=={'currency':'HKD','settlement_currency':'CNY','settlement_amount':Decimal('19.12345678'),'cash_delta':Decimal('-19.12345678')}
    exported=await client.get('/api/v1/orders/export',headers=headers)
    assert exported.status_code==200,exported.text
    row=read_sheet(exported.content)[0]
    assert row['结算币种']=='CNY' and row['实际结算净额']=='19.12345678'
    duplicate=await client.post('/api/trading/history/import/preview',headers=headers,files={'file':('connect.xlsx',raw)})
    assert duplicate.status_code==200 and duplicate.json()['rows'][0]['state']=='duplicate',duplicate.text
    changed=workbook(市场='香港',股票代码='00700',币种='HKD',账户归属='中国',结算币种='CNY',实际结算净额='18')
    rejected=await client.post('/api/trading/history/import/preview',headers=headers,files={'file':('changed.xlsx',changed)})
    assert rejected.status_code==200 and rejected.json()['rows'][0]['state']=='blocked',rejected.text


@pytest.mark.asyncio
async def test_workbook_conflicting_same_fill_blocks_whole_security_group_without_partial_ledger(client,admin,db):
    await setup(client)
    headers=await native_headers(db,admin)
    base=read_sheet(workbook())[0];conflict={**base,'费用':'2'}
    columns=HEADERS+['费用']
    raw=build_xlsx([('订单',[columns,*[[row.get(key,'') for key in columns] for row in (base,conflict)]])])
    preview=await client.post('/api/trading/history/import/preview',headers=headers,files={'file':('conflict.xlsx',raw)})
    assert preview.status_code==200,preview.text
    assert [row['state'] for row in preview.json()['rows']]==['blocked','blocked'],preview.text
    submitted=await client.post('/api/trading/history/import/submissions',headers=headers,json={'requestId':str(uuid4()),'previewId':preview.json()['previewId'],'confirm':True})
    assert submitted.status_code==200 and submitted.json()['imported']==0,submitted.text
    assert submitted.json()['partial'] is True and submitted.json()['skipped']==2
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone()
        assert not await(await conn.execute('SELECT 1 FROM legacy_order_import_links WHERE owner_id=%s',(admin,))).fetchone()


@pytest.mark.asyncio
async def test_retained_workbook_hash_or_parse_mismatch_never_admits_trade(client,admin,db):
    await setup(client)
    headers=await native_headers(db,admin)
    preview=await client.post('/api/trading/history/import/preview',headers=headers,files={'file':('synthetic.xlsx',workbook())})
    assert preview.status_code==200,preview.text
    for failure in ('hash','parsed_rows'):
        source_id,preview_id,rid=uuid4(),uuid4(),str(uuid4())
        async with db.connection() as conn:
            await conn.execute('''INSERT INTO legacy_order_import_sources(owner_id,id,filename,sha256,raw,rows,principal,origin_instance)
                SELECT owner_id,%s,filename,CASE WHEN %s THEN repeat('0',64) ELSE sha256 END,raw,
                  CASE WHEN %s THEN '[]'::jsonb ELSE rows END,principal,origin_instance
                FROM legacy_order_import_sources WHERE owner_id=%s AND id=%s''',
                (source_id,failure=='hash',failure=='parsed_rows',admin,preview.json()['sourceId']))
            await conn.execute('''INSERT INTO legacy_order_import_previews(owner_id,id,source_id,snapshot_revision,mappings,result,principal)
                SELECT owner_id,%s,%s,snapshot_revision,mappings,result,principal
                FROM legacy_order_import_previews WHERE owner_id=%s AND id=%s''',
                (preview_id,source_id,admin,preview.json()['previewId']))
        rejected=await client.post('/api/trading/history/import/submissions',headers=headers,json={'requestId':rid,'previewId':str(preview_id),'confirm':True})
        assert rejected.status_code==409,rejected.text
        async with db.connection() as conn:
            assert not await(await conn.execute('SELECT 1 FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone()
            assert not await(await conn.execute('SELECT 1 FROM legacy_order_import_operations WHERE owner_id=%s AND request_id=%s',(admin,rid))).fetchone()


@pytest.mark.asyncio
@pytest.mark.parametrize('deadline',['2090-01-01T01:02:03+00:00','2090-01-01'])
async def test_flat_custom_deadline_is_preserved_on_amend_not_replaced_by_gtc(client,admin,db,deadline):
    _,record=await setup(client)
    headers=await native_headers(db,admin)
    body={**fill(record),'requestId':str(uuid4()),'mode':'order','orderType':'limit','tif':'custom','expiresAt':deadline}
    created=await client.post('/api/v2/orders',headers=headers,json=body)
    assert created.status_code==200,created.text
    oid=created.json()['data']['order']['id']
    assert created.json()['data']['order']['expiresAt']==deadline
    amended=await client.put('/api/v2/orders/'+oid,headers=headers,json={'requestId':str(uuid4()),'side':'buy','qty':2,'price':11,'fees':1})
    assert amended.status_code==200,amended.text
    assert amended.json()['data']['order']['expiresAt']==deadline
    async with db.connection() as conn:
        draft=await(await conn.execute('SELECT draft FROM internal_order_contexts WHERE owner_id=%s AND order_id=%s ORDER BY order_revision DESC LIMIT 1',(admin,oid))).fetchone()
        assert draft['draft']['expiresAt']==deadline
        assert not await(await conn.execute('SELECT 1 FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone()


@pytest.mark.asyncio
@pytest.mark.parametrize('version',[1,2])
async def test_flat_connect_explicit_net_amend_delete_retains_source_and_cny_cash_units(client,admin,db,version):
    _,record=await setup(client,market='HK',account_market='CN',code='00700',currency='CNY')
    headers=await native_headers(db,admin);prefix=f'/api/v{version}/orders'
    body={**fill(record),'settlementAmount':'19'}
    created=await client.post(prefix,json=body,headers=headers)
    assert created.status_code==200,created.text
    tid=created.json()['data']['order']['id']
    missing=await client.put(prefix+'/'+tid,json={**body,'requestId':str(uuid4()),'settlementAmount':None,'price':'12'},headers=headers)
    assert missing.status_code in (400,409),missing.text
    change={**body,'requestId':str(uuid4()),'price':'12','settlementAmount':'23'}
    amended=await client.put(prefix+'/'+tid,json=change,headers=headers)
    assert amended.status_code==200,amended.text
    assert (await client.put(prefix+'/'+tid,json=change,headers=headers)).json()==amended.json()
    replacement=amended.json()['data']['order']
    assert replacement['settlementCurrency']=='CNY' and replacement['settlementAmount']==23
    async with db.connection() as conn:
        original=await(await conn.execute('SELECT currency,settlement_currency,settlement_amount,cash_delta FROM trade_ledger WHERE owner_id=%s AND id=%s',(admin,tid))).fetchone()
        assert original=={'currency':'HKD','settlement_currency':'CNY','settlement_amount':Decimal(19),'cash_delta':Decimal(-19)}
        cash=await(await conn.execute('SELECT currency,sum(amount) total FROM cash_ledger_entries WHERE owner_id=%s GROUP BY currency',(admin,))).fetchall()
        assert cash==[{'currency':'CNY','total':Decimal(977)}]
    removed=await client.request('DELETE',prefix+'/'+replacement['id'],json={'requestId':str(uuid4())},headers=headers)
    assert removed.status_code==200,removed.text
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone())['n']==1
        assert (await(await conn.execute('SELECT sum(amount) total FROM cash_ledger_entries WHERE owner_id=%s AND currency=%s',(admin,'CNY'))).fetchone())['total']==Decimal(1000)


@pytest.mark.asyncio
@pytest.mark.parametrize('order_type',['trigger_buy','trigger_sell','rebound_buy','rebound_sell'])
async def test_old_flat_conditional_intents_remain_explicit_non_broker_declarations(client,admin,db,order_type):
    _,record=await setup(client)
    headers=await native_headers(db,admin)
    body={**fill(record),'mode':'order','orderType':order_type,'triggerPrice':'10.12345678'}
    created=await client.post('/api/v1/orders',headers=headers,json=body)
    assert created.status_code==200,created.text
    oid=created.json()['data']['order']['id']
    assert created.json()['data']['pending'] is True
    amended=await client.put('/api/v1/orders/'+oid,headers=headers,json={'requestId':str(uuid4()),'side':'buy','qty':2,'price':11,'fees':1})
    assert amended.status_code==200,amended.text
    assert amended.json()['data']['order']['orderType']==order_type
    async with db.connection() as conn:
        context=await(await conn.execute('SELECT draft FROM internal_order_contexts WHERE owner_id=%s AND order_id=%s ORDER BY order_revision DESC LIMIT 1',(admin,oid))).fetchone()
        assert Decimal(str(context['draft']['triggerPrice']))==Decimal('10.12345678')
        assert not await(await conn.execute('SELECT 1 FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone()
    cancelled=await client.patch('/api/v1/orders/'+oid,headers=headers,json={'requestId':str(uuid4())})
    assert cancelled.status_code==200,cancelled.text


@pytest.mark.asyncio
async def test_recorded_conditional_declaration_preserves_original_metadata_without_claiming_trigger(client,admin,db):
    _,record=await setup(client)
    headers=await native_headers(db,admin)
    body={**fill(record),'orderType':'trigger_buy','tif':'custom','expiresAt':'2026-09-30','triggerPrice':'10.12345678'}
    entered=await client.post('/api/v1/orders',json=body,headers=headers)
    assert entered.status_code==200,entered.text
    trade=entered.json()['data']['order']
    assert trade['orderType']=='trigger_buy' and trade['tif']=='custom'
    assert trade['expiresAt']=='2026-09-30' and Decimal(str(trade['triggerPrice']))==Decimal('10.12345678')
    assert trade['conditionExecutionVerified'] is False
    async with db.connection() as conn:
        context=await(await conn.execute('SELECT context FROM trade_registration_contexts WHERE owner_id=%s AND trade_id=%s',(admin,trade['id']))).fetchone()
        assert context['context']['expiresAt']=='2026-09-30'
        assert context['context']['conditionExecutionVerified'] is False
