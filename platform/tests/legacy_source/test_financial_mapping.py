import copy
from uuid import uuid4

import httpx
import pytest
from psycopg.errors import CheckViolation
from psycopg.types.json import Jsonb

from .helpers import authorized,export,target
from .synthetic_legacy import OWNER


async def imported(client,admin,old_pg):
    grant=await authorized(client,admin,old_pg);snapshot,*_=await export(client,grant)
    account,record=await target(client)
    command={'requestId':str(uuid4()),'sourceId':snapshot['sourceId'],'sourceHash':snapshot['financialSha256'],'confirmedSourceOwner':OWNER,'targetUserId':admin,'accountMap':{'old-broker-1':account},'recordMap':{'old-record-1':record},'confirmedHistoricalOnly':True}
    response=await client.post('/api/financial-import/preview',json=command);assert response.status_code==200 and response.json()['ready'],response.text
    response=await client.post('/api/financial-import/operations',json={'data':command,'preview':response.json()['preview']});assert response.status_code==200 and response.json()['financialApplied'],response.text
    return grant,snapshot,account,record,command


def mapping_command(admin,snapshot,financial,revision=0):
    return {'requestId':str(uuid4()),'manifestId':snapshot['manifestId'],'importRequestId':financial['requestId'],'targetUserId':admin,'expectedMappingRevision':revision}


async def preview(client,data):
    response=await client.post('/api/legacy-financial/mappings/preview',json=data)
    assert response.status_code==200 and response.json()['ready'],response.text
    return response.json()['preview']


@pytest.mark.asyncio
async def test_same_manifest_receipt_links_make_derived_version_without_rewriting_raw_or_ledger(client,admin,old_pg,app):
    grant,snapshot,account,record,finance=await imported(client,admin,old_pg)
    async with app.state.db.connection() as conn:
        before=await(await conn.execute('SELECT raw,financial_raw,fee_payload FROM legacy_source_manifests WHERE id=%s',(snapshot['manifestId'],))).fetchone()
        inventory=await(await conn.execute('SELECT * FROM fee_legacy_inventory_orders WHERE owner_id=%s ORDER BY original_order_id',(admin,))).fetchall()
        ledgers=await(await conn.execute('SELECT (SELECT count(*) FROM trade_ledger) trades,(SELECT count(*) FROM cash_ledger_entries) cash')).fetchone()
    old=(await client.get('/api/fees/repairs',params={'brokerAccountId':account})).json()
    assert old['legacyCoverage']['status']=='partial'
    data=mapping_command(admin,snapshot,finance);proof=await preview(client,data)
    response=await client.post('/api/legacy-financial/mappings/operations',json={'data':data,'preview':proof})
    assert response.status_code==200,response.text
    result=response.json();assert result['state']=='completed' and not result['financialApplied'] and result['linkedFinancialApplied']
    assert result['mappedObjects']==6 and result['mappingRevision']==1,result
    current=(await client.get('/api/fees/repairs',params={'brokerAccountId':account})).json()
    assert current['legacyCoverage']['status']=='complete' and current['legacyCoverage']['unmappedOrderIds']==[]
    assert all(row['exclusion']=='explicit_fee_preserved' for row in current['items'])
    async with app.state.db.connection() as conn:
        assert await(await conn.execute('SELECT raw,financial_raw,fee_payload FROM legacy_source_manifests WHERE id=%s',(snapshot['manifestId'],))).fetchone()==before
        assert await(await conn.execute('SELECT * FROM fee_legacy_inventory_orders WHERE owner_id=%s ORDER BY original_order_id',(admin,))).fetchall()==inventory
        assert await(await conn.execute('SELECT (SELECT count(*) FROM trade_ledger) trades,(SELECT count(*) FROM cash_ledger_entries) cash')).fetchone()==ledgers
        rows=await(await conn.execute('SELECT object_kind,canonical_snapshot FROM legacy_financial_mapping_items WHERE owner_id=%s',(admin,))).fetchall()
        assert sum(row['canonical_snapshot']['rowType']=='trade' for row in rows)==2


@pytest.mark.asyncio
async def test_mapping_original_uuid_restart_recovery_and_revoke_keep_history_readable(client,admin,old_pg,app,settings):
    from alcor_api.main import create_app
    grant,snapshot,account,record,finance=await imported(client,admin,old_pg)
    data=mapping_command(admin,snapshot,finance);proof=await preview(client,data)
    async def lose(_):raise RuntimeError('synthetic lost response')
    app.state.financial_mappings.after_commit=lose
    response=await client.post('/api/legacy-financial/mappings/operations',json={'data':data,'preview':proof});assert response.status_code==503
    second=create_app(settings)
    async with second.router.lifespan_context(second):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=second),base_url='http://testserver',cookies=client.cookies,headers=dict(client.headers)) as restarted:
            response=await restarted.get('/api/legacy-financial/mappings/operations/'+data['requestId']);assert response.status_code==200 and response.json()['linkedFinancialApplied']
            same=await restarted.post('/api/legacy-financial/mappings/operations',json={'data':data,'preview':proof});assert same.json()==response.json()
            revoke=await restarted.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':grant['grantRevision'],'password':'Synthetic9Pass','code':'','approve':False});assert revoke.status_code==200
            assert (await restarted.get('/api/legacy-financial/mappings/operations/'+data['requestId'])).json()==response.json()
            newer=mapping_command(admin,snapshot,finance,1)
            assert (await restarted.post('/api/legacy-financial/mappings/preview',json=newer)).status_code==409
            assert (await restarted.get('/api/legacy-financial/mappings')).json()['head']['requestId']==data['requestId']
            history=(await restarted.get('/api/fees/repairs',params={'brokerAccountId':account})).json()
            assert history['legacyCoverage']['status']=='complete' and not history['legacyCoverage']['newFinancialAuthorized']
            assert history['legacyCoverage']['mappingRevision']==1 and all(item['exclusion']=='explicit_fee_preserved' for item in history['items'])
            correction={'requestId':str(uuid4()),'accountId':admin,'brokerAccountId':account,'providerId':'longbridge','brokerRevision':history['brokerRevision'],'snapshotRevision':history['snapshotRevision'],'ruleVersion':history['ruleVersion'],'plan':{'effectiveFrom':'2025-05-14','effectiveThrough':'2026-10-20','confirmed':True},'orders':[{'orderId':item['orderId'],'revision':item['revision'],'recordRevision':item['recordRevision'],'instrumentKind':'us_domestic_equity','wholeOrderConfirmed':True,'brokerOwnershipConfirmed':True,'legacyImportConfirmed':True} for item in history['items']]}
            assert (await restarted.post('/api/fees/repairs/preview',json=correction)).status_code==409
            async with second.state.db.connection() as conn:
                with pytest.raises(CheckViolation,match='active shared source grant'):
                    async with conn.transaction():
                        await conn.execute("INSERT INTO fee_legacy_attributions VALUES(%s,%s,'old-order-1',%s,%s,%s,'{}',clock_timestamp())",(admin,snapshot['feeInventorySha256'],account,record,uuid4()))



@pytest.mark.asyncio
async def test_preview_cas_and_cross_input_do_not_duplicate_versions(client,admin,old_pg,app):
    _,snapshot,_,_,finance=await imported(client,admin,old_pg)
    one=mapping_command(admin,snapshot,finance);two=mapping_command(admin,snapshot,finance)
    a=await preview(client,one);b=await preview(client,two)
    assert (await client.post('/api/legacy-financial/mappings/operations',json={'data':two,'preview':a})).status_code==409
    assert (await client.post('/api/legacy-financial/mappings/operations',json={'data':one,'preview':a})).json()['state']=='completed'
    assert (await client.post('/api/legacy-financial/mappings/operations',json={'data':two,'preview':b})).status_code==409
    other={**one,'importRequestId':str(uuid4())}
    assert (await client.post('/api/legacy-financial/mappings/operations',json={'data':other,'preview':a})).status_code==409
    async with app.state.db.connection() as conn:assert (await(await conn.execute('SELECT count(*) n FROM legacy_financial_mapping_versions')).fetchone())['n']==1


@pytest.mark.asyncio
@pytest.mark.parametrize('fail_index',[0,3,5])
async def test_mapping_item_failure_rolls_back_batch_head_and_keeps_original_financial_book(client,admin,old_pg,app,fail_index):
    _,snapshot,_,_,finance=await imported(client,admin,old_pg)
    data=mapping_command(admin,snapshot,finance);proof=await preview(client,data)
    async def fail(conn,index,item):
        if index==fail_index:raise RuntimeError('synthetic mapping interruption')
    app.state.financial_mappings.after_step=fail
    response=await client.post('/api/legacy-financial/mappings/operations',json={'data':data,'preview':proof})
    assert response.status_code==200 and response.json()['state']=='failed',response.text
    assert not response.json()['financialApplied']
    async with app.state.db.connection() as conn:
        for table in ['legacy_financial_mapping_versions','legacy_financial_mapping_items','legacy_financial_mapping_heads']:
            assert (await(await conn.execute('SELECT count(*) n FROM '+table)).fetchone())['n']==0
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger')).fetchone())['n']==2
        assert (await(await conn.execute('SELECT sum(amount) total FROM cash_ledger_entries')).fetchone())['total']==__import__('decimal').Decimal('922.5')
    assert (await client.get('/api/legacy-financial/mappings/operations/'+data['requestId'])).json()==response.json()


@pytest.mark.asyncio
@pytest.mark.parametrize('forgery',['target','snapshot','omit'])
async def test_database_enforces_original_link_actual_target_and_complete_mapping(client,admin,old_pg,app,forgery):
    _,snapshot,_,_,finance=await imported(client,admin,old_pg)
    data=mapping_command(admin,snapshot,finance);proof=await preview(client,data)
    assert (await client.post('/api/legacy-financial/mappings/operations',json={'data':data,'preview':proof})).json()['state']=='completed'
    async with app.state.db.connection() as conn:
        version=await(await conn.execute('SELECT * FROM legacy_financial_mapping_versions')).fetchone()
        content=copy.deepcopy(version['content']);content.update(predecessorId=data['requestId'],predecessorSha256=version['sha256'])
        if forgery=='omit':content['items'].pop()
        if forgery=='snapshot':content['items'][0]['canonical']['qty']='999'
        if forgery=='target':content['items'][0]['targetId']='missing-canonical-target'
        sha=(await(await conn.execute("SELECT encode(sha256(convert_to(%s::jsonb::text,'UTF8')),'hex') value",(Jsonb(content),))).fetchone())['value']
        result={**version['result'],'requestId':str(uuid4()),'mappingRevision':2,'mappingSha256':sha}
        with pytest.raises(CheckViolation):
            async with conn.transaction():
                await conn.execute('INSERT INTO legacy_financial_mapping_versions VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,clock_timestamp())',(admin,result['requestId'],version['manifest_id'],version['import_request_id'],2,data['requestId'],version['sha256'],sha,Jsonb(content),Jsonb(result)))
                for item in content['items']:
                    await conn.execute('INSERT INTO legacy_financial_mapping_items VALUES(%s,%s,%s,%s,%s,%s,%s,%s)',(admin,result['requestId'],item['objectKind'],item['originalId'],item['sourceInstance'],item['sourceOwner'],item['targetId'],Jsonb(item['canonical'])))
                await conn.execute('SET CONSTRAINTS ALL IMMEDIATE')
        with pytest.raises(CheckViolation):
            async with conn.transaction():await conn.execute('DELETE FROM legacy_financial_mapping_items WHERE owner_id=%s',(admin,))
        assert (await(await conn.execute('SELECT count(*) n FROM legacy_financial_mapping_versions')).fetchone())['n']==1


@pytest.mark.asyncio
async def test_mapping_requires_actual_financial_receipt_not_raw_complete_claim(client,admin,old_pg,app):
    grant=await authorized(client,admin,old_pg);snapshot,*_=await export(client,grant)
    data={'requestId':str(uuid4()),'manifestId':snapshot['manifestId'],'importRequestId':str(uuid4()),'targetUserId':admin,'expectedMappingRevision':0}
    response=await client.post('/api/legacy-financial/mappings/preview',json=data)
    assert response.status_code==200 and not response.json()['ready'] and 'preview' not in response.json()
    assert any(b['code']=='completed_same_manifest_financial_receipt_required' for b in response.json()['blockers'])
    assert not response.json()['linkedFinancialApplied']
    assert (await client.post('/api/legacy-financial/mappings/preview',json={**data,'targetUserId':'some-other-internal-id'})).status_code==409
    assert (await client.post('/api/legacy-financial/mappings/operations',json={'data':data,'preview':'invented'})).status_code==409


@pytest.mark.asyncio
async def test_persistent_shared_fee_budget_rejects_new_mapping_but_original_receipt_queries_work(client,admin,old_pg,app):
    _,snapshot,_,_,finance=await imported(client,admin,old_pg)
    data=mapping_command(admin,snapshot,finance);proof=await preview(client,data)
    response=await client.post('/api/legacy-financial/mappings/operations',json={'data':data,'preview':proof});assert response.json()['state']=='completed'
    async with app.state.db.connection() as conn:
        await conn.execute("INSERT INTO fee_rate_windows VALUES(%s,date_trunc('minute',clock_timestamp()),30) ON CONFLICT(owner_id,minute) DO UPDATE SET count=30",(admin,))
    other=mapping_command(admin,snapshot,finance,1)
    assert (await client.post('/api/legacy-financial/mappings/preview',json=other)).status_code==429
    assert (await client.get('/api/legacy-financial/mappings/operations/'+data['requestId'])).json()==response.json()


@pytest.mark.asyncio
async def test_revocation_winning_real_grant_lock_prevents_mapping_publication(client,admin,old_pg,app):
    import asyncio
    grant,snapshot,_,_,finance=await imported(client,admin,old_pg)
    data=mapping_command(admin,snapshot,finance);proof=await preview(client,data)
    async with app.state.db.connection() as conn:
        async with conn.transaction():
            await conn.execute('SELECT * FROM legacy_source_grants WHERE id=%s FOR UPDATE',(grant['grantId'],))
            request=asyncio.create_task(client.post('/api/legacy-financial/mappings/operations',json={'data':data,'preview':proof}))
            await asyncio.sleep(0.1);assert not request.done()
            await conn.execute("UPDATE legacy_source_grants SET state='revoked',revision=revision+1,revoked_at=clock_timestamp() WHERE id=%s",(grant['grantId'],))
        response=await request
    assert response.status_code==409,response.text
    async with app.state.db.connection() as conn:assert (await(await conn.execute('SELECT count(*) n FROM legacy_financial_mapping_versions')).fetchone())['n']==0
