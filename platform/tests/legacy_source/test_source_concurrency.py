from source_window_fixture import active_window
import asyncio
import copy
import json
from dataclasses import replace
from decimal import Decimal
from uuid import uuid4

import psycopg
import pytest
from psycopg.types.json import Jsonb
from psycopg.errors import CheckViolation

from alcor_api.source_snapshot import PgSnapshot,SourceDefinition,canonical,schema_digest,sha
from alcor_api.source_mapping import Mapping,fee_bytes
from .synthetic_legacy import OWNER
from .test_source_authority import authorized,export,target


@pytest.mark.asyncio
async def test_pg_export_is_one_read_snapshot_while_independent_writer_commits(old_pg,pg):
    async def concurrent_writer(table):
        if table!='records':return
        async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database),autocommit=True) as conn:
            await conn.execute("UPDATE fund_transactions SET amount=2000 WHERE id='old-fund-opening'")
    snapshot=await PgSnapshot().export(old_pg,OWNER,after_table=concurrent_writer)
    opening=next(row for row in snapshot['tables']['fund_transactions']['rows'] if row['id']['text']=='old-fund-opening')
    assert Decimal(opening['amount']['text'])==1000
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database)) as conn:
        assert (await(await conn.execute("SELECT amount FROM fund_transactions WHERE id='old-fund-opening'")).fetchone())[0]==2000




async def ready(client,admin,old_pg):
    grant=await authorized(client,admin,old_pg);source,*_=await export(client,grant);account,record=await target(client)
    data={'requestId':str(uuid4()),'sourceId':source['sourceId'],'sourceHash':source['financialSha256'],'confirmedSourceOwner':OWNER,'targetUserId':admin,'accountMap':{'old-broker-1':account},'recordMap':{'old-record-1':record},'confirmedHistoricalOnly':True}
    response=await client.post('/api/financial-import/preview',json=data);assert response.status_code==200 and response.json()['ready'],response.text
    return grant,source,data,response.json()['preview']


@pytest.mark.asyncio
async def test_grant_revocation_wins_while_financial_submit_waits_on_real_pg_row_lock(client,admin,old_pg,app):
    grant,source,data,proof=await ready(client,admin,old_pg)
    async with app.state.db.connection() as blocker:
        async with blocker.transaction():
            await blocker.execute('SELECT * FROM legacy_source_grants WHERE id=%s FOR UPDATE',(grant['grantId'],))
            request=asyncio.create_task(client.post('/api/financial-import/operations',json={'data':data,'preview':proof}))
            await asyncio.sleep(0.1)
            assert not request.done()
            await blocker.execute("UPDATE legacy_source_grants SET state='revoked',revision=revision+1,revoked_at=clock_timestamp() WHERE id=%s",(grant['grantId'],))
        response=await request
    assert response.status_code==409,response.text
    async with app.state.db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==0
        assert (await(await conn.execute('SELECT count(*) n FROM cash_ledger_entries')).fetchone())['n']==0


@pytest.mark.asyncio
async def test_inflight_financial_commit_precedes_revocation_then_old_proofs_are_unusable(client,admin,old_pg,app):
    grant,source,data,proof=await ready(client,admin,old_pg)
    reached=asyncio.Event();resume=asyncio.Event()
    async def pause(conn,index,item):
        if index==0:reached.set();await resume.wait()
    app.state.authorized_financial_import.after_step=pause
    submission=asyncio.create_task(client.post('/api/financial-import/operations',json={'data':data,'preview':proof}))
    await asyncio.wait_for(reached.wait(),3)
    revocation=asyncio.create_task(client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':grant['grantRevision'],'password':'Synthetic9Pass','code':'','approve':False}))
    await asyncio.sleep(0.1);assert not revocation.done()
    resume.set();response=await submission;assert response.status_code==200 and response.json()['financialApplied']
    assert (await revocation).status_code==200
    app.state.authorized_financial_import.after_step=None
    response=await client.post('/api/financial-import/preview',json={**data,'requestId':str(uuid4())});assert response.status_code==409


@pytest.mark.asyncio
async def test_revocation_during_source_read_leaves_only_original_uuid_failed_receipt(client,admin,old_pg,app):
    grant=await authorized(client,admin,old_pg)
    async def revoke():
        response=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':grant['grantRevision'],'password':'Synthetic9Pass','code':'','approve':False})
        assert response.status_code==200
    app.state.source_authority.after_read=revoke
    result,command,path=await export(client,grant)
    assert result['state']=='failed' and not result['financialApplied']
    assert (await client.get('/api/legacy-financial/operations/'+command['requestId'])).json()==result
    assert (await client.post(path,json=command)).json()==result
    async with app.state.db.connection() as conn:
        for table in ('legacy_source_manifests','financial_import_sources','fee_legacy_inventory_snapshots'):
            assert (await(await conn.execute('SELECT count(*) n FROM '+table)).fetchone())['n']==0


@pytest.mark.asyncio
async def test_database_rejects_forged_financial_bytes_fee_class_complete_and_revoked_correction(client,admin,old_pg,app):
    grant,source,data,proof=await ready(client,admin,old_pg)
    async with app.state.db.connection() as conn:
        original=await(await conn.execute('SELECT * FROM legacy_source_manifests WHERE id=%s',(source['manifestId'],))).fetchone()
        with pytest.raises(CheckViolation,match='actual fills require|immutable'):
            async with conn.transaction():await conn.execute("UPDATE legacy_source_view_bindings SET view_sha256=%s WHERE owner_id=%s",('f'*64,admin))
        with pytest.raises(CheckViolation,match='original manifest|predecessor CAS'):
            async with conn.transaction():await conn.execute("UPDATE legacy_source_heads SET manifest_sha256=%s,revision=revision+1 WHERE owner_id=%s",('f'*64,admin))
        with pytest.raises(CheckViolation,match='source scope cannot change'):
            async with conn.transaction():await conn.execute("UPDATE legacy_source_grants SET source_owner='forged-owner',revision=revision+1 WHERE id=%s",(grant['grantId'],))
        forged=json.loads(bytes(original['financial_raw']));forged['orders'][0]['feeAuthority']='broker_reported'
        forged_bytes=canonical(forged)
        with pytest.raises(CheckViolation,match='authorized original manifest bytes'):
            async with conn.transaction():
                await conn.execute('INSERT INTO financial_import_sources(owner_id,id,source_instance,source_owner,source_version,sha256,raw,source_manifest_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(admin,uuid4(),old_pg.instance,OWNER,'forged',sha(forged_bytes),forged_bytes,source['manifestId']))
        forged_fee=copy.deepcopy(original['fee_payload']);forged_fee['orders'][0]['feeAuthority']='broker_reported';forged_fee['complete']=not forged_fee['complete']
        with pytest.raises(CheckViolation,match='same authorized source manifest'):
            async with conn.transaction():
                await conn.execute('INSERT INTO fee_legacy_inventory_snapshots(owner_id,source_digest,source_instance,source_owner,complete,order_count,payload,source_manifest_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(admin,sha(fee_bytes(forged_fee)),old_pg.instance,OWNER,forged_fee['complete'],2,Jsonb(forged_fee),source['manifestId']))
    response=await client.post('/api/financial-import/operations',json={'data':data,'preview':proof});assert response.json()['financialApplied']
    response=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':grant['grantRevision'],'password':'Synthetic9Pass','code':'','approve':False});assert response.status_code==200
    async with app.state.db.connection() as conn:
        trade=await(await conn.execute('SELECT id FROM trade_ledger LIMIT 1')).fetchone()
        with pytest.raises(CheckViolation,match='active shared source manifest'):
            async with conn.transaction():
                await conn.execute('INSERT INTO trade_fee_corrections(id,owner_id,trade_id,request_id,old_fees,new_fees,detail) VALUES(%s,%s,%s,%s,0,1,%s)',(uuid4(),admin,trade['id'],uuid4(),Jsonb({})))
        assert (await(await conn.execute('SELECT count(*) n FROM trade_fee_corrections')).fetchone())['n']==0
