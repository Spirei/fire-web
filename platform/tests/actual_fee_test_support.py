from contextlib import asynccontextmanager
from uuid import uuid4
from legacy_fee_source_fixture import target_placeholder,old_rows_from_target,registered_source
from fee_estimate_test_helpers import command


@asynccontextmanager
async def actual_case(client,admin,app,old_pg,pg,tmp_path,*,fee='1.11',opening_at='2026-01-01T00:00:00Z'):
    account,fill=await target_placeholder(client,app.state.db,pg,opening_at=opening_at)
    rows,oid=await old_rows_from_target(client,app.state.db,fill['tradeId'],old_pg.owners[0])
    async with registered_source(client,app.state.db,pg,old_pg,tmp_path,rows) as (approved,hosted,grant,exported,request):
        baseline=command(admin,exported,account,oid,fill)
        preview=await approved.post('/api/fees/estimates/preview',json=baseline);assert preview.status_code==200,preview.text
        done=await approved.post('/api/fees/estimates/operations',json={'data':baseline,'preview':preview.json()['preview']})
        assert done.status_code==200 and done.json()['state']=='completed' and not done.json()['financialApplied'],done.text
        snapshot=await approved.get('/api/fees/confirmations',params={'brokerAccountId':account});assert snapshot.status_code==200,snapshot.text
        snapshot=snapshot.json()
        data={'requestId':str(uuid4()),'targetUserId':admin,'manifestId':exported['manifestId'],'manifestSha256':exported['manifestSha256'],'brokerAccountId':account,'brokerRevision':snapshot['brokerRevision'],'snapshotRevision':snapshot['snapshotRevision'],
              'confirmations':[{'tradeId':fill['tradeId'],'originalOrderId':oid,'recordRevision':fill['record']['revision'],'actualFee':fee,'currency':'USD','authority':'owner_recorded','actualPaidConfirmed':True,'historicalCashAttributionConfirmed':True,'evidence':{'kind':'owner_statement','statement':'Synthetic owner explicitly checked actual payment in the original account. This amount is not a fee-rule estimate.'}}]}
        yield approved,hosted,grant,exported,account,fill,data


async def actual_operation(client,data):
    preview=await client.post('/api/fees/confirmations/preview',json=data);assert preview.status_code==200,preview.text
    result=await client.post('/api/fees/confirmations/operations',json={'data':data,'preview':preview.json()['previewRevision']});assert result.status_code==200,result.text
    return result.json(),preview.json()
