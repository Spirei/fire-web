from decimal import Decimal
from uuid import uuid4

import pytest
from test_trading import command as trade_command
from test_trading import setup
from test_trading import submit as trade_submit

P='/api/financing/policy'


def evidence():return {'kind':'owner_statement','statement':'I verified that this borrowing and paid fees actually happened in this account. I am recording my internal book only.','actualBorrowingConfirmed':True,'ledgerOnlyConfirmed':True}


async def command(client,owner,*,kind='simulated',currency='USD',limit='20'):
    h=await client.get(P,params={'accountKind':kind});assert h.status_code==200,h.text
    return {'requestId':str(uuid4()),'targetUserId':owner,'accountKind':kind,'revision':h.json()['revision'],'policy':{'currency':currency,'limit':limit,'initialMargin':None,'maintenanceMargin':None}}


async def complete(client,data):
    p=await client.post(P+'/preview',json=data);assert p.status_code==200,p.text
    result=await client.post(P+'/operations',json={'data':data,'preview':p.json()['previewRevision']});assert result.status_code==200 and result.json()['state']=='completed',result.text
    return result.json()


@pytest.mark.asyncio
async def test_explicit_actual_financed_buy_keeps_signed_cash_and_policy_does_not_reject_an_occurred_fill(client,admin,db):
    account,record=await setup(client,name='Financing actual observation',account_kind='simulated')
    policy=await complete(client,await command(client,admin,limit='1'))
    body=trade_command(record,quantity='100',price='11',amount='1100',fees='1',allowFinancing=True,financingConfirmation=evidence())
    result,_preview=await trade_submit(client,body)
    assert result['cashAfter']=='-101' and result['financing']['debtAfter']=='101' and result['financing']['externalFlow']==result['financing']['income']=='0'
    read=await client.get(P,params={'accountKind':'simulated'});assert read.status_code==200,read.text
    assert read.json()['debt']['debt']=='101' and read.json()['debt']['debtKnown']
    assert (await client.get(P+'/operations/'+policy['requestId'])).json()==policy
    current=(await client.get('/api/portfolio/records/'+record['id'])).json()['record']
    sale,_=await trade_submit(client,trade_command(current,side='sell',quantity='5',price='10',amount='50',fees='0'))
    assert sale['cashAfter']=='-51'
    cash=(await client.get('/api/cash/accounts/'+account)).json()['currencies'][0]
    assert cash['complete'] and Decimal(cash['balance'])==-51
    lowered=await client.post(P+'/preview',json=await command(client,admin,limit='50'))
    assert lowered.status_code==409,lowered.text
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM cash_financing_confirmations')).fetchone())['n']==1
    from datetime import UTC, datetime

    from test_cash_ledger import command as cash_command
    from test_cash_ledger import submit as cash_submit
    created=await client.post('/api/broker-accounts',json={'request_id':str(uuid4()),'name':'Positive cash stays in separate account','provider_id':None,'account_kind':'simulated','currency':'USD','currencies':['USD']});assert created.status_code==201,created.text
    other=created.json()['data']['id']
    await cash_submit(client,cash_command(other,amount='1000',accountKind='simulated',occurredAt=datetime.now(UTC).isoformat()))
    net=(await client.get(P,params={'accountKind':'simulated'})).json()['debt']
    assert net['debt']=='0' and not net['brokerGrossLoanKnown'] and net['basisLabel']=='同身份同币种净现金负值'
    still=(await client.get('/api/cash/accounts/'+account)).json()['currencies'][0]
    assert still['balance']=='-51' and (await client.get('/api/cash/accounts/'+other)).json()['currencies'][0]['balance']=='1000'
    async with db.connection() as conn:assert not await(await conn.execute("SELECT 1 FROM cash_ledger_entries WHERE kind='allocation'")).fetchone()


@pytest.mark.asyncio
@pytest.mark.parametrize('version',[1,2])
async def test_old_policy_get_post_are_exact_scoped_cas_uuid_and_one_shared_budget(client,admin,db,version):
    import hashlib
    import json

    from test_legacy_trade_corrections import native_headers
    _account,_record=await setup(client,name='Old financing real book')
    headers=await native_headers(db,admin,'portfolio.read portfolio.write');path=f'/api/v{version}/account-assets/financing-policy'
    old=await client.get(path,headers=headers);assert old.status_code==200,old.text
    assert old.json()['data']['revision']==hashlib.sha256(b'null').hexdigest() and old.json()['data']['policy'] is None
    body={'requestId':str(uuid4()),'revision':old.json()['data']['revision'],'policy':{'currency':'JPY','limit':100,'initialMargin':20,'maintenanceMargin':10}}
    changed=await client.post(path,json=body,headers=headers);assert changed.status_code==200,changed.text
    result=changed.json()['data'];assert result['policy']==body['policy']
    expected=hashlib.sha256(json.dumps(body['policy'],separators=(',',':')).encode()).hexdigest();assert result['revision']==expected
    async with db.connection() as conn:assert (await(await conn.execute('SELECT count FROM financing_rate_windows')).fetchone())['count']==1
    assert (await client.post(path,json=body,headers=headers)).json()==changed.json()
    other={**body,'policy':{**body['policy'],'limit':101}}
    assert (await client.post(path,json=other,headers=headers)).status_code==409
    assert (await client.get(f'/api/v{version}/account-assets/operations/'+body['requestId'],headers=headers)).json()['data']==result
    assert (await client.get(path+'?x=1',headers=headers)).status_code==400
    assert (await client.post(path,content=b' '*8193,headers={**headers,'content-type':'application/json'})).status_code==413
    await setup(client,name='Separate simulated book',account_kind='simulated')
    assert (await client.get(path,headers=headers)).status_code==409
    typed=await client.get(path,headers={**headers,'x-alcor-account-kind':'real'});assert typed.status_code==200 and typed.json()['data']==result,typed.text


@pytest.mark.asyncio
async def test_signed_actual_cash_reconcile_real_fx_limit_and_all_fifteen_policy_currencies(client,admin,db):
    import json
    from datetime import UTC, datetime

    from alcor_api.financing_model import CURRENCIES
    from alcor_api.fx_reference import persist
    from test_cash_ledger import command as cash_command
    from test_cash_ledger import submit as cash_submit
    account,record=await setup(client,name='Signed cash actual debt')
    missing=cash_command(account,action='reconcile_balance',amount='-10',occurredAt=datetime.now(UTC).isoformat())
    assert (await client.post('/api/cash/preview',json=missing)).status_code==422
    signed={**missing,'allowNegativeBalance':True,'financingConfirmation':evidence()}
    proof=await client.post('/api/cash/preview',json=signed);assert proof.status_code==200,proof.text
    assert proof.json()['financing']['debtAfter']=='10' and proof.json()['financing']['externalFlow']=='0'
    result=await client.post('/api/cash/operations',json={'data':signed,'preview':proof.json()['preview']});assert result.status_code==200,result.text
    assert result.json()['balanceAfter']=='-10' and result.json()['financing']['debtAfter']=='10'
    absent=await client.post(P+'/preview',json=await command(client,admin,kind='real',currency='JPY',limit='1500'))
    assert absent.status_code==409 and 'recorded_exchange_rate_missing' in absent.text,absent.text
    async with db.connection() as conn:
        await persist(conn,json.dumps({'base':'USD','amount':1,'date':'2026-11-01','rates':{code:'150' if code=='JPY' else '1' for code in CURRENCIES if code!='USD'}}).encode(),datetime.now(UTC),uuid4())
    too_small=await client.post(P+'/preview',json=await command(client,admin,kind='real',currency='JPY',limit='1499.999999999999999999'))
    assert too_small.status_code==409,too_small.text
    # Every original policy currency participates in real, saved FX debt; none
    # is silently omitted or filled by a hardcoded fallback quote.
    for currency in ('JPY','CHF','BRL'):
        await complete(client,await command(client,admin,kind='real',currency=currency,limit='1500'))
    current=(await client.get(P,params={'accountKind':'real'})).json()
    assert current['debt']['debtKnown'] and current['debt']['fx']['observationId'] and not current['debt']['fx']['fallback']
    no_borrow=trade_command(record,quantity='1',price='1',amount='1',fees='0')
    assert (await client.post('/api/trading/preview',json=no_borrow)).status_code==409
    deposit,_=await cash_submit(client,cash_command(account,action='external_deposit',amount='5',occurredAt=datetime.now(UTC).isoformat()))
    assert deposit['balanceAfter']=='-5'


@pytest.mark.asyncio
async def test_financing_posting_interruption_fixes_failed_original_uuid_and_policy_revision_revokes_old_trade_proof(client,admin,db,monkeypatch):
    from alcor_api.trading import Trading
    _account,record=await setup(client,name='Financing atomic original UUID')
    loan=trade_command(record,quantity='100',price='11',amount='1100',fees='1',allowFinancing=True,financingConfirmation=evidence())
    proof=await client.post('/api/trading/preview',json=loan);assert proof.status_code==200,proof.text
    # A policy change revokes the old financial proof but never blocks a fresh
    # confirmation of an already occurred event solely on the numeric ceiling.
    await complete(client,await command(client,admin,kind='real',limit='1'))
    stale=await client.post('/api/trading/operations',json={'data':loan,'preview':proof.json()['preview']})
    assert stale.status_code==200 and stale.json()['state']=='failed',stale.text
    assert (await client.get('/api/trading/operations/'+loan['requestId'])).json()==stale.json()
    loan={**loan,'requestId':str(uuid4())}
    proof=await client.post('/api/trading/preview',json=loan);assert proof.status_code==200,proof.text
    original=Trading.decorate_receipt
    async def interrupted(self,conn,who,data,receipt):
        result=await original(self,conn,who,data,receipt)
        if data.get('allowFinancing'):raise RuntimeError('synthetic interruption after debt evidence cash and position')
        return result
    with monkeypatch.context() as patch:
        patch.setattr(Trading,'decorate_receipt',interrupted)
        response=await client.post('/api/trading/operations',json={'data':loan,'preview':proof.json()['preview']})
    assert response.status_code==200 and response.json()['state']=='failed',response.text
    assert (await client.get('/api/trading/operations/'+loan['requestId'])).json()==response.json()
    assert (await client.post('/api/trading/operations',json={'data':loan,'preview':proof.json()['preview']})).json()==response.json()
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM trade_ledger')).fetchone()
        assert not await(await conn.execute('SELECT 1 FROM cash_financing_confirmations')).fetchone()
        assert (await(await conn.execute('SELECT qty FROM portfolio_records WHERE id=%s',(record['id'],))).fetchone())['qty']==0
        assert (await(await conn.execute('SELECT sum(amount) amount FROM cash_ledger_entries')).fetchone())['amount']==1000
    fresh={**loan,'requestId':str(uuid4())}
    posted,_=await trade_submit(client,fresh);assert posted['cashAfter']=='-101'


@pytest.mark.asyncio
async def test_first_user_policy_reads_never_seed_financial_collections_or_default_policy(client,admin,db):
    from test_legacy_trade_corrections import native_headers
    tables=('cash_ledger_collections','portfolio_record_collections','cash_ledger_entries','financing_policy_heads','financing_policy_versions')
    async def counts():
        async with db.connection() as conn:return {t:(await(await conn.execute('SELECT count(*) n FROM '+t)).fetchone())['n'] for t in tables}
    before=await counts()
    first=await client.get(P,params={'accountKind':'real'});assert first.status_code==200,first.text
    again=await client.get(P,params={'accountKind':'real'});assert again.status_code==200 and again.json()==first.json()
    assert first.json()['policy'] is None and first.json()['policyKnown'] and first.json()['debt']['debt'] is None and not first.json()['debt']['debtKnown']
    headers=await native_headers(db,admin,'portfolio.read portfolio.write')
    for version in (1,2):
        old=await client.get(f'/api/v{version}/account-assets/financing-policy',headers=headers)
        assert old.status_code==200 and old.json()['data']['policy'] is None,old.text
    assert await counts()==before


@pytest.mark.asyncio
@pytest.mark.parametrize('version',[1,2])
async def test_old_actual_financing_confirmation_records_negative_cash_without_broker_or_external_flow(client,admin,db,version):
    from test_legacy_trade_corrections import draft, native_headers
    _account,record=await setup(client,name='Explicit old actual financing')
    headers=await native_headers(db,admin,'portfolio.read portfolio.write orders.read orders.write');prefix=f'/api/v{version}/account-assets'
    snapshot=(await client.get(prefix+'/trading',headers=headers)).json()['data']
    body=draft(admin,record,snapshot,qty=100,price=11,fees=1,allowFinancing=True)
    proof=await client.post(prefix+'/trading/preview',json=body,headers=headers);assert proof.status_code==200,proof.text
    assert proof.json()['data']['financing']['cashAfter']==-101 and proof.json()['data']['financing']['debtIncrease']==101
    result=await client.post(prefix+'/trading/submissions',json={**body,'requestId':str(uuid4())},headers=headers);assert result.status_code==200,result.text
    result=result.json()['data'];assert result['data']['snapshot']['cash']['nativeBalancesByCurrency']=={'USD':-101}
    assert (await client.get(prefix+'/operations/'+result['requestId'],headers=headers)).json()['data']==result
    async with db.connection() as conn:
        assert (await(await conn.execute("SELECT count(*) n FROM cash_ledger_entries WHERE kind='external_deposit'")).fetchone())['n']==0


@pytest.mark.asyncio
async def test_pg_rejects_implicit_debt_and_signed_cash_failure_has_no_partial_confirmation_or_retry(client,admin,db):
    from datetime import UTC, datetime

    from psycopg.errors import CheckViolation
    from test_cash_ledger import command as cash_command
    account,_record=await setup(client,name='Debt evidence PG guard and cash rollback')
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT current_database() name')).fetchone())['name'].startswith('alcor_test_')
        with pytest.raises(CheckViolation,match='explicit actual financing'):
            async with conn.transaction():await conn.execute("INSERT INTO cash_ledger_entries(id,owner_id,account_id,account_kind,currency,request_id,kind,amount,affects_owner,occurred_at,note) VALUES(%s,%s,%s,'real','USD',%s,'reconcile_balance',-1001,true,clock_timestamp(),'synthetic forbidden implicit loan')",(uuid4(),admin,account,uuid4()))
    data=cash_command(account,action='reconcile_balance',amount='-5',occurredAt=datetime.now(UTC).isoformat(),allowNegativeBalance=True,financingConfirmation=evidence())
    p=await client.post('/api/cash/preview',json=data);assert p.status_code==200,p.text
    async with db.connection() as conn:
        await conn.execute("CREATE FUNCTION synthetic_signed_cash_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='reconcile_balance' THEN RAISE EXCEPTION 'synthetic cash interruption' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;CREATE TRIGGER synthetic_signed_cash_failure AFTER INSERT ON cash_ledger_entries FOR EACH ROW EXECUTE FUNCTION synthetic_signed_cash_failure()",prepare=False)
    body={'data':data,'preview':p.json()['preview']}
    stopped=await client.post('/api/cash/operations',json=body);assert stopped.status_code==200 and stopped.json()['state']=='failed',stopped.text
    assert (await client.get('/api/cash/operations/'+data['requestId'])).json()==stopped.json()
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM cash_financing_confirmations')).fetchone()
        assert (await(await conn.execute('SELECT sum(amount) balance FROM cash_ledger_entries')).fetchone())['balance']==1000
        await conn.execute('DROP TRIGGER synthetic_signed_cash_failure ON cash_ledger_entries;DROP FUNCTION synthetic_signed_cash_failure()',prepare=False)
    assert (await client.post('/api/cash/operations',json=body)).json()==stopped.json()
