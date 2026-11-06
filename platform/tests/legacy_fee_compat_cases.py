import copy
import json
from uuid import uuid4
from decimal import Decimal

import httpx
import psycopg
import pytest
from alcor_api.security import digest
from legacy_fee_compat_setup import source_case
from fee_estimate_test_helpers import command,financial

P='/api/fees/source-attributions'

async def attribution(client,account,fill,oid):
    state=(await client.get('/api/fees/repairs',params={'brokerAccountId':account})).json()
    return {'requestId':str(uuid4()),'sourceRevision':state['legacyCoverage']['revision'],'sourceDigest':state['legacyCoverage']['sourceDigest'],'orderId':oid,'recordId':fill['recordId'],'recordRevision':fill['record']['revision'],'brokerAccountId':account,'brokerRevision':state['brokerRevision'],'basis':{'documentDigest':'a'*64,'historicalAccountConfirmed':True,'completeOrderHistoryConfirmed':True}}


@pytest.mark.asyncio
async def test_append_repair_and_future_trade_economics_are_estimated_only_actual_stays_unknown(client,admin,app,old_pg,pg,tmp_path):
    # Preserve the old positive's append-only and future-trading protection;
    # replace its unsafe actual-fee claim with the explicit estimate contract.
    async with source_case(client,admin,app,old_pg,pg,tmp_path) as (approved,hosted,grant,exported,request,account,fill,oid):
        before=await financial(app.state.db);data=command(admin,exported,account,oid,fill)
        preview=(await approved.post('/api/fees/estimates/preview',json=data)).json();assert preview['ready']
        result=await approved.post('/api/fees/estimates/operations',json={'data':data,'preview':preview['preview']})
        assert result.json()['state']=='completed' and not result.json()['financialApplied']
        assert result.json()['assessments'][0]['estimated']['cost']=='10.103' and result.json()['assessments'][0]['actual']['cost'] is None
        assert await financial(app.state.db)==before
        # The old financial correction endpoint must never consume an estimate
        # as proof of actual payment or restore actual P&L.
        assert (await approved.get('/api/fees/estimates/operations/'+data['requestId'])).json()==result.json()
        future={'requestId':str(uuid4()),'recordId':fill['recordId'],'recordRevision':fill['record']['revision'],'side':'sell','quantity':'1','price':'12','amount':'12','fees':'1','currency':'USD','settlementCurrency':'USD','occurredAt':'2026-09-02T12:00:00Z','confirmedActualFill':True}
        assert (await approved.post('/api/trading/preview',json=future)).status_code==409


@pytest.mark.asyncio
async def test_inventory_preserves_real_unassigned_ids_unknown_fields_and_original_export_uuid(client,admin,app,old_pg,pg,tmp_path):
    extra={'id':'unknown-original','unassigned':True,'unknown':True}
    async with source_case(client,admin,app,old_pg,pg,tmp_path,extra=extra) as (approved,hosted,grant,exported,request,account,fill,oid):
        before=await financial(app.state.db)
        state=(await approved.get('/api/fees/repairs',params={'brokerAccountId':account})).json()
        old=next(item for item in state['unassignedOrders'] if item['orderId']=='unknown-original')
        assert old['input']['fees'] is None and old['input']['currency'] is None and old['input']['accountKind'] is None and old['originalBrokerAccountId'] is None
        assert state['legacyCoverage']['status']=='partial' and not state['ordersComplete']
        raw=(await approved.get('/api/legacy-financial/manifests/'+exported['manifestId']+'/raw')).json()
        original=next(row for row in raw['tables']['trade_orders']['rows'] if row['id']['text']=='unknown-original')
        assert original['fees']['null'] and original['market']['null'] and original['traded_at']['null']
        repeated=await approved.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots',json=request)
        assert repeated.json()==exported and not repeated.json()['financialApplied']
        conflict=await approved.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots',json={**request,'predecessorHash':'a'*64});assert conflict.status_code==409
        assert await financial(app.state.db)==before


@pytest.mark.asyncio
async def test_unassigned_owner_attribution_is_only_a_choice_and_never_changes_original_unknown_kind_or_cash(client,admin,app,old_pg,pg,tmp_path):
    extra={'id':'original-unassigned-order','unassigned':True}
    async with source_case(client,admin,app,old_pg,pg,tmp_path,extra=extra) as (approved,hosted,grant,exported,request,account,fill,oid):
        before=await financial(app.state.db);data=await attribution(approved,account,fill,extra['id'])
        p=await approved.post(P+'/preview',json=data);assert p.status_code==200,p.text
        result=await approved.post(P+'/operations',json={'data':data,'preview':p.json()['preview']})
        assert result.status_code==200 and result.json()['state']=='completed' and not result.json()['financialApplied'],result.text
        assert (await approved.post(P+'/operations',json={'data':data,'preview':p.json()['preview']})).json()==result.json()
        async with app.state.db.connection() as conn:
            evidence=(await(await conn.execute('SELECT evidence FROM fee_legacy_attributions')).fetchone())['evidence']
            assert evidence['originalAccountKind'] is None and evidence['targetAccountKind']=='real' and not evidence['financialApplied']
            assert evidence['originalCashAttribution']['brokerAccountId'] is None
        attempt=command(admin,exported,account,extra['id'],fill)
        assert (await approved.post('/api/fees/estimates/preview',json=attempt)).status_code==409
        assert await financial(app.state.db)==before


@pytest.mark.asyncio
@pytest.mark.parametrize('expired',[False,True])
async def test_changed_record_or_expired_attribution_proof_has_durable_failure_and_no_posting(client,admin,app,old_pg,pg,tmp_path,expired):
    extra={'id':'original-unassigned-order','unassigned':True}
    async with source_case(client,admin,app,old_pg,pg,tmp_path,extra=extra) as (approved,hosted,grant,exported,request,account,fill,oid):
        data=await attribution(approved,account,fill,extra['id']);p=await approved.post(P+'/preview',json=data);assert p.status_code==200,p.text
        if expired:
            async with app.state.db.connection() as conn:await conn.execute("UPDATE fee_legacy_attribution_previews SET expires_at=clock_timestamp()-interval '1 second'")
        else:
            response=await approved.post('/api/portfolio/records/preview',json={'kind':'update','recordId':fill['recordId'],'revision':fill['record']['revision'],'data':{**{key:fill['record'][key] for key in ('name','code','market','qty','cost','price','group','brokerAccountId')},'cost':fill['record'].get('registeredCost',fill['record']['cost']),'note':'Synthetic metadata changed'}});assert response.status_code==200,response.text
            assert (await approved.post('/api/portfolio/records/confirm',json={'previewId':response.json()['previewId'],'requestId':str(uuid4())})).status_code==200
        before=await financial(app.state.db)
        result=await approved.post(P+'/operations',json={'data':data,'preview':p.json()['preview']})
        assert result.status_code==200 and result.json()['state']=='failed' and result.json()['status']==409,result.text
        assert (await approved.get(P+'/operations/'+data['requestId'])).json()==result.json()
        assert await financial(app.state.db)==before


@pytest.mark.asyncio
async def test_attribution_proof_cannot_cross_session_or_turn_unknown_cash_into_a_posting(client,admin,app,old_pg,pg,tmp_path):
    extra={'id':'original-unassigned-order','unassigned':True}
    async with source_case(client,admin,app,old_pg,pg,tmp_path,extra=extra) as (approved,hosted,grant,exported,request,account,fill,oid):
        data=await attribution(approved,account,fill,extra['id']);p=await approved.post(P+'/preview',json=data);assert p.status_code==200,p.text
        before=await financial(app.state.db)
        async with app.state.db.connection() as conn:username=(await(await conn.execute('SELECT username FROM users WHERE id=%s',(admin,))).fetchone())['username']
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=hosted),base_url='http://testserver',headers={'origin':'http://testserver'}) as other:
            login=await other.post('/api/session/login',json={'login':username,'password':'Synthetic9Pass'});assert login.status_code==200
            other.headers['x-csrf-token']=login.json()['csrf']
            result=await other.post(P+'/operations',json={'data':data,'preview':p.json()['preview']})
            assert result.status_code==200 and result.json()['state']=='failed' and result.json()['status']==409,result.text
        assert await financial(app.state.db)==before
        finance={**data,'requestId':str(uuid4()),'sourceId':exported['sourceId']}
        # Source attribution has no route or flag that applies financial writes.
        assert not exported['financialReady'] and not exported['financialApplied']


@pytest.mark.asyncio
@pytest.mark.parametrize('status',['cancelled','canceled','pending','expired','rejected'])
async def test_original_cancelled_and_all_other_nonfilled_orders_keep_versions_and_never_become_fills(client,admin,app,old_pg,pg,tmp_path,status):
    extra={'id':'original-'+status+'-order','status':status,'revision':8,'recordRevision':12}
    async with source_case(client,admin,app,old_pg,pg,tmp_path,extra=extra) as (approved,hosted,grant,exported,request,account,fill,oid):
        before=await financial(app.state.db);data=command(admin,exported,account,oid,fill)
        p=await approved.post('/api/fees/estimates/preview',json=data);assert p.status_code==200 and p.json()['ready'],p.text
        result=await approved.post('/api/fees/estimates/operations',json={'data':data,'preview':p.json()['preview']});assert result.json()['state']=='completed',result.text
        state=(await approved.get('/api/fees/repairs',params={'brokerAccountId':account})).json()
        old=next(item for item in state['items'] if item['orderId']==extra['id'])
        assert old['status']==status and old['revision']==8 and old['recordRevision']==12 and old['exclusion']=='not_filled_equity_trade' and not old['manualReviewRequired']
        assert await financial(app.state.db)==before
        async with app.state.db.connection() as conn:
            assert (await(await conn.execute('SELECT count(*) n FROM internal_orders')).fetchone())['n']==0


@pytest.mark.asyncio
async def test_nonfilled_original_selection_is_explicitly_excluded_not_dropped_or_rewritten(client,admin,app,old_pg,pg,tmp_path):
    extra={'id':'old-cancelled-opaque-id','status':'cancelled','revision':8,'recordRevision':12}
    async with source_case(client,admin,app,old_pg,pg,tmp_path,extra=extra) as (approved,hosted,grant,exported,request,account,fill,oid):
        data=command(admin,exported,account,oid,fill)
        data['selections'].append({'originalOrderId':extra['id'],'tradeId':None,'instrumentKind':'us_domestic_equity','wholeOrderConfirmed':True})
        p=await approved.post('/api/fees/estimates/preview',json=data);assert p.status_code==200 and p.json()['ready'],p.text
        assert len(p.json()['assessments'][0]['orders'])==1
        assert any(item['orderId']==extra['id'] and item['reason']=='not_filled_equity_trade' for item in p.json()['excluded'])
        wrong=copy.deepcopy(data);wrong['selections'][1]['tradeId']=fill['tradeId']
        assert (await approved.post('/api/fees/estimates/preview',json=wrong)).status_code==409


@pytest.mark.asyncio
async def test_partial_known_source_does_not_claim_completeness_or_allow_financial_repair(client,admin,app,old_pg,pg,tmp_path):
    from dataclasses import replace
    from psycopg.rows import dict_row
    from alcor_api.source_snapshot import PgSnapshot,schema_digest
    from legacy_fee_source_fixture import target_placeholder,old_rows_from_target,registered_source
    account,fill=await target_placeholder(client,app.state.db,pg)
    rows,oid=await old_rows_from_target(client,app.state.db,fill['tradeId'],old_pg.owners[0])
    async def missing_history(definition):
        async with await psycopg.AsyncConnection.connect(pg.get_uri(database=definition.expected_database),row_factory=dict_row) as conn:
            await conn.execute('DROP TABLE trade_fee_detail_history')
            return replace(definition,expected_schema_hash=schema_digest(await PgSnapshot().schema(conn)))
    async with registered_source(client,app.state.db,pg,old_pg,tmp_path,rows,prepare_source=missing_history) as (approved,hosted,grant,exported,request):
        before=await financial(app.state.db)
        assert not exported['coverage']['complete'] and not exported['financialReady']
        state=(await approved.get('/api/fees/repairs',params={'brokerAccountId':account})).json()
        assert state['legacyCoverage']['status']=='partial' and not state['ordersComplete']
        assert state['unassignedOrderIds']==[]
        result=await approved.post('/api/fees/estimates/preview',json=command(admin,exported,account,oid,fill))
        assert result.status_code==409,result.text
        legacy={'requestId':str(uuid4()),'accountId':admin,'brokerAccountId':account,'providerId':'longbridge','brokerRevision':state['brokerRevision'],'snapshotRevision':state['snapshotRevision'],'ruleVersion':'2026-10-20.1','plan':{'effectiveFrom':'2025-05-14','effectiveThrough':'2026-10-20','confirmed':True},'orders':[{'orderId':r['orderId'],'revision':r['revision'],'recordRevision':r['recordRevision'],'instrumentKind':'us_domestic_equity','wholeOrderConfirmed':True,'brokerOwnershipConfirmed':True,'legacyImportConfirmed':True} for r in state['items']]}
        result=await approved.post('/api/fees/repairs/preview',json=legacy)
        assert result.status_code==409,result.text
        assert await financial(app.state.db)==before
