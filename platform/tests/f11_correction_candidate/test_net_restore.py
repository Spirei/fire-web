"""One real encrypted isolated restore for flat HKD/CNY units and original UUID."""
from decimal import Decimal
from uuid import UUID,uuid4

import httpx
import test_backups as backup_tests
from alcor_api.main import create_app
from fee_source_test_helpers import identity
from test_legacy_trade_corrections import native_headers
from test_trading import setup
from test_legacy_trade_restore import preserved

configured=backup_tests.configured
backup_app=backup_tests.backup_app
bc=backup_tests.bc


async def test_encrypted_restore_keeps_net_units_originals_and_same_uuid_receipt(bc,backup_app,configured):
    db=backup_app.state.db;who=await identity(bc,db)
    _,record=await setup(bc,market='HK',account_market='CN',code='00700',currency='CNY')
    headers=await native_headers(db,who.id)
    body={'requestId':str(uuid4()),'recordId':record['id'],'side':'buy','mode':'record','qty':'2','price':'10','fees':'1',
          'tradedAt':'2026-09-01T12:00:00Z','tif':'gtc','session':'REGULAR','settlementAmount':'19'}
    created=await bc.post('/api/v2/orders',headers=headers,json=body);assert created.status_code==200,created.text
    oid=created.json()['data']['order']['id'];change={**body,'requestId':str(uuid4()),'price':'12','settlementAmount':'23'}
    done=await bc.put('/api/v2/orders/'+oid,headers=headers,json=change);assert done.status_code==200,done.text
    before=await preserved(db)
    backup_id,_=await backup_tests.create_capsule(bc,backup_app,configured)
    preview=await bc.get('/api/backups/'+backup_id+'/restore-preview',params={'target_id':'isolated-qa'});assert preview.status_code==200,preview.text
    task,_=await backup_tests.submit(bc,'backup.restore',backup_id=backup_id,target_id='isolated-qa',restore_ticket=preview.json()['restore_ticket'])
    result=await backup_tests.execute(backup_app,configured,UUID(task['id']));assert result['sessions_revoked']
    target=configured.restore_targets[0]
    settings=configured.model_copy(update={'database_url':target.database_url,'instance_id':target.instance_id,'environment':'test','redis_url':None,
        'file_root':target.recovery_directory/'files','connection_secret_dir':target.recovery_directory/'connection-secrets','legacy_source_registry_path':None})
    recovered=create_app(settings)
    async with recovered.router.lifespan_context(recovered),httpx.AsyncClient(transport=httpx.ASGITransport(app=recovered,raise_app_exceptions=False),
            base_url='http://testserver',headers={'origin':'http://testserver'}) as client:
        assert await preserved(recovered.state.db)==before
        fresh=await native_headers(recovered.state.db,who.id)
        replay=await client.put('/api/v2/orders/'+oid,headers=fresh,json=change)
        assert replay.status_code==200 and replay.json()==done.json(),replay.text
        rows=(await client.get('/api/v2/orders',headers=fresh)).json()['data']
        async with recovered.state.db.connection() as conn:
            event=(await(await conn.execute('SELECT replacement,currency,cash_basis FROM trade_amendments WHERE owner_id=%s',(who.id,))).fetchone())
            assert event['currency']=='CNY' and event['cash_basis']=='flat_actual_net'
            assert event['replacement']['currency']=='HKD' and event['replacement']['settlement_currency']=='CNY'
            assert Decimal(event['replacement']['settlement_amount'])==23
            assert (await(await conn.execute("SELECT sum(amount) total FROM cash_ledger_entries WHERE owner_id=%s AND currency='CNY'",(who.id,))).fetchone())['total']==977
