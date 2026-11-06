import copy
import re
from datetime import UTC, datetime
from decimal import Decimal
from uuid import uuid4

import pytest
from alcor_api.native_app_auth import issue_grant
from test_trading import command as native_command
from test_trading import setup
from test_trading import submit as native_submit


async def native_headers(db,owner,scope='portfolio.read orders.read orders.write'):
    async with db.connection() as conn:
        user=await(await conn.execute('SELECT * FROM users WHERE id=%s',(owner,))).fetchone()
        pair=await issue_grant(conn,user,scope,'Synthetic old trade protocol')
    return {'authorization':'Bearer '+pair['access_token']}


def draft(owner,record,snapshot,**change):
    return {'accountId':owner,'recordId':record['id'],'recordRevision':record['revision'],'snapshotRevision':snapshot['snapshotRevision'],
      'side':'buy','mode':'record','orderType':'limit','qty':10,'price':10,'fees':1,'tif':'gtc','session':'REGULAR','tradedAt':'2026-09-01T12:00:00Z','note':'Synthetic legacy explicit actual entry',**change}


@pytest.mark.asyncio
@pytest.mark.parametrize('version',[1,2])
async def test_four_old_correction_methods_share_native_history_and_frozen_original_uuid_views(client,admin,db,version):
    _account,record=await setup(client,name='Legacy client existing manual account')
    headers=await native_headers(db,admin);prefix=f'/api/v{version}/account-assets'
    first=await client.get(prefix+'/trading',headers=headers);assert first.status_code==200,first.text
    initial=first.json()['data'];assert initial['cash']['nativeBalancesByCurrency']=={'USD':1000}
    same=await client.get(prefix+'/trading',headers=headers);assert same.json()['data']['snapshotRevision']==initial['snapshotRevision']
    body=draft(admin,record,initial)
    p=await client.post(prefix+'/trading/preview',json=body,headers=headers);assert p.status_code==200,p.text
    assert p.json()['data']['cashBefore']==1000 and p.json()['data']['cashAfter']==899
    submit={**body,'requestId':str(uuid4())}
    entered=await client.post(prefix+'/trading/submissions',json=submit,headers=headers);assert entered.status_code==200,entered.text
    entered=entered.json()['data'];assert entered['kind']=='submit_trade' and entered['state']=='completed'
    trade=entered['data']['items'][0]
    assert re.fullmatch('[0-9]{10}',trade['orderNo']) and trade['orderNoSource']=='platform_assigned' and trade['originalOrderNo'] is None
    assert trade['orderType']=='limit' and trade['tif']=='gtc' and trade['session']=='REGULAR' and trade['registrationContextKnown']
    duplicate=await client.post(prefix+'/trading/submissions',json=submit,headers=headers);assert duplicate.status_code==409 and duplicate.json()['code']==40901,duplicate.text
    current=(await client.get(prefix+'/trading',headers=headers)).json()['data']
    order=next(row for row in current['orders'] if row['id']==trade['id'])
    assert current['positions'][0]['cost']==10.1 and current['positions'][0]['rawRecord']['cost']==10.1
    amendment={'requestId':str(uuid4()),'accountId':admin,'snapshotRevision':current['snapshotRevision'],'recordId':record['id'],'recordRevision':order['recordRevision'],'action':'amend',
      'orders':[{'id':trade['id'],'revision':order['revision']}],'replacement':{'qty':10,'price':20,'fees':0,'tradedAt':body['tradedAt']}}
    preview=await client.post(prefix+'/trading/corrections/preview',json=amendment,headers=headers);assert preview.status_code==200,preview.text
    value=preview.json()['data'];assert value['feeBefore']==1 and value['feeAfter']==0 and value['cashDelta']==-99 and value['cashAfter']==800,value
    assert re.fullmatch(r'[0-9]{13}\.[a-f0-9]{64}',value['previewRevision'])
    payload={**amendment,'previewRevision':value['previewRevision']}
    posted=await client.post(prefix+'/trading/corrections',json=payload,headers=headers);assert posted.status_code==200,posted.text
    result=posted.json()['data'];assert result['kind']=='correct_trade' and result['state']=='completed'
    assert result['data']['snapshot']['cash']['nativeBalancesByCurrency']['USD']==800
    replacement=next(row for row in result['data']['items'] if row['status']=='filled')
    assert replacement['fees']==0 and replacement['feeSource']=='owner_recorded' and replacement['id']!=trade['id'] and replacement['orderNo']!=trade['orderNo']
    assert (await client.post(prefix+'/trading/corrections',json=payload,headers=headers)).json()['data']==result
    changed=copy.deepcopy(payload);changed['replacement']['fees']=1
    conflict=await client.post(prefix+'/trading/corrections',json=changed,headers=headers);assert conflict.status_code==409 and conflict.json()['code']==40901,conflict.text
    # A later ordinary old-client registration cannot alter historical views.
    latest=(await client.get(prefix+'/trading',headers=headers)).json()['data']
    current_record={'id':record['id'],'revision':replacement['recordRevision']}
    sold=draft(admin,current_record,latest,side='sell',qty=1,price=30,fees=0,tradedAt=datetime.now(UTC).isoformat())
    sp=await client.post(prefix+'/trading/preview',json=sold,headers=headers);assert sp.status_code==200,sp.text
    sale=await client.post(prefix+'/trading/submissions',json={**sold,'requestId':str(uuid4())},headers=headers);assert sale.status_code==200,sale.text
    assert (await client.get(prefix+'/operations/'+amendment['requestId'],headers=headers)).json()['data']==result
    assert (await client.get(prefix+'/operations/'+submit['requestId'],headers=headers)).json()['data']==entered
    async with db.connection() as conn:
        original=await(await conn.execute('SELECT fees,cash_delta FROM trade_ledger WHERE id=%s',(trade['id'],))).fetchone()
        assert original=={'fees':Decimal(1),'cash_delta':Decimal(-101)}
        assert (await(await conn.execute("SELECT sum(amount) total FROM cash_ledger_entries WHERE kind='trade_correction'")).fetchone())['total']==Decimal(-99)
        assert (await(await conn.execute('SELECT count(*) n FROM trade_amendments')).fetchone())['n']==1


@pytest.mark.asyncio
async def test_native_unknown_context_is_not_filled_and_old_implicit_preview_cannot_cross_native_sessions(client,admin,db):
    _account,record=await setup(client,name='Strict context unknown')
    entered,_=await native_submit(client,native_command(record,occurredAt='2026-09-01T12:00:00Z'))
    one=await native_headers(db,admin);prefix='/api/v2/account-assets'
    async with db.connection() as conn:
        before=(await(await conn.execute('SELECT count(*) n FROM trade_presentation_ids')).fetchone())['n']
    strict=await client.get(prefix+'/trading',headers=one);assert strict.status_code==409,strict.text
    typed=await client.get(prefix+'/trading',headers={**one,'x-alcor-trading-context':'nullable-v1'});assert typed.status_code==200,typed.text
    snapshot=typed.json()['data'];order=snapshot['orders'][0]
    assert not snapshot['orderContextComplete'] and snapshot['unknownOrderContextIds']==[entered['tradeId']]
    assert order['orderType'] is None and order['tif'] is None and order['session'] is None and order['registrationContextSource']=='unknown'
    assert re.fullmatch('[0-9]{10}',order['orderNo']) and order['orderNoSource']=='platform_assigned'
    assert snapshot['cash']['nativeBalancesByCurrency']=={'USD':979} and order['fees']==1
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_presentation_ids')).fetchone())['n']==before
        assert not await(await conn.execute('SELECT 1 FROM trade_registration_contexts')).fetchone()
    current=(await client.get('/api/portfolio/records/'+record['id'])).json()['record']
    body=draft(admin,current,snapshot,qty=1,price=10,fees=0,tradedAt='2026-09-02T12:00:00Z')
    p=await client.post(prefix+'/trading/preview',json=body,headers=one);assert p.status_code==200,p.text
    two=await native_headers(db,admin)
    rejected={**body,'requestId':str(uuid4())}
    denial=await client.post(prefix+'/trading/submissions',json=rejected,headers=two)
    assert denial.status_code==409,denial.text
    receipt=await client.get(prefix+'/operations/'+rejected['requestId'],headers=one)
    assert receipt.status_code==200 and receipt.json()['data']['state']=='failed',receipt.text
    # The original session's preview remains usable for a fresh UUID after the
    # other session received its own durable failed result; no financial retry.
    posted=await client.post(prefix+'/trading/submissions',json={**body,'requestId':str(uuid4())},headers=one)
    assert posted.status_code==200 and posted.json()['data']['state']=='completed',posted.text
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==2


@pytest.mark.asyncio
async def test_context_and_frozen_view_python_failure_rolls_back_native_cash_position_and_display_identity(client,admin,db,monkeypatch):
    from alcor_api.legacy_trade_services import LegacyRecordedTrading
    _account,record=await setup(client,name='Context atomicity')
    headers=await native_headers(db,admin);prefix='/api/v1/account-assets'
    snapshot=(await client.get(prefix+'/trading',headers=headers)).json()['data']
    body=draft(admin,record,snapshot)
    proof=await client.post(prefix+'/trading/preview',json=body,headers=headers);assert proof.status_code==200,proof.text
    original=LegacyRecordedTrading.decorate_receipt
    async def fail_after_context(self,conn,who,data,receipt):
        await original(self,conn,who,data,receipt)
        raise RuntimeError('synthetic view serialization interruption')
    monkeypatch.setattr(LegacyRecordedTrading,'decorate_receipt',fail_after_context)
    request={**body,'requestId':str(uuid4())}
    stopped=await client.post(prefix+'/trading/submissions',json=request,headers=headers)
    assert stopped.status_code==503,stopped.text
    receipt=await client.get(prefix+'/operations/'+request['requestId'],headers=headers)
    assert receipt.status_code==200 and receipt.json()['data']['state']=='failed',receipt.text
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM trade_ledger')).fetchone()
        assert not await(await conn.execute('SELECT 1 FROM trade_registration_contexts')).fetchone()
        assert not await(await conn.execute('SELECT 1 FROM trade_presentation_ids')).fetchone()
        assert not await(await conn.execute("SELECT 1 FROM cash_ledger_entries WHERE kind<>'opening'")).fetchone()
        record_row=await(await conn.execute('SELECT qty,cost FROM portfolio_records WHERE id=%s',(record['id'],))).fetchone()
        assert record_row=={'qty':Decimal(0),'cost':Decimal(0)}
    again=await client.post(prefix+'/trading/submissions',json=request,headers=headers)
    assert again.status_code==409 and again.json()['code']==40901,again.text


@pytest.mark.asyncio
async def test_old_protocol_scope_body_budget_and_estimated_fee_never_becomes_actual(client,admin,db):
    account,record=await setup(client,name='Legacy guards')
    read=await native_headers(db,admin,'portfolio.read orders.read');write=await native_headers(db,admin);prefix='/api/v2/account-assets'
    snapshot=(await client.get(prefix+'/trading',headers=write)).json()['data'];body=draft(admin,record,snapshot)
    assert (await client.post(prefix+'/trading/preview',json=body,headers=read)).status_code==403
    for changes in ({'accountId':'u-another-owner'},{'qty':True},{'price':0.000000001}):
        denied=await client.post(prefix+'/trading/preview',json={**body,**changes},headers=write)
        assert denied.status_code in (400,404),denied.text
    fee={'source':'rule_calculated','brokerAccountId':account,'providerId':'longbridge','confirmed':True}
    estimated=await client.post(prefix+'/trading/preview',json={**body,'feeInput':fee},headers={**write,'x-alcor-trade-fees':'details-v1'})
    assert estimated.status_code==409,estimated.text
    assert (await client.post(prefix+'/trading/preview',content=b' '*65537,headers={**write,'content-type':'application/json'})).status_code==413
    assert (await client.post(prefix+'/trading/corrections/preview',content=b' '*131073,headers={**write,'content-type':'application/json'})).status_code==413
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM trade_ledger')).fetchone()
        assert not await(await conn.execute('SELECT 1 FROM trade_registration_contexts')).fetchone()
