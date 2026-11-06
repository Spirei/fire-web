from datetime import UTC, datetime
from uuid import UUID

import httpx
import test_backups as backup_tests
from alcor_api.main import create_app
from fee_source_test_helpers import identity
from test_cash_ledger import command as cash_command
from test_cash_ledger import submit as cash_submit
from test_financing_policy import P, command, complete, evidence
from test_trading import command as trade_command
from test_trading import setup
from test_trading import submit as trade_submit

configured=backup_tests.configured
backup_app=backup_tests.backup_app
bc=backup_tests.bc


async def book(db):
    tables=('financing_policy_versions','financing_policy_heads','cash_financing_confirmations','trade_operations','trade_ledger','portfolio_records','cash_ledger_accounts','cash_ledger_entries','cash_ledger_collections','cash_ledger_operations')
    async with db.connection() as conn:return {t:await(await conn.execute('SELECT * FROM '+t+' ORDER BY 1,2')).fetchall() for t in tables}


async def test_actual_encrypted_restore_preserves_signed_cash_policy_evidence_and_all_original_receipts(bc,backup_app,configured):
    who=await identity(bc,backup_app.state.db)
    account,record=await setup(bc,name='Restored signed cash and liability observation')
    policy=await complete(bc,await command(bc,who.id,kind='real',limit='1'))
    loan,_=await trade_submit(bc,trade_command(record,quantity='100',price='11',amount='1100',fees='1',allowFinancing=True,financingConfirmation=evidence()))
    reconcile=cash_command(account,action='reconcile_balance',amount='-105',occurredAt=datetime.now(UTC).isoformat(),allowNegativeBalance=True,financingConfirmation=evidence())
    corrected,_=await cash_submit(bc,reconcile)
    before=await book(backup_app.state.db)
    backup_id,_=await backup_tests.create_capsule(bc,backup_app,configured)
    preview=await bc.get('/api/backups/'+backup_id+'/restore-preview',params={'target_id':'isolated-qa'});assert preview.status_code==200,preview.text
    task,_=await backup_tests.submit(bc,'backup.restore',backup_id=backup_id,target_id='isolated-qa',restore_ticket=preview.json()['restore_ticket'])
    restored=await backup_tests.execute(backup_app,configured,UUID(task['id']));assert restored['sessions_revoked']
    target=configured.restore_targets[0];settings=configured.model_copy(update={'database_url':target.database_url,'instance_id':target.instance_id,'environment':'test','redis_url':None,'file_root':target.recovery_directory/'files','connection_secret_dir':target.recovery_directory/'connection-secrets','legacy_source_registry_path':None})
    recovered=create_app(settings)
    async with recovered.router.lifespan_context(recovered),httpx.AsyncClient(transport=httpx.ASGITransport(app=recovered,raise_app_exceptions=False),base_url='http://testserver',headers={'origin':'http://testserver'}) as client:
        assert await book(recovered.state.db)==before
        login=await client.post('/api/session/login',json={'login':'BackupQA','password':'Synthetic9Pass'});assert login.status_code==200,login.text
        client.headers['x-csrf-token']=login.json()['csrf']
        for path,result in ((P+'/operations/'+policy['requestId'],policy),('/api/trading/operations/'+loan['requestId'],loan),('/api/cash/operations/'+corrected['requestId'],corrected)):
            response=await client.get(path);assert response.status_code==200 and response.json()==result,response.text
        snapshot=(await client.get(P,params={'accountKind':'real'})).json()
        assert snapshot['debt']['debtKnown'] and snapshot['debt']['debt']=='105' and snapshot['exceedsLimit'] and not snapshot['debt']['brokerGrossLoanKnown']
        assert (await client.get('/api/cash/accounts/'+account)).json()['currencies'][0]['balance']=='-105'
        assert await book(recovered.state.db)==before
