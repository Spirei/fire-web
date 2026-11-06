import pytest
from alcor_api.native_app_auth import issue_grant
from legacy_fee_source_fixture import old_pg
from actual_fee_test_support import actual_case


@pytest.mark.asyncio
@pytest.mark.parametrize('version',[1,2])
async def test_native_fee_methods_and_original_uuid_receipt(client,admin,db,app,old_pg,pg,tmp_path,version):
    async with actual_case(client,admin,app,old_pg,pg,tmp_path,fee='1.03') as (client,source_app,grant,exported,aid,fill,data):
        async with db.connection() as conn:
            user=await(await conn.execute('SELECT * FROM users WHERE id=%s',(admin,))).fetchone()
            pair=await issue_grant(conn,user,'portfolio.read orders.read orders.write','Synthetic actual-fee native client')
            read_only=await issue_grant(conn,user,'portfolio.read orders.read','Synthetic read-only fee native client')
        headers={'Authorization':'Bearer '+pair['access_token'],'X-Alcor-Trade-Fees':'details-v1'}
        prefix=f'/api/v{version}/account-assets'
        # The old GET cannot express unmapped actual-fee gaps; it must not turn
        # registered zero into a known actual zero or claim full source coverage.
        unknown=await client.get(prefix+'/fee-repairs',params={'brokerAccountId':aid},headers=headers)
        assert unknown.status_code==409,unknown.text
        denied=await client.post(prefix+'/fee-repairs/preview',json=data,headers={'authorization':'Bearer '+read_only['access_token']})
        assert denied.status_code==403,denied.text
        # A new explicit owner actual confirmation shape is required. The old
        # rate-plan body never silently becomes this statement of actual payment.
        preview=await client.post(prefix+'/fee-repairs/preview',json=data,headers=headers)
        assert preview.status_code==200 and preview.headers['x-alcor-api-version']==str(version),preview.text
        assert preview.json()['data']['candidates'][0]['newFees']==1.03
        assert preview.json()['data']['candidates'][0]['authority']=='owner_recorded'
        body={**data,'previewRevision':preview.json()['data']['previewRevision']}
        submitted=await client.post(prefix+'/fee-repairs/submissions',json=body,headers=headers)
        assert submitted.status_code==200 and submitted.json()['data']['state']=='completed',submitted.text
        duplicate=await client.post(prefix+'/fee-repairs/submissions',json=body,headers=headers)
        assert duplicate.status_code==409 and duplicate.json()['code']==40901
        receipt=await client.get(prefix+'/operations/'+data['requestId'],headers=headers)
        assert receipt.status_code==200 and receipt.json()['data']['requestId']==data['requestId'] and receipt.json()['data']['authority']=='owner_recorded',receipt.text
        assert (await client.get(prefix+'/fee-repairs',params={'brokerAccountId':aid})).status_code in (401,403)
        actual=(await client.get('/api/trading/fills',params={'recordId':fill['recordId']})).json()['items'][0]
        assert actual['fees']=='1.03' and actual['actualFeeKnown'] and actual['feeSource']=='owner_recorded'
