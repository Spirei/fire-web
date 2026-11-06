from decimal import Decimal
from uuid import UUID, uuid4

import httpx
import pytest
import test_backups as backup_tests
from actual_fee_test_support import actual_case, actual_operation
from alcor_api.main import create_app
from fee_source_test_helpers import identity
from legacy_fee_source_fixture import old_pg
from test_fee_integration_restore import financial_state
from test_trade_amendments import P, command, complete


@pytest.mark.asyncio
async def test_registered_zero_needs_independent_actual_confirmation_before_same_chain_amend_or_delete(client,admin,app,old_pg,pg,tmp_path):
    async with actual_case(client,admin,app,old_pg,pg,tmp_path,fee='1.11') as (approved,hosted,_grant,source,account,fill,actual):
        before=await command(approved,fill['recordId'],fill['tradeId'],price='11',fees='1.11')
        assert (await approved.post(P+'/preview',json=before)).status_code==409
        result,_=await actual_operation(approved,actual);assert result['state']=='completed'
        data=await command(approved,fill['recordId'],fill['tradeId'],price='11',fees='1.11')
        done,preview=await complete(approved,data)
        assert Decimal(preview['cashEffect']['delta'])==-10 and Decimal(preview['cashEffect']['brokerAfter'])==Decimal('888.89')
        authority=preview['evidence']['members'][0]['sourceAuthority'];assert authority['lane']=='registered_baseline_actual' and authority['actualConfirmationId']==actual['requestId'] and authority['manifestId']==source['manifestId']
        cash=(await approved.get('/api/cash/accounts/'+account)).json()['currencies'][0]
        assert cash['complete'] and Decimal(cash['balance'])==Decimal('888.89') and not cash['ownerCashComplete'],cash
        delete=await command(approved,fill['recordId'],fill['tradeId']);delete.update(action='delete',replacement=None)
        removed,_=await complete(approved,delete);assert removed['replacementId'] is None
        cash=(await approved.get('/api/cash/accounts/'+account)).json()['currencies'][0];assert cash['complete'] and Decimal(cash['balance'])==1000
        inactive=(await approved.get('/api/trading/fills',params={'recordId':fill['recordId']})).json()['items'][0]
        assert not inactive['effectiveActive'] and inactive['cash_delta'] is None and Decimal(inactive['registeredCashDelta'])==-100 and Decimal(inactive['fees'])==Decimal('1.11')
        assert (await approved.get(P+'/operations/'+data['requestId'])).json()==done
        assert (await approved.get('/api/fees/confirmations/operations/'+actual['requestId'])).json()==result
        async with hosted.state.db.connection() as conn:
            row=(await(await conn.execute('SELECT fees,cash_delta FROM trade_ledger WHERE id=%s',(fill['tradeId'],))).fetchone())
            assert row=={'fees':Decimal(0),'cash_delta':Decimal(-100)}
            assert (await(await conn.execute('SELECT count(*) n FROM actual_fee_confirmations')).fetchone())['n']==1


__all__=['old_pg']

configured=backup_tests.configured
backup_app=backup_tests.backup_app
bc=backup_tests.bc


async def stored_book(db):
    result=await financial_state(db)
    async with db.connection() as conn:
        for table in ('trade_amendments','trade_correction_members','trade_presentation_ids','legacy_source_grants'):
            result[table]=await(await conn.execute('SELECT * FROM '+table+' ORDER BY 1,2')).fetchall()
    return result


async def test_encrypted_restore_preserves_imported_correction_uuid_and_raw_after_source_revoke(bc,backup_app,configured,old_pg,pg,tmp_path):
    who=await identity(bc,backup_app.state.db)
    async with actual_case(bc,who.id,backup_app,old_pg,pg,tmp_path,fee='1.11') as (approved,hosted,grant,_source,account,fill,actual):
        actual_result,_=await actual_operation(approved,actual)
        amendment=await command(approved,fill['recordId'],fill['tradeId'],price='11',fees='1.11')
        done,_=await complete(approved,amendment)
        revoked=await approved.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':grant['grantRevision'],'password':'Synthetic9Pass','code':'','approve':False});assert revoked.status_code==200,revoked.text
        before=await stored_book(hosted.state.db)
        backup_id,_=await backup_tests.create_capsule(approved,backup_app,configured)
        restore=await approved.get('/api/backups/'+backup_id+'/restore-preview',params={'target_id':'isolated-qa'});assert restore.status_code==200,restore.text
        task,_=await backup_tests.submit(approved,'backup.restore',backup_id=backup_id,target_id='isolated-qa',restore_ticket=restore.json()['restore_ticket'])
        restored=await backup_tests.execute(backup_app,configured,UUID(task['id']));assert restored['sessions_revoked']
        target=configured.restore_targets[0]
        settings=configured.model_copy(update={'database_url':target.database_url,'instance_id':target.instance_id,'environment':'test','redis_url':None,'file_root':target.recovery_directory/'files','connection_secret_dir':target.recovery_directory/'connection-secrets','legacy_source_registry_path':None})
        recovered=create_app(settings)
        async with recovered.router.lifespan_context(recovered),httpx.AsyncClient(transport=httpx.ASGITransport(app=recovered,raise_app_exceptions=False),base_url='http://testserver',headers={'origin':'http://testserver'}) as client:
            assert await stored_book(recovered.state.db)==before
            login=await client.post('/api/session/login',json={'login':'BackupQA','password':'Synthetic9Pass'});assert login.status_code==200,login.text
            client.headers['x-csrf-token']=login.json()['csrf']
            assert (await client.get(P+'/operations/'+amendment['requestId'])).json()==done
            assert (await client.get('/api/fees/confirmations/operations/'+actual['requestId'])).json()==actual_result
            cash=(await client.get('/api/cash/accounts/'+account)).json()['currencies'][0]
            assert cash['complete'] and Decimal(cash['balance'])==Decimal('888.89')
            denied=await client.post(P+'/preview',json=await command(client,fill['recordId'],fill['tradeId']))
            assert denied.status_code==409,denied.text
            assert await stored_book(recovered.state.db)==before
