import copy
from decimal import Decimal
from pathlib import Path
from uuid import uuid4
import psycopg
from psycopg import sql
import pytest
from legacy_fee_source_fixture import old_pg,target_placeholder,old_rows_from_target,registered_source
from fee_estimate_test_helpers import command
from actual_fee_test_support import actual_operation


def with_b(rows,same_account):
    rows=copy.deepcopy(rows);broker=rows['broker_accounts'][0]['id']
    if not same_account:
        broker='old-independent-broker-B'
        rows['broker_accounts'].append({**rows['broker_accounts'][0],'id':broker,'name':'Synthetic independent original account B'})
        rows['broker_cash_accounts'].append({**rows['broker_cash_accounts'][0],'account_id':broker})
        rows['fund_transactions'].append({**rows['fund_transactions'][0],'id':'original-fund-B'})
        rows['broker_cash_entries'].append({**rows['broker_cash_entries'][0],'id':'original-opening-B','account_id':broker,'fund_id':'original-fund-B','operation_id':str(uuid4())})
    record={**rows['records'][0],'id':'old-record-B','broker_account_id':broker};rows['records'].append(record)
    rows['record_revisions'].append({'user_id':record['user_id'],'record_id':record['id'],'revision':record['revision']})
    order={**rows['trade_orders'][0],'id':'old-order-B','record_id':record['id']};rows['trade_orders'].append(order)
    rows['app_asset_order_versions'].append({'order_id':order['id'],'revision':1})
    rows['broker_cash_order_links'].append({**rows['broker_cash_order_links'][0],'order_id':order['id'],'account_id':broker})
    return rows


async def append_source_b(pg,definition,before,after):
    assert definition.expected_database.startswith('alcor_synthetic_legacy_')
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=definition.expected_database)) as conn:
        assert Path((await(await conn.execute('SHOW data_directory')).fetchone())[0]).resolve()==definition.expected_data_directory.resolve()
        for table,rows in after.items():
            for row in rows:
                if row in before[table]:continue
                await conn.execute(sql.SQL('INSERT INTO {} ({}) VALUES ({})').format(sql.Identifier(table),sql.SQL(',').join(map(sql.Identifier,row)),sql.SQL(',').join(sql.Placeholder() for _ in row)),tuple(row.values()))


@pytest.mark.asyncio
@pytest.mark.parametrize('same_account,late',[(True,False),(True,True),(False,True)])
async def test_same_original_account_unmigrated_b_is_unknown_but_independent_a_stays_readable(client,admin,app,old_pg,pg,tmp_path,same_account,late):
    account,fill=await target_placeholder(client,app.state.db,pg)
    first_rows,oid=await old_rows_from_target(client,app.state.db,fill['tradeId'],old_pg.owners[0]);extended=with_b(first_rows,same_account)
    async with registered_source(client,app.state.db,pg,old_pg,tmp_path,first_rows if late else extended) as (client,hosted,grant,exported,request):
        body=command(admin,exported,account,oid,fill)
        p=await client.post('/api/fees/estimates/preview',json=body);assert p.status_code==200 and p.json()['ready'],p.text
        response=await client.post('/api/fees/estimates/operations',json={'data':body,'preview':p.json()['preview']});assert response.json()['state']=='completed',response.text
        snapshot=(await client.get('/api/fees/confirmations',params={'brokerAccountId':account})).json()
        data={'requestId':str(uuid4()),'targetUserId':admin,'manifestId':exported['manifestId'],'manifestSha256':exported['manifestSha256'],'brokerAccountId':account,'brokerRevision':snapshot['brokerRevision'],'snapshotRevision':snapshot['snapshotRevision'],'confirmations':[{'tradeId':fill['tradeId'],'originalOrderId':oid,'recordRevision':fill['record']['revision'],'actualFee':'1.11','currency':'USD','authority':'owner_recorded','actualPaidConfirmed':True,'historicalCashAttributionConfirmed':True,'evidence':{'kind':'owner_statement','statement':'Synthetic A actual payment confirmed; original B remains unimported.'}}]}
        result,proof=await actual_operation(client,data);assert result['state']=='completed',result
        if not late:assert proof['cashEffect']['brokerAfter'] is None
        if late:
            before=(await client.get('/api/cash/accounts/'+account)).json()['currencies'][0];assert before['complete'] and Decimal(before['balance'])==Decimal('898.89')
            await append_source_b(pg,old_pg,first_rows,extended)
            current=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':grant['grantRevision'],'predecessorHash':exported['manifestSha256']})
            assert current.status_code==200 and current.json()['headAdvanced'],current.text
            exported=current.json()
        record=await client.get('/api/portfolio/records/'+fill['recordId']);assert record.status_code==200 and Decimal(record.json()['record']['cost'])==Decimal('10.111'),record.text
        cash=(await client.get('/api/cash/accounts/'+account)).json()['currencies'][0]
        if same_account:assert cash['balance'] is None and not cash['complete'],cash
        else:assert Decimal(cash['balance'])==Decimal('898.89') and cash['complete'],cash
        assert not cash['ownerCashComplete']
        original=(await client.get('/api/legacy-financial/manifests/'+exported['manifestId']+'/raw')).json()
        assert any(row['id']['text']=='old-order-B' for row in original['tables']['trade_orders']['rows'])
        assert (await client.get('/api/fees/confirmations/operations/'+data['requestId'])).json()==result


@pytest.mark.asyncio
async def test_new_original_manifest_invalidates_old_actual_preview_without_any_financial_posting(client,admin,app,old_pg,pg,tmp_path):
    from actual_fee_test_support import actual_case
    from test_fee_source_inventory import financial_rows
    async with actual_case(client,admin,app,old_pg,pg,tmp_path) as (client,hosted,grant,exported,account,fill,data):
        preview=await client.post('/api/fees/confirmations/preview',json=data);assert preview.status_code==200
        current=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots',json={'requestId':str(uuid4()),'grantRevision':grant['grantRevision'],'predecessorHash':exported['manifestSha256']})
        assert current.status_code==200 and current.json()['headAdvanced'] and current.json()['manifestId']!=exported['manifestId'],current.text
        before=await financial_rows(app.state.db)
        denied=await client.post('/api/fees/confirmations/operations',json={'data':data,'preview':preview.json()['previewRevision']})
        assert denied.status_code==200 and denied.json()['state']=='failed' and denied.json()['status']==409,denied.text
        assert await financial_rows(app.state.db)==before
        assert (await client.get('/api/fees/confirmations/operations/'+data['requestId'])).json()==denied.json()
