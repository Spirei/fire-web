from decimal import Decimal

from test_financing_policy import evidence
from test_trade_amendments import P, command, complete
from test_trading import command as trade_command
from test_trading import setup
from test_trading import submit as trade_submit


async def test_reducing_and_deleting_proven_financed_buy_preserves_original_loan_and_uuid(client,admin,db):
    account,record=await setup(client,name='Actual financed correction')
    loan,_=await trade_submit(client,trade_command(record,quantity='100',price='11',amount='1100',fees='1',allowFinancing=True,financingConfirmation=evidence()))
    data=await command(client,record['id'],loan['tradeId'],price='10.5')
    result,proof=await complete(client,data)
    assert Decimal(proof['cashEffect']['brokerBefore'])==-101 and Decimal(proof['cashEffect']['brokerAfter'])==-51
    changed=await command(client,record['id'],loan['tradeId'])
    changed.update(action='delete',replacement=None)
    deleted,_=await complete(client,changed)
    assert Decimal((await client.get('/api/cash/accounts/'+account)).json()['currencies'][0]['balance'])==1000
    assert (await client.get('/api/trading/operations/'+loan['requestId'])).json()==loan
    assert (await client.get(P+'/operations/'+result['requestId'])).json()==result
    assert (await client.get(P+'/operations/'+deleted['requestId'])).json()==deleted
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM cash_financing_confirmations')).fetchone())['n']==1
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==1


async def test_extra_financing_correction_requires_new_statement_and_rollback_conserves_original_chain(client,admin,db,monkeypatch):
    account,record=await setup(client,name='Additional actual financed amendment')
    loan,_=await trade_submit(client,trade_command(record,quantity='100',price='11',amount='1100',fees='1',allowFinancing=True,financingConfirmation=evidence()))
    data=await command(client,record['id'],loan['tradeId'],price='12',fees='2')
    denied=await client.post(P+'/preview',json=data)
    assert denied.status_code==409,denied.text
    data['financingConfirmation']=evidence()
    proof=await client.post(P+'/preview',json=data)
    assert proof.status_code==200,proof.text
    # Force an exception after amendment, linked financing and signed cash have
    # all been written; transaction rollback must leave every original intact.
    async with db.connection() as conn:
        await conn.execute("CREATE FUNCTION synthetic_financed_amendment_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='trade_correction' THEN RAISE EXCEPTION 'synthetic post cash correction fault' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;CREATE TRIGGER synthetic_financed_amendment_fault AFTER INSERT ON cash_ledger_entries FOR EACH ROW EXECUTE FUNCTION synthetic_financed_amendment_fault()",prepare=False)
    stopped=await client.post(P+'/operations',json={'data':data,'preview':proof.json()['previewRevision']})
    assert stopped.status_code==200 and stopped.json()['state']=='failed',stopped.text
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM trade_amendments')).fetchone()
        assert (await(await conn.execute('SELECT count(*) n FROM cash_financing_confirmations')).fetchone())['n']==1
        assert (await(await conn.execute('SELECT sum(amount) balance FROM cash_ledger_entries')).fetchone())['balance']==-101
        await conn.execute('DROP TRIGGER synthetic_financed_amendment_fault ON cash_ledger_entries;DROP FUNCTION synthetic_financed_amendment_fault()',prepare=False)
    assert (await client.post(P+'/operations',json={'data':data,'preview':proof.json()['previewRevision']})).json()==stopped.json()
    from uuid import uuid4
    data['requestId']=str(uuid4())
    result,proof=await complete(client,data)
    assert Decimal(proof['cashEffect']['brokerAfter'])==-202
    assert (await client.get('/api/trading/operations/'+loan['requestId'])).json()==loan
    assert (await client.get(P+'/operations/'+result['requestId'])).json()==result
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM cash_financing_confirmations')).fetchone())['n']==2
    # A later reduction uses the conserved original evidence, not a fresh loan.
    lower=await command(client,record['id'],loan['tradeId'],price='11',fees='1')
    await complete(client,lower)
    assert Decimal((await client.get('/api/cash/accounts/'+account)).json()['currencies'][0]['balance'])==-101


import pytest


@pytest.mark.parametrize('version',[1,2])
async def test_old_clients_keep_same_financing_authority_on_explicit_corrections(client,admin,db,version):
    from uuid import uuid4

    from test_legacy_trade_corrections import draft, native_headers
    _account,record=await setup(client,name='Old financed actual correction')
    headers=await native_headers(db,admin)
    prefix=f'/api/v{version}/account-assets'
    initial=(await client.get(prefix+'/trading',headers=headers)).json()['data']
    submitted=draft(admin,record,initial,qty=100,price=11,fees=1,allowFinancing=True)
    prepared=await client.post(prefix+'/trading/preview',json=submitted,headers=headers)
    assert prepared.status_code==200,prepared.text
    entered=await client.post(prefix+'/trading/submissions',json={**submitted,'requestId':str(uuid4())},headers=headers)
    assert entered.status_code==200,entered.text
    loan={'tradeId':entered.json()['data']['data']['items'][0]['id']}
    response=await client.get(prefix+'/trading',headers=headers)
    assert response.status_code==200,response.text
    snapshot=response.json()['data']
    order=next(row for row in snapshot['orders'] if row['id']==loan['tradeId'])
    data={'requestId':str(uuid4()),'accountId':admin,'snapshotRevision':snapshot['snapshotRevision'],'recordId':record['id'],'recordRevision':order['recordRevision'],'action':'amend','orders':[{'id':loan['tradeId'],'revision':order['revision']}],'replacement':{'qty':100,'price':12,'fees':2,'tradedAt':order['tradedAt']},'financingConfirmation':evidence()}
    proof=await client.post(prefix+'/trading/corrections/preview',json=data,headers=headers)
    assert proof.status_code==200,proof.text
    posted=await client.post(prefix+'/trading/corrections',json={**data,'previewRevision':proof.json()['data']['previewRevision']},headers=headers)
    assert posted.status_code==200,posted.text
    assert posted.json()['data']['data']['snapshot']['cash']['nativeBalancesByCurrency']=={'USD':-202}
    assert (await client.get(prefix+'/operations/'+data['requestId'],headers=headers)).json()['data']==posted.json()['data']


import httpx
import test_backups as backup_tests
from alcor_api.main import create_app
from fee_source_test_helpers import identity

configured=backup_tests.configured
backup_app=backup_tests.backup_app
bc=backup_tests.bc


async def test_encrypted_restore_keeps_financed_correction_authority_and_original_receipts(bc,backup_app,configured):
    from uuid import UUID
    await identity(bc,backup_app.state.db)
    account,record=await setup(bc,name='Restored financed amendment')
    loan,_=await trade_submit(bc,trade_command(record,quantity='100',price='11',amount='1100',fees='1',allowFinancing=True,financingConfirmation=evidence()))
    data=await command(bc,record['id'],loan['tradeId'],price='12',fees='2');data['financingConfirmation']=evidence()
    amended,_=await complete(bc,data)
    async def book(db):
        async with db.connection() as conn:return {table:await(await conn.execute('SELECT * FROM '+table+' ORDER BY 1,2')).fetchall() for table in ('cash_financing_confirmations','trade_amendments','trade_operations','cash_ledger_entries','portfolio_records')}
    before=await book(backup_app.state.db)
    backup_id,_=await backup_tests.create_capsule(bc,backup_app,configured)
    restore=await bc.get('/api/backups/'+backup_id+'/restore-preview',params={'target_id':'isolated-qa'});assert restore.status_code==200,restore.text
    task,_=await backup_tests.submit(bc,'backup.restore',backup_id=backup_id,target_id='isolated-qa',restore_ticket=restore.json()['restore_ticket'])
    restored=await backup_tests.execute(backup_app,configured,UUID(task['id']));assert restored['sessions_revoked']
    target=configured.restore_targets[0];settings=configured.model_copy(update={'database_url':target.database_url,'instance_id':target.instance_id,'environment':'test','redis_url':None,'file_root':target.recovery_directory/'files','connection_secret_dir':target.recovery_directory/'connection-secrets','legacy_source_registry_path':None})
    app=create_app(settings)
    async with app.router.lifespan_context(app),httpx.AsyncClient(transport=httpx.ASGITransport(app=app,raise_app_exceptions=False),base_url='http://testserver',headers={'origin':'http://testserver'}) as client:
        assert await book(app.state.db)==before
        login=await client.post('/api/session/login',json={'login':'BackupQA','password':'Synthetic9Pass'});assert login.status_code==200,login.text
        client.headers['x-csrf-token']=login.json()['csrf']
        assert (await client.get('/api/trading/operations/'+loan['requestId'])).json()==loan
        assert (await client.get(P+'/operations/'+amended['requestId'])).json()==amended
        lower=await command(client,record['id'],loan['tradeId'],price='10.5',fees='1')
        await complete(client,lower)
        assert Decimal((await client.get('/api/cash/accounts/'+account)).json()['currencies'][0]['balance'])==-51
