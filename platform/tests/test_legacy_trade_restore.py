from datetime import UTC, datetime
from uuid import UUID, uuid4

import httpx
import test_backups as backup_tests
from alcor_api.main import create_app
from fee_source_test_helpers import identity
from test_legacy_trade_corrections import draft, native_headers
from test_trading import setup

configured=backup_tests.configured
backup_app=backup_tests.backup_app
bc=backup_tests.bc


async def preserved(db):
    tables=('trade_ledger','cash_ledger_entries','portfolio_records','trade_operations','trade_presentation_ids','trade_registration_contexts','trade_amendments','trade_correction_members')
    async with db.connection() as conn:return {table:await(await conn.execute('SELECT * FROM '+table+' ORDER BY 1,2')).fetchall() for table in tables}


async def test_actual_encrypted_restore_preserves_old_views_context_display_identity_and_original_uuid(bc,backup_app,configured):
    db=backup_app.state.db;who=await identity(bc,db)
    _account,record=await setup(bc,name='Legacy restoration')
    headers=await native_headers(db,who.id);prefix='/api/v2/account-assets'
    snapshot=(await bc.get(prefix+'/trading',headers=headers)).json()['data'];body=draft(who.id,record,snapshot)
    p=await bc.post(prefix+'/trading/preview',json=body,headers=headers);assert p.status_code==200,p.text
    body={**body,'requestId':str(uuid4())}
    sent=await bc.post(prefix+'/trading/submissions',json=body,headers=headers);assert sent.status_code==200,sent.text
    original=sent.json()['data']
    state=(await bc.get(prefix+'/trading',headers=headers)).json()['data'];first=state['orders'][0]
    second=draft(who.id,{'id':record['id'],'revision':first['recordRevision']},state,price=20,fees=2,tradedAt='2026-09-02T12:00:00Z')
    assert (await bc.post(prefix+'/trading/preview',json=second,headers=headers)).status_code==200
    entered=await bc.post(prefix+'/trading/submissions',json={**second,'requestId':str(uuid4())},headers=headers);assert entered.status_code==200,entered.text
    state=(await bc.get(prefix+'/trading',headers=headers)).json()['data']
    merge={'requestId':str(uuid4()),'accountId':who.id,'snapshotRevision':state['snapshotRevision'],'recordId':record['id'],'recordRevision':state['orders'][0]['recordRevision'],'action':'merge','orders':[{'id':item['id'],'revision':item['revision']} for item in state['orders']],'timeSourceOrderId':first['id'],'replacement':{'qty':20,'price':15,'fees':0,'tradedAt':first['tradedAt']}}
    proof=await bc.post(prefix+'/trading/corrections/preview',json=merge,headers=headers);assert proof.status_code==200,proof.text
    merged=await bc.post(prefix+'/trading/corrections',json={**merge,'previewRevision':proof.json()['data']['previewRevision']},headers=headers);assert merged.status_code==200,merged.text
    merged=merged.json()['data'];active=next(item for item in merged['data']['snapshot']['orders'] if item['status']=='filled')
    before=await preserved(db)
    backup_id,_=await backup_tests.create_capsule(bc,backup_app,configured)
    preview=await bc.get('/api/backups/'+backup_id+'/restore-preview',params={'target_id':'isolated-qa'});assert preview.status_code==200,preview.text
    task,_=await backup_tests.submit(bc,'backup.restore',backup_id=backup_id,target_id='isolated-qa',restore_ticket=preview.json()['restore_ticket'])
    result=await backup_tests.execute(backup_app,configured,UUID(task['id']));assert result['sessions_revoked']
    target=configured.restore_targets[0];settings=configured.model_copy(update={'database_url':target.database_url,'instance_id':target.instance_id,'environment':'test','redis_url':None,'file_root':target.recovery_directory/'files','connection_secret_dir':target.recovery_directory/'connection-secrets','legacy_source_registry_path':None})
    recovered=create_app(settings)
    async with recovered.router.lifespan_context(recovered),httpx.AsyncClient(transport=httpx.ASGITransport(app=recovered,raise_app_exceptions=False),base_url='http://testserver',headers={'origin':'http://testserver'}) as client:
        assert await preserved(recovered.state.db)==before
        fresh_headers=await native_headers(recovered.state.db,who.id)
        receipt=await client.get(prefix+'/operations/'+body['requestId'],headers=fresh_headers)
        assert receipt.status_code==200 and receipt.json()['data']==original,receipt.text
        current=await client.get(prefix+'/trading',headers=fresh_headers);assert current.status_code==200,current.text
        current=current.json()['data'];current_active=next(item for item in current['orders'] if item['status']=='filled')
        assert current_active['orderNo']==active['orderNo'] and current_active['registrationContextKnown'] and current['cash']['nativeBalancesByCurrency']=={'USD':700}
        assert (await client.get(prefix+'/operations/'+merge['requestId'],headers=fresh_headers)).json()['data']==merged
        next_body=draft(who.id,{'id':record['id'],'revision':current_active['recordRevision']},current,qty=1,price=10,fees=0,tradedAt=datetime.now(UTC).isoformat())
        assert (await client.post(prefix+'/trading/preview',json=next_body,headers=fresh_headers)).status_code==200
        next_done=await client.post(prefix+'/trading/submissions',json={**next_body,'requestId':str(uuid4())},headers=fresh_headers);assert next_done.status_code==200,next_done.text
        assert next_done.json()['data']['data']['items'][0]['orderNo']!=current_active['orderNo']
        assert (await client.get(prefix+'/operations/'+body['requestId'],headers=fresh_headers)).json()['data']==original
