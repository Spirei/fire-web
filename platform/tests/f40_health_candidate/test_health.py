"""Live process and actual read-only database observations; no invented provider health."""
import httpx
from uuid import uuid4
from activity_read_candidate.test_legacy_activity_cookie import legacy_client
from alcor_api.connections import current_config

async def test_real_process_and_database_status_no_implicit_provider_probe(app,db,settings):
    old,token=await legacy_client(app,db,settings,role='admin',name='F40Admin',cookie='fire_session')
    async with old, httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as anonymous:
        health=await anonymous.get('/api/health')
        assert health.status_code==200
        value=health.json()['data'];assert value['status']=='ok' and value['authority']=='process_liveness_only'
        assert value['effectiveSource'] is None and value['futuOpenD']['available'] is None
        status=await old.get('/api/db/status')
        assert status.status_code==200,status.text
        row=status.json()['status'];assert row['versionKnown'] is True and row['version'].startswith('PostgreSQL ')
        assert row['sizeBytes']>0 and 'users' in row['tables']
        for headers in [[('authorization','')],[('authorization','Basic invalid')],[('authorization','Bearer '+token),('authorization','Bearer '+token)]]:
            assert (await old.get('/api/db/status',headers=headers)).status_code==401
        assert (await anonymous.get('/api/db/status')).status_code==401
        assert (await anonymous.get('/api/db/status',headers={'authorization':'Bearer '+token})).status_code==200

async def test_actual_readonly_database_probe_original_uuid_and_config_unchanged(app,db,settings):
    old,_=await legacy_client(app,db,settings,role='admin',name='F40Probe',cookie='fire_session')
    config,password=current_config(settings,'postgresql')
    payload={'host':config.host,'port':config.port,'database':config.database,'pgUser':config.username,'password':password,'requestId':str(uuid4()),'revision':None,'sslMode':config.ssl_mode}
    async with old:
        response=await old.post('/api/db/test',json=payload)
        assert response.status_code==200,response.text
        body=response.json();assert body['ok'] is True and body['result']['status']=='passed'
        assert (await old.post('/api/db/test',json=payload)).json()==body
        changed=await old.post('/api/db/test',json={**payload,'database':'unrelated'})
        assert changed.status_code==422 and '重新输入密码' in changed.text,changed.text
        async with db.connection() as conn:
            assert (await(await conn.execute('SELECT count(*) AS n FROM connection_settings')).fetchone())['n']==0
            assert (await(await conn.execute('SELECT count(*) AS n FROM connection_receipts')).fetchone())['n']==1
