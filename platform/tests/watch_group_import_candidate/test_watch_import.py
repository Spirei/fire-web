"""Real source captures, same permanent claim and canonical watch/record authority."""

import json
from uuid import uuid4

from legacy_source.test_financial_mapping import imported
from legacy_source.test_source_authority import authorized
from request_telemetry_tables import business_table_hashes


async def capture(client,grant,uid=None):
    uid=uid or str(uuid4())
    response=await client.post('/api/watch-group-import/authorizations/'+grant['grantId']+'/snapshots',json={'requestId':uid,'grantRevision':grant['grantRevision']})
    assert response.status_code==200,response.text
    return response.json(),uid


async def preview(client,captured):
    response=await client.post('/api/watch-group-import/manifests/'+captured['manifestId']+'/preview',json={})
    assert response.status_code==200,response.text
    return response.json()


async def apply(client,captured,proof,uid=None):
    command={'requestId':uid or str(uuid4()),'preview':proof['preview'],'expectedGroupRevision':proof['groupRevision'],'expectedRecordRevision':proof['recordRevision']}
    response=await client.post('/api/watch-group-import/manifests/'+captured['manifestId']+'/operations',json=command)
    assert response.status_code==200,response.text
    return response.json(),command


async def hashes(db):
    async with db.connection() as conn,conn.transaction():
        return await business_table_hashes(conn)


async def test_capture_establishes_same_permanent_claim_without_financial_head_or_fake_member_mapping(client,admin,old_pg,app):
    grant=await authorized(client,admin,old_pg)
    captured,uid=await capture(client,grant)
    assert captured['state']=='completed' and captured['metadataCapturedComplete'] and not captured['membershipMappingComplete'],captured
    raw=await client.get('/api/watch-group-import/manifests/'+captured['manifestId']+'/raw')
    assert raw.status_code==200 and 'OTHER-OWNER-SENTINEL' not in raw.text and 'synthetic-secret' not in raw.text and 'password' not in raw.text
    payload=raw.json();assert set(payload['tables'])=={'watch_groups','records'}
    assert set(payload['tables']['records'][0])=={'id','user_id','watch_group_id','watch_group_sort','updated_at'}
    assert payload['source']['readOnly'] and payload['source']['isolation']=='repeatable read'
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM legacy_source_owner_claims')).fetchone())['n']==1
        for table in ('legacy_source_heads','legacy_source_manifests','financial_import_links','trade_ledger','cash_ledger_entries'):
            assert (await (await conn.execute('SELECT count(*) AS n FROM '+table)).fetchone())['n']==0
    proof=await preview(client,captured);assert proof['unknownMembers']==1 and len(proof['groups'])==7
    applied,_=await apply(client,captured,proof)
    assert applied['state']=='completed_with_unknown' and applied['memberCounts']['unknown']==1
    assert not applied['financialHeadAdvanced'] and not applied['financialApplied']
    assert applied['groupMap']['old-custom']=='old-custom'
    unknown=(await client.get('/api/watch-group-import/operations/'+applied['requestId']+'/members')).json()['items']
    assert unknown[0]['state']=='unknown' and unknown[0]['reason']=='original_record_binding_missing_or_deleted'
    before=await hashes(app.state.db)
    assert (await client.get('/api/watch-group-import/operations/'+uid)).json()==captured
    assert (await client.get('/api/watch-group-import/manifests/'+captured['manifestId'])).status_code==200
    assert await hashes(app.state.db)==before


async def test_existing_real_financial_record_link_allows_group_membership_only_without_rewriting_financial_book(client,admin,old_pg,app):
    grant,financial,_account,record,_command=await imported(client,admin,old_pg)
    before=await hashes(app.state.db)
    captured,_=await capture(client,grant);proof=await preview(client,captured)
    assert proof['unknownMembers']==0 and proof['members'][0]['targetRecordId']==record
    result,command=await apply(client,captured,proof)
    assert result['state']=='completed' and result['membershipMappingComplete'],result
    assert result['memberCounts']['applied']==1
    async with app.state.db.connection() as conn:
        changed=await (await conn.execute('SELECT watch_group_id,watch_group_sort,qty::text,cost::text FROM portfolio_records WHERE owner_id=%s AND id=%s',(admin,record))).fetchone()
        assert changed['watch_group_id']=='old-custom' and changed['watch_group_sort']==7
    after=await hashes(app.state.db)
    for table in ('legacy_source_heads','legacy_source_manifests','financial_import_links','financial_import_operations','trade_ledger','cash_ledger_entries','cash_balances','legacy_financial_mapping_heads'):
        if table in before:assert after[table]==before[table],table
    assert (await client.post('/api/watch-group-import/manifests/'+captured['manifestId']+'/operations',json=command)).json()==result
    assert financial['manifestId'] not in json.dumps(captured)  # New metadata source is separate evidence, not a new financial head.


async def test_expired_shared_v2_window_blocks_before_capture_and_existing_history_stays_readable(client,admin,old_pg,app,settings,monkeypatch):
    from datetime import UTC, datetime, timedelta
    from pathlib import Path

    import alcor_api.watch_group_import as module

    grant=await authorized(client,admin,old_pg);captured,uid=await capture(client,grant)
    path=Path(settings.legacy_source_registry_path);registry=json.loads(path.read_text());registry['sources'][0]['migrationWindow']={'notBefore':(datetime.now(UTC)-timedelta(hours=2)).isoformat(),'expiresAt':(datetime.now(UTC)-timedelta(seconds=1)).isoformat(),'state':'active'};path.write_text(json.dumps(registry))
    calls=[]
    async def forbidden(*args,**kwargs):calls.append(True);raise AssertionError('No expired source IO')
    monkeypatch.setattr(module,'capture',forbidden)
    fresh=await client.post('/api/watch-group-import/authorizations/'+grant['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':grant['grantRevision']})
    assert fresh.status_code==409 and '到期' in fresh.text and calls==[]
    assert (await capture(client,grant,uid))[0]==captured and calls==[]
    before=await hashes(app.state.db)
    for route in ['/api/watch-group-import/operations/'+uid,'/api/watch-group-import/manifests/'+captured['manifestId'],'/api/watch-group-import/manifests/'+captured['manifestId']+'/raw']:
        assert (await client.get(route)).status_code==200
    assert await hashes(app.state.db)==before


async def test_window_revoked_between_tables_publishes_nothing_and_original_UUID_never_refetches(client,admin,old_pg,app,settings):
    from pathlib import Path

    grant=await authorized(client,admin,old_pg);tables=[]
    async def revoke(table):
        tables.append(table)
        path=Path(settings.legacy_source_registry_path);value=json.loads(path.read_text());value['sources'][0]['migrationWindow']['state']='revoked';path.write_text(json.dumps(value))
    app.state.watch_group_import.after_table=revoke
    failed,uid=await capture(client,grant)
    assert failed['state']=='failed' and failed['reason']=='source_migration_window_revoked' and tables==['watch_groups']
    assert (await capture(client,grant,uid))[0]==failed and tables==['watch_groups']
    async with app.state.db.connection() as conn:
        for table in ('watch_group_source_manifests','watch_group_source_bindings','legacy_source_owner_claims','legacy_source_heads'):
            assert (await (await conn.execute('SELECT count(*) AS n FROM '+table)).fetchone())['n']==0


async def test_grant_revocation_while_reading_keeps_no_claim_or_manifest(client,admin,old_pg,app):
    grant=await authorized(client,admin,old_pg);tables=[]
    async def revoke(table):
        tables.append(table)
        response=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':grant['grantRevision'],'password':'Synthetic9Pass','code':'','approve':False})
        assert response.status_code==200,response.text
    app.state.watch_group_import.after_table=revoke
    failed,_=await capture(client,grant)
    assert failed['state']=='failed' and tables==['watch_groups']
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM legacy_source_owner_claims')).fetchone())['n']==0
        assert (await (await conn.execute('SELECT count(*) AS n FROM watch_group_source_manifests')).fetchone())['n']==0


async def test_closing_unknown_capture_stops_further_tables_and_only_new_explicit_UUID_can_retry(client,admin,old_pg,app):
    grant=await authorized(client,admin,old_pg);uid=str(uuid4());tables=[]
    async def close(table):
        tables.append(table)
        result=await client.post('/api/watch-group-import/operations/'+uid+'/close',json={})
        assert result.status_code==200 and result.json()['state']=='unknown'
    app.state.watch_group_import.after_table=close
    result,_=await capture(client,grant,uid)
    assert result['state']=='unknown' and tables==['watch_groups']
    assert (await capture(client,grant,uid))[0]==result and tables==['watch_groups']
    async with app.state.db.connection() as conn:assert (await (await conn.execute('SELECT count(*) AS n FROM watch_group_source_manifests')).fetchone())['n']==0
    app.state.watch_group_import.after_table=None
    next_result,_=await capture(client,grant)
    assert next_result['state']=='completed'


async def test_same_name_and_security_do_not_mint_group_or_record_bindings(client,admin,old_pg,app):
    from alcor_api.portfolio_records import PortfolioRecords
    from alcor_api.watchlists import WatchGroups

    group=(await WatchGroups(app.state.db).mutate(admin,'create',{'name':'Old research'},uuid4()))['group']
    records=PortfolioRecords(app.state.db)
    proposed=await records.preview(admin,'create',{'name':'Synthetic stock','code':'AAPL','market':'US','price':None,'qty':None,'cost':None,'group':'','note':''})
    record=(await records.confirm(admin,proposed['previewId'],uuid4()))['recordId']
    grant=await authorized(client,admin,old_pg);captured,_=await capture(client,grant);proof=await preview(client,captured)
    original=next(row for row in proof['groups'] if row['originalId']=='old-custom')
    assert original['state']=='unknown' and original['reason']=='canonical_name_collision'
    assert proof['unknownMembers']==1
    result,_=await apply(client,captured,proof)
    assert 'old-custom' not in result['groupMap']
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT watch_group_id FROM portfolio_records WHERE id=%s AND owner_id=%s',(record,admin))).fetchone())['watch_group_id'] is None
        assert (await (await conn.execute('SELECT count(*) AS n FROM watch_group_source_bindings WHERE target_group_id=%s',(group['id'],))).fetchone())['n']==0


async def test_actual_legacy_market_ID_alias_CRUD_and_mid_apply_failure_are_atomic(client,admin,old_pg,app):
    from alcor_api.native_app_auth import issue_grant

    grant=await authorized(client,admin,old_pg);captured,_=await capture(client,grant);proof=await preview(client,captured)
    async def fail(conn,position,row):
        if position==2:raise RuntimeError('controlled source mapping interruption')
    app.state.watch_group_import.after_step=fail
    command={'requestId':str(uuid4()),'preview':proof['preview'],'expectedGroupRevision':proof['groupRevision'],'expectedRecordRevision':proof['recordRevision']}
    response=await client.post('/api/watch-group-import/manifests/'+captured['manifestId']+'/operations',json=command)
    assert response.status_code==200 and response.json()['state']=='failed'
    failed=(await client.get('/api/watch-group-import/operations/'+command['requestId'])).json()
    assert failed==response.json() and failed['reason']=='source_apply_rolled_back'
    async with app.state.db.connection() as conn:
        for table in ('watch_group_source_bindings','watch_groups','watch_group_operations','watch_group_import_members'):
            assert (await (await conn.execute('SELECT count(*) AS n FROM '+table)).fetchone())['n']==0
    app.state.watch_group_import.after_step=None
    result,_=await apply(client,captured,proof)
    async with app.state.db.connection() as conn:
        user=await (await conn.execute('SELECT * FROM users WHERE id=%s',(admin,))).fetchone();pair=await issue_grant(conn,user,'portfolio.read portfolio.write','Synthetic mapped group client')
    headers={'authorization':'Bearer '+pair['access_token']}
    update=await client.put('/api/v2/watch-groups/old-market-US',json={'name':'Mapped US','visible':1},headers=headers)
    assert update.status_code==200 and update.json()['data']['group']['id']==result['groupMap']['old-market-US']
    before=await hashes(app.state.db)
    assert (await client.get('/api/v2/watch-groups',headers=headers)).status_code==200
    # Native legacy reads retain the pre-existing PG abuse-throttle only.
    after=await hashes(app.state.db)
    assert {k:v for k,v in before.items() if k!='auth_rate_limits'}=={k:v for k,v in after.items() if k!='auth_rate_limits'}
    denied=await client.delete('/api/v2/watch-groups/old-market-US',headers=headers)
    assert denied.status_code==400 and '不可删除' in denied.text


async def test_lost_apply_response_recovers_original_receipt_after_app_restart_and_source_expiry(client,admin,old_pg,app,settings):
    from datetime import UTC, datetime, timedelta
    from pathlib import Path

    import httpx
    from alcor_api.main import create_app

    grant=await authorized(client,admin,old_pg);captured,_=await capture(client,grant);proof=await preview(client,captured)
    async def lose(_):raise RuntimeError('controlled lost response after commit')
    app.state.watch_group_import.after_commit=lose
    command={'requestId':str(uuid4()),'preview':proof['preview'],'expectedGroupRevision':proof['groupRevision'],'expectedRecordRevision':proof['recordRevision']}
    lost=await client.post('/api/watch-group-import/manifests/'+captured['manifestId']+'/operations',json=command)
    assert lost.status_code==503
    path=Path(settings.legacy_source_registry_path);registry=json.loads(path.read_text());registry['sources'][0]['migrationWindow']={'notBefore':(datetime.now(UTC)-timedelta(hours=2)).isoformat(),'expiresAt':(datetime.now(UTC)-timedelta(seconds=1)).isoformat(),'state':'active'};path.write_text(json.dumps(registry))
    second=create_app(settings)
    async with second.router.lifespan_context(second),httpx.AsyncClient(transport=httpx.ASGITransport(app=second),base_url='http://testserver',cookies=client.cookies,headers=dict(client.headers)) as restarted:
        recovered=await restarted.get('/api/watch-group-import/operations/'+command['requestId'])
        assert recovered.status_code==200 and recovered.json()['groupMap']['old-custom']=='old-custom'
        replay=await restarted.post('/api/watch-group-import/manifests/'+captured['manifestId']+'/operations',json=command)
        assert replay.json()==recovered.json()
        history=await restarted.get('/api/watch-group-import/manifests/'+captured['manifestId'])
        assert history.status_code==200 and history.json()['currentSourceAccess']['window']['state']=='expired'
        # Expiry now restricts new I/O; active PG consent still permits archived metadata preview.
        assert (await restarted.post('/api/watch-group-import/manifests/'+captured['manifestId']+'/preview',json={})).status_code==200
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) AS n FROM watch_group_source_bindings')).fetchone())['n']==7


async def test_registry_v1_unknown_window_and_cross_owner_or_caller_raw_flags_cannot_fetch_or_apply(client,admin,old_pg,app,settings):
    from pathlib import Path

    import httpx

    grant=await authorized(client,admin,old_pg);captured,_=await capture(client,grant)
    command={'requestId':str(uuid4()),'grantRevision':grant['grantRevision'],'verified':True}
    forged=await client.post('/api/watch-group-import/authorizations/'+grant['grantId']+'/snapshots',json=command)
    assert forged.status_code==422
    proof=await preview(client,captured)
    forged=await client.post('/api/watch-group-import/manifests/'+captured['manifestId']+'/operations',json={'requestId':str(uuid4()),'preview':proof['preview'],'expectedGroupRevision':proof['groupRevision'],'expectedRecordRevision':proof['recordRevision'],'recordMap':{'old-record-1':'invented'}})
    assert forged.status_code==422
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as other:
        registered=await other.post('/api/session/register',json={'username':'OtherWatchImporter','password':'Synthetic9Pass'});assert registered.status_code==201
        other.headers['x-csrf-token']=registered.json()['csrf']
        assert (await other.get('/api/watch-group-import/manifests/'+captured['manifestId'])).status_code==404
        assert (await other.post('/api/watch-group-import/authorizations/'+grant['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':grant['grantRevision']})).status_code==409
    path=Path(settings.legacy_source_registry_path);registry=json.loads(path.read_text());registry['version']=1;registry['sources'][0].pop('migrationWindow');path.write_text(json.dumps(registry))
    denied=await client.post('/api/watch-group-import/authorizations/'+grant['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':grant['grantRevision']})
    assert denied.status_code==409 and '未配置' in denied.text
    assert (await client.get('/api/watch-group-import/manifests/'+captured['manifestId']+'/raw')).status_code==200


async def test_SQL_forbids_source_group_forgery_and_member_target_without_existing_record_binding(client,admin,old_pg,app):
    import pytest
    from alcor_api.portfolio_records import PortfolioRecords
    from psycopg.errors import CheckViolation

    records=PortfolioRecords(app.state.db);proposed=await records.preview(admin,'create',{'name':'Synthetic stock','code':'AAPL','market':'US','price':None,'qty':None,'cost':None,'group':'','note':''});record=(await records.confirm(admin,proposed['previewId'],uuid4()))['recordId']
    grant=await authorized(client,admin,old_pg);captured,_=await capture(client,grant);proof=await preview(client,captured);result,_=await apply(client,captured,proof)
    async with app.state.db.connection() as conn:
        m=await (await conn.execute('SELECT * FROM watch_group_source_manifests WHERE id=%s',(captured['manifestId'],))).fetchone()
        original=m['manifest']['memberRows'][0]
        with pytest.raises(CheckViolation,match='existing exact original record binding'):
            async with conn.transaction():
                await conn.execute("INSERT INTO watch_group_import_members(owner_id,request_id,manifest_id,sequence,original_record_id,original_group_id,source_row_sha256,target_record_id,target_group_id,state) VALUES(%s,%s,%s,0,'old-record-1','old-custom',%s,%s,'old-custom','applied')",(admin,uuid4(),m['id'],original['rowSha256'],record))
        with pytest.raises(CheckViolation,match='source and group identity'):
            async with conn.transaction():
                await conn.execute("INSERT INTO watch_group_source_bindings(owner_id,source_instance,source_owner,original_group_id,target_group_id,manifest_id,operation_id,source_row_sha256,kind,market) VALUES(%s,%s,%s,'forged','old-custom',%s,%s,%s,'custom','')",(admin,m['source_instance'],m['source_owner'],m['id'],result['requestId'],'0'*64))
        with pytest.raises(CheckViolation,match='immutable'):
            async with conn.transaction():await conn.execute('DELETE FROM watch_group_source_manifests WHERE id=%s',(m['id'],))
        assert (await (await conn.execute('SELECT watch_group_id FROM portfolio_records WHERE id=%s',(record,))).fetchone())['watch_group_id'] is None




async def test_existing_ordering_projections_preserve_observed_group_order_and_true_metadata_time_only(client,admin,app):
    """Algorithm vector only; actual source trust/link tests are separate above."""
    from datetime import UTC

    from alcor_api.portfolio_records import PortfolioRecords
    from alcor_api.watchlists import WatchGroups

    groups=WatchGroups(app.state.db);group=(await groups.mutate(admin,'create',{'name':'Ordering vector'},uuid4()))['group']
    records=PortfolioRecords(app.state.db);created=[]
    for code in ('AAPL','MSFT'):
        proposal=await records.preview(admin,'create',{'name':code,'code':code,'market':'US','price':None,'qty':None,'cost':None,'group':'','note':''})
        created.append((await records.confirm(admin,proposal['previewId'],uuid4()))['record'])
    first,second=created
    # Original TEXT ordering across offsets is observable; it must not be
    # silently replaced by chronological sort or invented synthetic instants.
    payload={'groups':[{'originalId':'vector-group','targetId':group['id'],'name':group['name'],'kind':'custom','market':'','sort':group['sort'],'visible':-1}],
        'members':[{'originalRecordId':'vector-second','recordId':second['id'],'groupOriginalId':'vector-group','sort':0,'expectedRevision':second['revision'],'sourceOrder':0,'sourceUpdatedAt':'2025-12-31T11:00:00+00:00'},
                   {'originalRecordId':'vector-first','recordId':first['id'],'groupOriginalId':'vector-group','sort':0,'expectedRevision':first['revision'],'sourceOrder':1,'sourceUpdatedAt':'2026-01-01T00:30:00+00:00'}]}
    current=await groups.list(admin)
    imported_order=await groups.mutate(admin,'source-import',payload,uuid4(),current['revision'])
    result=await records.list(admin,view=group['id'])
    assert [row['id'] for row in result['records']]==[second['id'],first['id']]
    assert all(row['watchGroupSort']==0 for row in result['records'])
    async with app.state.db.connection() as conn:
        projection=await (await conn.execute('SELECT record_id,display_timestamp FROM portfolio_legacy_ordering WHERE owner_id=%s',(admin,))).fetchall()
        assert {row['record_id']:row['display_timestamp'].astimezone(UTC).isoformat() for row in projection}=={first['id']:'2026-01-01T00:30:00+00:00',second['id']:'2025-12-31T11:00:00+00:00'}
        assert (await (await conn.execute('SELECT count(*) AS n FROM cash_ledger_entries')).fetchone())['n']==0
        assert (await (await conn.execute('SELECT count(*) AS n FROM trade_ledger')).fetchone())['n']==0
    for item in payload['members']:
        item['expectedRevision']=next(row['revision'] for row in result['records'] if row['id']==item['recordId'])
    unchanged=await groups.mutate(admin,'source-import',payload,uuid4(),imported_order['revision'])
    assert unchanged['revision']==imported_order['revision'] and all(row['state']=='unchanged' for row in unchanged['members'])
    assert (await records.list(admin,view=group['id']))['collectionRevision']==result['collectionRevision']
    for item in payload['members']:item['sourceOrder']=1-item['sourceOrder']
    changed=await groups.mutate(admin,'source-import',payload,uuid4(),unchanged['revision'])
    reordered=await records.list(admin,view=group['id'])
    assert [row['id'] for row in reordered['records']]==[first['id'],second['id']]
    assert changed['revision']>unchanged['revision'] and reordered['collectionRevision']==result['collectionRevision']+2
    forbidden=await client.post('/api/watch-groups/operations',json={'requestId':str(uuid4()),'expectedRevision':result['collectionRevision'],'action':'source-import','data':payload})
    assert forbidden.status_code==422


async def test_watch_capture_and_financial_capture_share_pending_budget_and_original_uuid_does_not_read_twice(client,admin,old_pg,app):
    import asyncio

    grant=await authorized(client,admin,old_pg);entered=asyncio.Event();resume=asyncio.Event();calls=[]
    async def pause(table):
        calls.append(table)
        if table=='watch_groups':entered.set();await resume.wait()
    app.state.watch_group_import.after_table=pause;uid=str(uuid4());first=asyncio.create_task(capture(client,grant,uid))
    await asyncio.wait_for(entered.wait(),3)
    try:
        budget=(await client.get('/api/legacy-financial/export-budget')).json()
        assert budget['ownerPending']==1 and budget['pendingOriginalRequestIds']==[uid]
        repeated,_=await capture(client,grant,uid)
        assert repeated['state']=='reading' and calls==['watch_groups']
        blocked=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':grant['grantRevision'],'predecessorHash':None})
        assert blocked.status_code==429,blocked.text
        blocked=await client.post('/api/watch-group-import/authorizations/'+grant['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':grant['grantRevision']})
        assert blocked.status_code==429,blocked.text
    finally:resume.set();captured,_=await first
    assert captured['state']=='completed' and calls==['watch_groups','records']
    budget=(await client.get('/api/legacy-financial/export-budget')).json()
    assert budget['ownerPending']==0 and budget['ownerStoredBytes']>0
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM legacy_source_heads')).fetchone())['n']==0


def test_equal_source_sort_keys_remain_unknown_and_missing_source_time_is_never_synthesized():
    """Synthetic algorithm vector; not an assertion of trusted official history."""
    from alcor_api.watch_group_source_contract import index

    def cell(text,kind='text'):return {'null':text is None,'text':text,'storageType':kind}
    row={'user_id':cell('old-owner'),'watch_group_id':cell('custom'),'watch_group_sort':cell('0','integer'),'updated_at':cell(None)}
    source={'source':{'owner':'old-owner','timezone':'America/New_York'},'tables':{'watch_groups':[],'records':[{**row,'id':cell('a')},{**row,'id':cell('b')}]}}
    result=index(source)
    assert all(row['orderingState']=='unknown_equal_source_keys' and row['sourceOrder'] is None and row['sourceUpdatedAt'] is None and row['metadataTimeState']=='unknown' for row in result['memberRows'])
    assert not result['membershipMappingComplete']
