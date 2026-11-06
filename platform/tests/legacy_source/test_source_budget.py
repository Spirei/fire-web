import asyncio
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
import psycopg

from alcor_api.main import create_app
from alcor_api.cli import create_user
from .test_source_authority import authorized,export


@pytest.mark.asyncio
async def test_persistent_owner_pending_slot_prevents_new_source_read_and_original_uuid_is_lookup(client,admin,old_pg,app,settings):
    grant=await authorized(client,admin,old_pg);entered=asyncio.Event();resume=asyncio.Event();reads=0
    async def pause():
        nonlocal reads
        reads+=1;entered.set();await resume.wait()
    app.state.source_authority.after_read=pause
    command={'requestId':str(uuid4()),'grantRevision':grant['grantRevision'],'predecessorHash':None};path='/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots'
    first=asyncio.create_task(client.post(path,json=command))
    await asyncio.wait_for(entered.wait(),3)
    restarted=create_app(settings)
    async with restarted.router.lifespan_context(restarted):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=restarted),base_url='http://testserver',cookies=client.cookies,headers=dict(client.headers)) as other:
            response=await other.post(path,json={**command,'requestId':str(uuid4())});assert response.status_code==429,response.text
            receipt=await other.get('/api/legacy-financial/operations/'+command['requestId']);assert receipt.json()['state']=='reading'
            repeated=await other.post(path,json=command);assert repeated.json()==receipt.json()
            status=await other.get('/api/legacy-financial/export-budget');assert status.json()['ownerPending']==1 and not status.json()['automaticHistoryPruning']
    assert reads==1
    resume.set();response=await first;assert response.status_code==200 and response.json()['state']=='completed',response.text
    assert (await client.get('/api/legacy-financial/export-budget')).json()['ownerPending']==0


@pytest.mark.asyncio
async def test_persistent_frequency_budget_rejects_new_jobs_without_pruning_or_recounting_original_uuid(client,admin,old_pg,app):
    grant=await authorized(client,admin,old_pg)
    async with app.state.db.connection() as conn:await conn.execute('UPDATE legacy_source_export_policy SET owner_hourly=1 WHERE singleton')
    receipt,command,path=await export(client,grant)
    response=await client.post(path,json={**command,'requestId':str(uuid4()),'predecessorHash':receipt['manifestSha256']});assert response.status_code==429,response.text
    assert (await client.post(path,json=command)).json()==receipt
    async with app.state.db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM legacy_source_manifests')).fetchone())['n']==1
        assert (await(await conn.execute('SELECT attempts FROM legacy_source_export_windows WHERE scope=%s',('owner:'+admin,))).fetchone())['attempts']==1


@pytest.mark.asyncio
async def test_capacity_budget_retains_all_original_evidence_and_refuses_fresh_export(client,admin,old_pg,app):
    grant=await authorized(client,admin,old_pg);receipt,command,path=await export(client,grant)
    raw_path='/api/legacy-financial/manifests/'+receipt['manifestId']+'/raw';raw=(await client.get(raw_path)).content
    async with app.state.db.connection() as conn:
        await conn.execute('UPDATE legacy_source_export_policy SET owner_bytes=16777216,reservation_bytes=16777216 WHERE singleton')
    response=await client.post(path,json={**command,'requestId':str(uuid4()),'predecessorHash':receipt['manifestSha256']});assert response.status_code==429 and '容量预算' in response.text,response.text
    assert (await client.get(raw_path)).content==raw
    assert (await client.get('/api/legacy-financial/operations/'+command['requestId'])).json()==receipt


@pytest.mark.asyncio
async def test_instance_pending_budget_is_shared_by_two_distinct_platform_owners(client,admin,old_pg,app,settings,pg):
    grant=await authorized(client,admin,old_pg)
    other_owner=await create_user(settings,'OtherBudgetOwner','Synthetic9Pass',role='user');old_owner='another-old-owner'
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database),autocommit=True) as conn:
        await conn.execute('INSERT INTO users(id) VALUES(%s)',(old_owner,))
    second_definition=replace(old_pg,alias='another-old-scope',owners=(old_owner,));app.state.source_authority.registry[second_definition.alias]=second_definition
    registered=await client.post('/api/legacy-financial/authorizations',json={'requestId':str(uuid4()),'sourceAlias':second_definition.alias,'sourceOwner':old_owner,'targetUserId':other_owner});assert registered.status_code==200,registered.text
    second_grant=registered.json()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as other:
        login=await other.post('/api/session/login',json={'login':'OtherBudgetOwner','password':'Synthetic9Pass'});other.headers['x-csrf-token']=login.json()['csrf']
        accepted=await other.post('/api/legacy-financial/authorizations/'+second_grant['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':1,'password':'Synthetic9Pass','code':'','approve':True});assert accepted.status_code==200,accepted.text
        second_grant=accepted.json()
        async with app.state.db.connection() as conn:await conn.execute('UPDATE legacy_source_export_policy SET instance_pending=1 WHERE singleton')
        entered=asyncio.Event();resume=asyncio.Event()
        async def pause():entered.set();await resume.wait()
        app.state.source_authority.after_read=pause
        first=asyncio.create_task(export(client,grant))
        await asyncio.wait_for(entered.wait(),3)
        try:
            response=await other.post('/api/legacy-financial/authorizations/'+second_grant['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':2,'predecessorHash':None})
            assert response.status_code==429 and admin not in response.text,response.text
        finally:resume.set();await first
