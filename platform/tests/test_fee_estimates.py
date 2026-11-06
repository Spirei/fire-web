import copy
import json
from decimal import Decimal
from uuid import uuid4
import pytest
from alcor_api.fee_rules import VERSION
from legacy_fee_source_fixture import old_pg, old_rows_from_target,registered_source,target_placeholder


async def financial(db):
    async with db.connection() as conn:
        return {table:await(await conn.execute('SELECT * FROM '+table+' ORDER BY 1')).fetchall() for table in ('trade_ledger','cash_ledger_entries','portfolio_records','cash_ledger_collections','trade_fee_corrections','trade_fee_projections','trade_fee_details','fee_legacy_inventory_orders')}


def command(admin,exported,account,order,fill,revision=0):
    return {'requestId':str(uuid4()),'manifestId':exported['manifestId'],'targetUserId':admin,'brokerAccountId':account,'expectedRevision':revision,'ruleVersion':VERSION,'plan':{'effectiveFrom':'2025-05-14','effectiveThrough':'2026-10-20','confirmed':True},'selections':[{'originalOrderId':order,'tradeId':fill['tradeId'],'instrumentKind':'us_domestic_equity','wholeOrderConfirmed':True}],'registeredBaselineConfirmed':True,'estimatedOnlyConfirmed':True}


@pytest.mark.asyncio
async def test_existing_registered_zero_assesses_estimate_preserves_actual_unknown_and_never_posts_financials(client,admin,app,old_pg,pg,tmp_path):
    db=app.state.db;account,fill=await target_placeholder(client,db,pg)
    data,oid=await old_rows_from_target(client,db,fill['tradeId'],old_pg.owners[0])
    async with registered_source(client,db,pg,old_pg,tmp_path,data) as (approved,source_app,grant,exported,request):
        before=await financial(db);body=command(admin,exported,account,oid,fill)
        response=await approved.post('/api/fees/estimates/preview',json=body)
        assert response.status_code==200 and response.json()['ready'],response.text
        estimate=response.json()['assessments'][0]
        assert estimate['orders'][oid]['fee']=='1.03' and estimate['estimated']['cost']=='10.103' and estimate['estimated']['accountCashAfter']=='898.97'
        assert estimate['actual']=={'feesKnown':False,'cost':None,'realizedPnl':None,'cashBalance':None}
        assert Decimal(estimate['registered']['registeredCost'])==Decimal('10') and Decimal(estimate['registered']['targetBookCash'])==Decimal('900')
        assert response.json()['sourceBlockers'] and not response.json()['financialApplied']
        proof=response.json()['preview']
        posted=await approved.post('/api/fees/estimates/operations',json={'data':body,'preview':proof})
        assert posted.status_code==200 and posted.json()['state']=='completed',posted.text
        assert not posted.json()['financialApplied'] and not posted.json()['actualFeeKnown']
        assert await financial(db)==before
        visible=(await approved.get('/api/trading/fills',params={'recordId':fill['recordId']})).json()['items'][0]
        assert visible['fees'] is None and visible['cash_delta'] is None and visible['realized_pnl'] is None and Decimal(visible['registeredCashDelta'])==Decimal('-100')
        record=(await approved.get('/api/portfolio/records/'+fill['recordId'])).json()['record']
        assert record['cost'] is None and not record['costKnown'] and Decimal(record['registeredCost'])==Decimal('10')
        cash=(await approved.get('/api/cash/accounts/'+account)).json()['currencies'][0]
        assert cash['balance'] is None and not cash['complete'] and Decimal(cash['registeredBalance'])==Decimal('900')
        original=await approved.get('/api/fees/estimates/operations/'+body['requestId']);assert original.json()==posted.json()
        assert (await approved.post('/api/fees/estimates/operations',json={'data':body,'preview':proof})).json()==posted.json()
        async with db.connection() as conn:
            assert (await(await conn.execute('SELECT count(*) n FROM legacy_fee_baseline_bindings')).fetchone())['n']==1
            assert (await(await conn.execute('SELECT count(*) n FROM legacy_fee_estimates')).fetchone())['n']==1
            manifest=await(await conn.execute('SELECT manifest FROM legacy_source_manifests WHERE id=%s',(exported['manifestId'],))).fetchone()
            assert manifest['manifest']['orderFacts'][oid]['actualFeeKnown'] is False
        # Approval of a rate scenario does not unblock actual financial writes.
        trade={'requestId':str(uuid4()),'recordId':fill['recordId'],'recordRevision':fill['recordRevision']+1,'side':'buy','quantity':'1','price':'10','amount':'10','fees':'1','currency':'USD','settlementCurrency':'USD','occurredAt':'2026-09-02T12:00:00Z','confirmedActualFill':True}
        response=await approved.post('/api/trading/preview',json=trade);assert response.status_code==409,response.text
