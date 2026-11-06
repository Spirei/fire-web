from uuid import UUID
from decimal import Decimal
import httpx
import test_backups as backup_tests
from alcor_api.main import create_app
from test_calculated_fee_actual_guard import calculated_case
from test_native_actual_fees import confirmation,complete,P
from test_fee_integration_restore import financial_state

configured=backup_tests.configured
backup_app=backup_tests.backup_app
bc=backup_tests.bc


async def native_state(db):
    async with db.connection() as conn:return await(await conn.execute('SELECT * FROM native_actual_fee_confirmations ORDER BY 1,2')).fetchall()


async def test_native_actual_confirmation_survives_actual_encrypted_restore_without_replaying_the_same_original_uuid(bc,backup_app,configured):
    db=backup_app.state.db
    aid,first,registration,registered,_,other,b=await calculated_case(bc,db)
    data=await confirmation(bc,aid,registered['tradeId'],'0')
    result,proof=await complete(bc,data)
    original=await financial_state(db);native=await native_state(db)
    backup_id,_=await backup_tests.create_capsule(bc,backup_app,configured)
    preview=await bc.get('/api/backups/'+backup_id+'/restore-preview',params={'target_id':'isolated-qa'});assert preview.status_code==200,preview.text
    task,_=await backup_tests.submit(bc,'backup.restore',backup_id=backup_id,target_id='isolated-qa',restore_ticket=preview.json()['restore_ticket'])
    restored=await backup_tests.execute(backup_app,configured,UUID(task['id']));assert restored['sessions_revoked']
    target=configured.restore_targets[0]
    settings=configured.model_copy(update={'database_url':target.database_url,'instance_id':target.instance_id,'environment':'test','redis_url':None,
      'file_root':target.recovery_directory/'files','connection_secret_dir':target.recovery_directory/'connection-secrets','legacy_source_registry_path':None})
    recovered=create_app(settings)
    async with recovered.router.lifespan_context(recovered),httpx.AsyncClient(transport=httpx.ASGITransport(app=recovered,raise_app_exceptions=False),base_url='http://testserver',headers={'origin':'http://testserver'}) as client:
        assert await financial_state(recovered.state.db)==original and await native_state(recovered.state.db)==native
        assert (await client.get(P+'/operations/'+data['requestId'])).status_code==401
        login=await client.post('/api/session/login',json={'login':'BackupQA','password':'Synthetic9Pass'});assert login.status_code==200,login.text
        client.headers['x-csrf-token']=login.json()['csrf']
        assert (await client.get(P+'/operations/'+data['requestId'])).json()==result
        assert (await client.post(P+'/operations',json={'data':data,'preview':proof['previewRevision']})).json()==result
        assert (await client.get('/api/trading/operations/'+registration['requestId'])).json()==registered
        cash=(await client.get('/api/cash/accounts/'+aid)).json()['currencies'][0]
        assert cash['complete'] and Decimal(cash['balance'])==800,cash
        assert await financial_state(recovered.state.db)==original and await native_state(recovered.state.db)==native
