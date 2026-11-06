import copy
from datetime import datetime,UTC
from decimal import Decimal
from uuid import uuid4

import pytest

from legacy_fee_source_fixture import old_pg
from test_calculated_fee_actual_guard import calculated_case
from test_fee_repairs import operation
from test_trading import command as trade_command

P='/api/fees/confirmations/native'


async def confirmation(client,aid,trade_id,fee='1.11'):
    response=await client.get(P,params={'brokerAccountId':aid});assert response.status_code==200,response.text
    head=response.json();row=next(item for item in head['items'] if item['tradeId']==trade_id)
    return {'requestId':str(uuid4()),**{key:head[key] for key in ('targetUserId','brokerAccountId','brokerRevision','snapshotRevision')},
      'confirmations':[{**{key:row[key] for key in ('tradeId','registrationRequestId','registrationSha256','recordRevision','currency')},
        'actualFee':fee,'authority':'owner_recorded','actualPaidConfirmed':True,'historicalCashAttributionConfirmed':True,
        'evidence':{'kind':'owner_statement','statement':'I checked my actual paid fee and original account cash attribution; this is my statement, not a broker verified document.'}}]}


async def complete(client,data):
    proof=await client.post(P+'/preview',json=data);assert proof.status_code==200,proof.text
    result=await client.post(P+'/operations',json={'data':data,'preview':proof.json()['previewRevision']});assert result.status_code==200,result.text
    assert result.json()['state']=='completed',result.text
    return result.json(),proof.json()


@pytest.mark.asyncio
@pytest.mark.parametrize('paid,delta,cash,cost',[('1.11','-0.08','798.89','10.056'),('0','1.03','800','10')])
async def test_native_actual_fee_diff_preserves_estimate_registration_and_original_receipts(client,admin,db,paid,delta,cash,cost):
    aid,first,registration,registered,preview,other,b=await calculated_case(client,db)
    async with db.connection() as conn:
        raw=await(await conn.execute('SELECT * FROM trade_ledger ORDER BY id')).fetchall()
        details=await(await conn.execute('SELECT * FROM trade_fee_details ORDER BY trade_id')).fetchall()
        original_cash=await(await conn.execute('SELECT * FROM cash_ledger_entries ORDER BY id')).fetchall()
        count=(await(await conn.execute('SELECT count(*) n FROM trade_operations')).fetchone())['n']
    data=await confirmation(client,aid,registered['tradeId'],paid)
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_operations')).fetchone())['n']==count
        assert not await(await conn.execute('SELECT 1 FROM native_actual_fee_confirmations')).fetchone()
    result,proof=await complete(client,data)
    assert result['kind']=='native_actual_fee_confirmation' and result['financialApplied'] and result['actualFeeKnown']
    assert proof['candidates'][0]['oldFees']=='1.03' and proof['candidates'][0]['newFees']==paid
    assert Decimal(proof['cashEffect']['delta'])==Decimal(delta) and proof['cashEffect']['externalFlow']==proof['cashEffect']['income']=='0'
    assert Decimal(proof['cashEffect']['brokerAfter'])==Decimal(cash)
    assert Decimal(proof['positionEffects'][0]['actualAfterCost'])==Decimal(cost)
    assert (await client.get(P+'/operations/'+data['requestId'])).json()==result
    assert (await client.post(P+'/operations',json={'data':data,'preview':proof['previewRevision']})).json()==result
    changed=copy.deepcopy(data);changed['confirmations'][0]['actualFee']='9'
    assert (await client.post(P+'/operations',json={'data':changed,'preview':proof['previewRevision']})).status_code==409
    assert (await client.get('/api/trading/operations/'+registration['requestId'])).json()==registered
    ordinary=(await client.get('/api/cash/accounts/'+aid)).json()['currencies'][0]
    assert ordinary['complete'] and Decimal(ordinary['balance'])==Decimal(cash),ordinary
    record=(await client.get('/api/portfolio/records/'+registered['recordId'])).json()['record']
    assert Decimal(record['cost'])==Decimal(cost),record
    listing=(await client.get('/api/trading/fills',params={'recordId':record['id']})).json()['items']
    fill=next(row for row in listing if row['id']==registered['tradeId'])
    assert fill['fees']==paid and fill['actualFeeKnown'] and fill['feeSource']=='owner_recorded'
    assert Decimal(fill['cash_delta'])==-(Decimal(100)+Decimal(paid)) and fill['registeredCashDelta']=='-101.03'
    history=(await client.get('/api/cash/accounts/'+aid+'/entries')).json()['items']
    entry=next(row for row in history if row['sourceTradeId']==registered['tradeId'])
    assert entry['actualFeeKnown'] and entry['feeAuthority']=='owner_recorded' and entry['registeredAmount']=='-101.03'
    async with db.connection() as conn:
        assert await(await conn.execute('SELECT * FROM trade_ledger ORDER BY id')).fetchall()==raw
        assert await(await conn.execute('SELECT * FROM trade_fee_details ORDER BY trade_id')).fetchall()==details
        assert await(await conn.execute("SELECT * FROM cash_ledger_entries WHERE kind<>'fee_correction' ORDER BY id")).fetchall()==original_cash
        assert (await(await conn.execute("SELECT sum(amount) value FROM cash_ledger_entries WHERE kind='fee_correction'")).fetchone())['value']==Decimal(delta)
        assert (await(await conn.execute('SELECT count(*) n FROM native_actual_fee_confirmations')).fetchone())['n']==1
        assert (await(await conn.execute('SELECT count(*) n FROM trade_fee_corrections')).fetchone())['n']==1
    # Resolving actual fee evidence releases only its correct account spending gate.
    later=trade_command(record,side='sell',quantity='1',price='20',amount='20',fees='0',occurredAt=datetime.now(UTC).isoformat())
    posted=await operation(client,'/api/trading',later)
    assert Decimal(posted['cashAfter'])==Decimal(cash)+20


@pytest.mark.asyncio
async def test_native_actual_fee_confirmation_is_session_cas_scoped_and_failed_cash_posting_rolls_back(client,admin,db):
    aid,first,registration,registered,_,other,b=await calculated_case(client,db)
    data=await confirmation(client,aid,registered['tradeId'])
    for key,value in [('authority','broker_reported'),('actualPaidConfirmed',False),('historicalCashAttributionConfirmed',False)]:
        wrong=copy.deepcopy(data);wrong['confirmations'][0][key]=value
        assert (await client.post(P+'/preview',json=wrong)).status_code==422
    changed=copy.deepcopy(data);changed['targetUserId']='u-another-owner'
    assert (await client.post(P+'/preview',json=changed)).status_code==403
    changed=copy.deepcopy(data);changed['confirmations'][0]['registrationSha256']='0'*64
    assert (await client.post(P+'/preview',json=changed)).status_code==409
    p=await client.post(P+'/preview',json=data);assert p.status_code==200,p.text
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT current_database() name')).fetchone())['name'].startswith('alcor_test_')
        before=await(await conn.execute('SELECT cost,revision,fee_projection_id FROM portfolio_records WHERE id=%s',(registered['recordId'],))).fetchone()
        await conn.execute("CREATE FUNCTION synthetic_stop_native_fee_cash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='fee_correction' THEN RAISE EXCEPTION 'synthetic cash interruption' USING ERRCODE='23514'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_stop_native_fee_cash BEFORE INSERT ON cash_ledger_entries FOR EACH ROW EXECUTE FUNCTION synthetic_stop_native_fee_cash()",prepare=False)
    result=await client.post(P+'/operations',json={'data':data,'preview':p.json()['previewRevision']})
    assert result.status_code==200 and result.json()['state']=='failed' and result.json()['status']==503,result.text
    assert (await client.get(P+'/operations/'+data['requestId'])).json()==result.json()
    async with db.connection() as conn:
        for table in ('native_actual_fee_confirmations','trade_fee_corrections','trade_fee_projections'):assert not await(await conn.execute('SELECT 1 FROM '+table)).fetchone()
        assert await(await conn.execute('SELECT cost,revision,fee_projection_id FROM portfolio_records WHERE id=%s',(registered['recordId'],))).fetchone()==before
        assert not await(await conn.execute("SELECT 1 FROM cash_ledger_entries WHERE kind='fee_correction'")).fetchone()
        await conn.execute('DROP TRIGGER synthetic_stop_native_fee_cash ON cash_ledger_entries; DROP FUNCTION synthetic_stop_native_fee_cash()',prepare=False)
    # Unknown outcome uses the same UUID; removing the failure cannot replay it.
    assert (await client.post(P+'/operations',json={'data':data,'preview':p.json()['previewRevision']})).json()==result.json()


@pytest.mark.asyncio
async def test_native_fee_evidence_cannot_post_without_exact_same_atomic_correction_or_forge_an_explicit_paid_fill(client,admin,db):
    import psycopg
    from psycopg.types.json import Jsonb
    from alcor_api.source_snapshot import canonical,sha
    aid,first,registration,registered,_,other,b=await calculated_case(client,db)
    data=await confirmation(client,aid,registered['tradeId'])
    async with db.connection() as conn:
        original=await(await conn.execute("SELECT value,encode(sha256(convert_to(value::text,'UTF8')),'hex') hash FROM (SELECT native_fee_registration_snapshot(%s,%s) value) s",(admin,registered['tradeId']))).fetchone()
        evidence={**data['confirmations'][0]['evidence'],'authority':'owner_recorded','targetUserId':admin,'tradeId':registered['tradeId'],
          'registrationRequestId':registration['requestId'],'registrationSha256':original['hash'],'brokerAccountId':aid,
          'providerId':'longbridge','currency':'USD','actualFee':'1.11','actualPaidConfirmed':True,'historicalCashAttributionConfirmed':True}
        args=(admin,data['requestId'],registered['tradeId'],'1.03','1.11','USD','owner_recorded',Jsonb(original['value']),original['hash'],Jsonb(evidence),canonical(evidence),sha(canonical(evidence)))
        insert='INSERT INTO native_actual_fee_confirmations(owner_id,request_id,trade_id,registered_fee,actual_fee,currency,authority,registration_snapshot,registration_sha256,evidence,evidence_raw,evidence_sha256) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)'
        with pytest.raises(psycopg.Error):
            async with conn.transaction():
                await conn.execute(insert,args)
                await conn.execute('SET CONSTRAINTS ALL IMMEDIATE')
        assert not await(await conn.execute('SELECT 1 FROM native_actual_fee_confirmations')).fetchone()
        # A true owner-recorded zero fill is already actual, not an estimate.
        assert (await(await conn.execute('SELECT native_fee_registration_snapshot(%s,%s) value',(admin,first['tradeId']))).fetchone())['value'] is None
        wrong=list(args);wrong[2]=first['tradeId'];wrong[3]='0'
        with pytest.raises(psycopg.errors.CheckViolation):
            async with conn.transaction():await conn.execute(insert,wrong)
        assert not await(await conn.execute('SELECT 1 FROM trade_fee_corrections')).fetchone()


@pytest.mark.asyncio
async def test_native_actual_confirmation_cannot_cross_session_and_concurrent_different_uuids_post_once(client,admin,app,db):
    import asyncio,httpx
    aid,first,registration,registered,_,other,b=await calculated_case(client,db)
    data=await confirmation(client,aid,registered['tradeId'])
    p=await client.post(P+'/preview',json=data);assert p.status_code==200,p.text
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as second:
        login=await second.post('/api/session/login',json={'login':'AdminOne','password':'Synthetic9Pass'});assert login.status_code==200
        second.headers['x-csrf-token']=login.json()['csrf']
        rejected=await second.post(P+'/operations',json={'data':data,'preview':p.json()['previewRevision']})
        assert rejected.json()['state']=='failed' and rejected.json()['status']==409,rejected.text
    first_data=await confirmation(client,aid,registered['tradeId']);second_data=copy.deepcopy(first_data);second_data['requestId']=str(uuid4())
    proofs=await asyncio.gather(*(client.post(P+'/preview',json=value) for value in (first_data,second_data)))
    assert all(proof.status_code==200 for proof in proofs)
    results=await asyncio.gather(*(client.post(P+'/operations',json={'data':value,'preview':proof.json()['previewRevision']}) for value,proof in zip((first_data,second_data),proofs)))
    assert sorted(result.json()['state'] for result in results)==['completed','failed'],[r.text for r in results]
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM native_actual_fee_confirmations')).fetchone())['n']==1
        assert (await(await conn.execute("SELECT sum(amount) n FROM cash_ledger_entries WHERE kind='fee_correction'")).fetchone())['n']==Decimal('-0.08')
    oversized=await client.post(P+'/preview',content=b' '*131073,headers={'content-type':'application/json'})
    assert oversized.status_code==413,oversized.text


@pytest.mark.asyncio
async def test_legacy_source_bound_registered_zero_cannot_borrow_native_registration_lane(client,admin,app,old_pg,pg,tmp_path):
    from actual_fee_test_support import actual_case,actual_operation
    async with actual_case(client,admin,app,old_pg,pg,tmp_path,fee='1.11') as (approved,hosted,grant,exported,aid,fill,legacy):
        head=await approved.get(P,params={'brokerAccountId':aid});assert head.status_code==200,head.text
        assert head.json()['items']==[]
        async with app.state.db.connection() as conn:
            assert (await(await conn.execute('SELECT native_fee_registration_snapshot(%s,%s) value',(admin,fill['tradeId']))).fetchone())['value'] is None
        attempted={'requestId':str(uuid4()),**{key:head.json()[key] for key in ('targetUserId','brokerAccountId','brokerRevision','snapshotRevision')},
          'confirmations':[{'tradeId':fill['tradeId'],'registrationRequestId':fill['requestId'],'registrationSha256':'0'*64,'recordRevision':fill['record']['revision'],
            'actualFee':'1.11','currency':'USD','authority':'owner_recorded','actualPaidConfirmed':True,'historicalCashAttributionConfirmed':True,
            'evidence':{'kind':'owner_statement','statement':'An owner statement cannot turn old registered zero into native source authority.'}}]}
        denied=await approved.post(P+'/preview',json=attempted);assert denied.status_code==409,denied.text
        # Its original source-bound lane remains available with all original
        # baseline, grant, manifest, cash and per-order owner evidence.
        result,_=await actual_operation(approved,legacy);assert result['state']=='completed'
