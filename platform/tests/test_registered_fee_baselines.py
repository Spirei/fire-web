from uuid import uuid4
from decimal import Decimal
import pytest
from legacy_fee_source_fixture import old_pg,target_placeholder,old_rows_from_target,registered_source
from fee_estimate_test_helpers import command,financial
from actual_fee_test_support import actual_operation


@pytest.mark.asyncio
async def test_recent_unknown_rate_does_not_block_pure_baseline_and_then_explicit_actual_confirmation(client,admin,app,old_pg,pg,tmp_path):
    account,fill=await target_placeholder(client,app.state.db,pg,occurred_at='2026-10-31T12:00:00Z')
    rows,oid=await old_rows_from_target(client,app.state.db,fill['tradeId'],old_pg.owners[0])
    async with registered_source(client,app.state.db,pg,old_pg,tmp_path,rows) as (client,hosted,grant,exported,request):
        before=await financial(app.state.db)
        estimate=command(admin,exported,account,oid,fill);estimate['plan']['effectiveThrough']='2026-11-01'
        unavailable=await client.post('/api/fees/estimates/preview',json=estimate)
        assert unavailable.status_code==200 and not unavailable.json()['ready'],unavailable.text
        assert unavailable.json()['assessments'][0]['estimated']['cost'] is None
        head=await client.get('/api/fees/baselines',params={'brokerAccountId':account})
        assert head.status_code==200 and head.json()=={'brokerAccountId':account,'revision':0,'requestId':None}
        data={'requestId':str(uuid4()),'manifestId':exported['manifestId'],'targetUserId':admin,'brokerAccountId':account,'expectedRevision':head.json()['revision'],'selections':[{'originalOrderId':oid,'tradeId':fill['tradeId'],'wholeOrderConfirmed':True}],'registeredBaselineConfirmed':True}
        preview=await client.post('/api/fees/baselines/preview',json=data)
        assert preview.status_code==200 and preview.json()['ready'] and preview.json()['estimatedFees'] is None,preview.text
        assert not preview.json()['financialApplied'] and not preview.json()['actualFeeKnown']
        assert await financial(app.state.db)==before
        result=await client.post('/api/fees/baselines/operations',json={'data':data,'preview':preview.json()['preview']})
        assert result.status_code==200 and result.json()['state']=='completed' and not result.json()['financialApplied'],result.text
        assert await financial(app.state.db)==before
        reopened=(await client.get('/api/fees/baselines',params={'brokerAccountId':account})).json()
        assert reopened['revision']==1 and reopened['requestId']==data['requestId']
        assert (await client.get('/api/fees/baselines/operations/'+data['requestId'])).json()==result.json()
        assert (await client.post('/api/fees/baselines/operations',json={'data':data,'preview':preview.json()['preview']})).json()==result.json()
        current=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':grant['grantRevision'],'predecessorHash':exported['manifestSha256']})
        assert current.status_code==200 and current.json()['headAdvanced'],current.text
        exported=current.json()
        second={**data,'requestId':str(uuid4()),'manifestId':exported['manifestId'],'expectedRevision':reopened['revision']}
        next_preview=await client.post('/api/fees/baselines/preview',json=second);assert next_preview.status_code==200 and next_preview.json()['ready'],next_preview.text
        next_done=await client.post('/api/fees/baselines/operations',json={'data':second,'preview':next_preview.json()['preview']})
        assert next_done.status_code==200 and next_done.json()['state']=='completed' and next_done.json()['revision']==2,next_done.text
        assert (await client.get('/api/fees/baselines',params={'brokerAccountId':account})).json()['requestId']==second['requestId']
        assert await financial(app.state.db)==before
        snapshot=(await client.get('/api/fees/confirmations',params={'brokerAccountId':account})).json()
        assert snapshot['items'][0]['manifestId']==exported['manifestId']
        actual={'requestId':str(uuid4()),'targetUserId':admin,'manifestId':exported['manifestId'],'manifestSha256':exported['manifestSha256'],'brokerAccountId':account,'brokerRevision':snapshot['brokerRevision'],'snapshotRevision':snapshot['snapshotRevision'],'confirmations':[{'tradeId':fill['tradeId'],'originalOrderId':oid,'recordRevision':fill['record']['revision'],'actualFee':'1.11','currency':'USD','authority':'owner_recorded','actualPaidConfirmed':True,'historicalCashAttributionConfirmed':True,'evidence':{'kind':'owner_statement','statement':'Synthetic recent actual payment checked independently of unavailable rates.'}}]}
        posted,_=await actual_operation(client,actual);assert posted['state']=='completed',posted
        known=(await client.get('/api/portfolio/records/'+fill['recordId'])).json()['record']
        assert Decimal(known['cost'])==Decimal('10.111')
        async with app.state.db.connection() as conn:
            assert not await(await conn.execute('SELECT 1 FROM legacy_fee_estimates')).fetchone()
            assert (await(await conn.execute('SELECT count(*) n FROM registered_fee_baseline_verifications')).fetchone())['n']==2


def pure_command(admin,exported,account,oid,fill):
    return {'requestId':str(uuid4()),'manifestId':exported['manifestId'],'targetUserId':admin,'brokerAccountId':account,'expectedRevision':0,'selections':[{'originalOrderId':oid,'tradeId':fill['tradeId'],'wholeOrderConfirmed':True}],'registeredBaselineConfirmed':True}


@pytest.mark.asyncio
async def test_pure_head_is_read_only_and_foreign_owner_is_not_allowed(client,admin,db,app,settings):
    import httpx
    from alcor_api.cli import create_user
    from test_fee_plans import account
    aid=await account(client)
    before=await financial(db)
    result=await client.get('/api/fees/baselines',params={'brokerAccountId':aid})
    assert result.status_code==200 and result.headers['cache-control']=='no-store'
    assert result.json()=={'brokerAccountId':aid,'revision':0,'requestId':None}
    assert await financial(db)==before
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM registered_fee_baseline_heads')).fetchone()
    await create_user(settings,'OtherBaselineOwner','Synthetic9Pass')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as other:
        login=await other.post('/api/session/login',json={'login':'OtherBaselineOwner','password':'Synthetic9Pass'});assert login.status_code==200
        other.headers['x-csrf-token']=login.json()['csrf']
        before=await financial(db)
        denied=await other.get('/api/fees/baselines',params={'brokerAccountId':aid})
        assert denied.status_code==404 and await financial(db)==before


@pytest.mark.asyncio
@pytest.mark.parametrize('failure',['foreign_session','deferred_metadata'])
async def test_pure_baseline_failure_never_leaves_partial_bindings_or_financial_changes_and_uuid_is_durable(client,admin,app,old_pg,pg,tmp_path,failure):
    import httpx
    account,fill=await target_placeholder(client,app.state.db,pg)
    rows,oid=await old_rows_from_target(client,app.state.db,fill['tradeId'],old_pg.owners[0])
    async with registered_source(client,app.state.db,pg,old_pg,tmp_path,rows) as (approved,hosted,grant,exported,_):
        before=await financial(app.state.db)
        data=pure_command(admin,exported,account,oid,fill)
        preview=await approved.post('/api/fees/baselines/preview',json=data);assert preview.status_code==200 and preview.json()['ready'],preview.text
        body={'data':data,'preview':preview.json()['preview']}
        async def submit(target):return await target.post('/api/fees/baselines/operations',json=body)
        if failure=='foreign_session':
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=hosted),base_url='http://testserver',headers={'origin':'http://testserver'}) as another:
                login=await another.post('/api/session/login',json={'login':'AdminOne','password':'Synthetic9Pass'});assert login.status_code==200
                another.headers['x-csrf-token']=login.json()['csrf']
                result=await submit(another)
        else:
            async with app.state.db.connection() as conn:
                await conn.execute("CREATE FUNCTION synthetic_baseline_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic deferred metadata failure'; END $$")
                await conn.execute('CREATE CONSTRAINT TRIGGER synthetic_baseline_failure AFTER INSERT ON registered_fee_baseline_versions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION synthetic_baseline_failure()')
            result=await submit(approved)
        assert result.status_code==200 and result.json()['state']=='failed',result.text
        assert not result.json()['financialApplied'] and not result.json()['actualFeeKnown']
        assert await financial(app.state.db)==before
        async with app.state.db.connection() as conn:
            for table in ('legacy_fee_baseline_bindings','legacy_fee_source_account_bindings','registered_fee_baseline_verifications','registered_fee_baseline_versions','registered_fee_baseline_heads'):
                assert not await(await conn.execute('SELECT 1 FROM '+table)).fetchone(),table
            if failure=='deferred_metadata':await conn.execute('DROP TRIGGER synthetic_baseline_failure ON registered_fee_baseline_versions')
        assert (await approved.get('/api/fees/baselines/operations/'+data['requestId'])).json()==result.json()
        assert (await submit(approved)).json()==result.json()
        changed={**data,'expectedRevision':1}
        conflict=await approved.post('/api/fees/baselines/operations',json={'data':changed,'preview':preview.json()['preview']})
        assert conflict.status_code==409
        retry={**data,'requestId':str(uuid4())}
        next_preview=await approved.post('/api/fees/baselines/preview',json=retry);assert next_preview.status_code==200 and next_preview.json()['ready'],next_preview.text
        done=await approved.post('/api/fees/baselines/operations',json={'data':retry,'preview':next_preview.json()['preview']})
        assert done.status_code==200 and done.json()['state']=='completed',done.text
        assert await financial(app.state.db)==before
