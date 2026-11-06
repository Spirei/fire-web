import json
from uuid import uuid4

import psycopg
import pytest
from alcor_api.financing_source_policy import captured_policy
from fastapi import HTTPException
from legacy_source.helpers import authorized, export
from legacy_source.synthetic_legacy import OWNER

P='/api/financing/policy'


def test_captured_absence_and_precapture_unknown_remain_distinct():
    base={'source':{'owner':OWNER,'ownerVerified':True,'datasetIdentityVerified':True,'financingRowSecurity':{'known':True,'tables':{}},'financialFamilyEvidence':{'schemaInventoryKnown':True,'tables':{'account_financing_policy':{'observed':False}}}},'tables':{}}
    with pytest.raises(HTTPException,match='409'):captured_policy(base)
    base['tables']['account_financing_policy']={'present':False,'rows':[]}
    assert captured_policy(base) is None
    base['tables']['account_financing_policy']={'present':True,'rows':[{'user_id':{'text':OWNER},'value':{'storageType':'text','text':'{"currency":"USD","limit":123.50,"initialMargin":20,"maintenanceMargin":10}'}}]}
    assert captured_policy(base)=={'currency':'USD','limit':'123.5','initialMargin':'20','maintenanceMargin':'10'}
    base['tables']['account_financing_policy']['rows'][0]['value']['text']='{"currency":"USD","limit":1,"limit":2,"initialMargin":null,"maintenanceMargin":null}'
    with pytest.raises(HTTPException,match='409'):captured_policy(base)


async def test_actual_readonly_capture_imports_original_policy_only_once_per_physical_source_kind(client,admin,app,old_pg,pg):
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database),autocommit=True) as conn:
        await conn.execute('INSERT INTO account_financing_policy(user_id,value) VALUES(%s,%s)',(OWNER,json.dumps({'currency':'JPY','limit':100,'initialMargin':20,'maintenanceMargin':10})))
    grant=await authorized(client,admin,old_pg);snapshot,*_=await export(client,grant)
    current=(await client.get(P,params={'accountKind':'real'})).json()
    assert not current['policyKnown'] and current['sourcePolicyPending']
    data={'requestId':str(uuid4()),'manifestId':snapshot['manifestId'],'targetUserId':admin,'accountKind':'real','revision':current['revision'],'sourcePolicyKindConfirmed':True}
    proof=await client.post(P+'/preview',json=data);assert proof.status_code==200,proof.text
    assert proof.json()['policy']=={'currency':'JPY','limit':'100','initialMargin':'20','maintenanceMargin':'10'}
    assert not proof.json()['usedDebt']['debtKnown']
    done=await client.post(P+'/operations',json={'data':data,'preview':proof.json()['previewRevision']});assert done.status_code==200 and done.json()['state']=='completed',done.text
    head=(await client.get(P,params={'accountKind':'real'})).json()
    assert head['policyKnown'] and head['policyOrigin']=='source_import' and not head['sourcePolicyPending'] and head['sourceImportRequestId']==data['requestId']
    assert (await client.get(P+'/operations/'+data['requestId'])).json()==done.json()
    other=(await client.get(P,params={'accountKind':'simulated'})).json()
    denied=await client.post(P+'/preview',json={**data,'requestId':str(uuid4()),'accountKind':'simulated','revision':other['revision']})
    assert denied.status_code==409,denied.text


async def test_captured_empty_policy_stays_known_empty_and_can_clear_later_configuration_only_with_current_cas(client,admin,app,old_pg):
    from test_financing_policy import command, complete
    grant=await authorized(client,admin,old_pg);snapshot,*_=await export(client,grant)
    first=(await client.get(P,params={'accountKind':'real'})).json()
    data={'requestId':str(uuid4()),'manifestId':snapshot['manifestId'],'targetUserId':admin,'accountKind':'real','revision':first['revision'],'sourcePolicyKindConfirmed':True}
    async def imported(data):
        proof=await client.post(P+'/preview',json=data);assert proof.status_code==200,proof.text
        result=await client.post(P+'/operations',json={'data':data,'preview':proof.json()['previewRevision']});assert result.status_code==200 and result.json()['state']=='completed',result.text
        return result.json()
    known_empty=await imported(data)
    read=(await client.get(P,params={'accountKind':'real'})).json()
    assert read['policy'] is None and read['policyKnown'] and read['policyRevision']==0
    assert read['sourceImportRequestId']==data['requestId']
    # Source I/O may be entirely unavailable after capture; archived consent is
    # a distinct authority and original policy bytes must remain usable.
    app.state.source_authority.registry={}
    current=await command(client,admin,kind='real',limit=None)
    native=await complete(client,current)
    assert native['policy']['currency']=='USD'
    stale=await client.post(P+'/preview',json={**data,'requestId':str(uuid4())})
    assert stale.status_code==409,stale.text
    now=(await client.get(P,params={'accountKind':'real'})).json()
    cleared=await imported({**data,'requestId':str(uuid4()),'revision':now['revision']})
    assert cleared['policy'] is None and cleared['policyRevision']==2
    assert (await client.get(P+'/operations/'+known_empty['requestId'])).json()==known_empty
    assert (await client.get(P+'/operations/'+native['requestId'])).json()==native
    async with app.state.db.connection() as conn:
        versions=await(await conn.execute('SELECT revision,policy FROM financing_policy_versions ORDER BY revision')).fetchall()
        assert [row['revision'] for row in versions]==[1,2] and versions[1]['policy'] is None


async def test_source_options_are_pure_and_revoked_grant_denies_new_import_but_retains_original_uuid(client,admin,app,old_pg):
    grant=await authorized(client,admin,old_pg);snapshot,*_=await export(client,grant)
    tables=('financing_source_policy_claims','financing_source_policy_mappings','financing_source_policy_heads','financing_policy_heads','financing_policy_versions','trade_fee_previews','trade_operations')
    async def counts():
        async with app.state.db.connection() as conn:return {table:(await(await conn.execute('SELECT count(*) n FROM '+table)).fetchone())['n'] for table in tables}
    before=await counts()
    source=await client.get(P+'/source',params={'accountKind':'real'});assert source.status_code==200,source.text
    assert source.json()['state']=='available' and source.json()['policyKnown'] and source.json()['policy'] is None
    assert await counts()==before
    current=(await client.get(P,params={'accountKind':'real'})).json()
    data={'requestId':str(uuid4()),'manifestId':snapshot['manifestId'],'targetUserId':admin,'accountKind':'real','revision':current['revision'],'sourcePolicyKindConfirmed':True}
    proof=await client.post(P+'/preview',json=data);assert proof.status_code==200,proof.text
    done=await client.post(P+'/operations',json={'data':data,'preview':proof.json()['previewRevision']});assert done.status_code==200 and done.json()['state']=='completed',done.text
    revoked=await client.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':grant['grantRevision'],'password':'Synthetic9Pass','code':'','approve':False});assert revoked.status_code==200,revoked.text
    old=await client.get(P+'/operations/'+data['requestId']);assert old.json()==done.json()
    blocked=await client.get(P+'/source',params={'accountKind':'real'});assert blocked.status_code==200 and blocked.json()['state']=='blocked',blocked.text
    data={**data,'requestId':str(uuid4()),'revision':(await client.get(P,params={'accountKind':'real'})).json()['revision']}
    assert (await client.post(P+'/preview',json=data)).status_code==409


async def test_original_policy_uuid_replays_exact_old_payload_without_changing_current_policy_after_capture(client,admin,app,old_pg,pg):
    from alcor_api.legacy_financing import legacy_payload_hash, legacy_revision
    from test_legacy_trade_corrections import native_headers
    original_id=str(uuid4());old_policy={'currency':'USD','limit':'99','initialMargin':None,'maintenanceMargin':None};before_revision=legacy_revision(None)
    old_result={'version':1,'accountId':OWNER,'revision':legacy_revision(old_policy),'policy':{'currency':'USD','limit':99,'initialMargin':None,'maintenanceMargin':None}}
    raw=json.dumps(old_result,separators=(',',':'));fingerprint=legacy_payload_hash(before_revision,old_policy)
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=old_pg.expected_database),autocommit=True) as conn:
        await conn.execute('INSERT INTO account_financing_policy(user_id,value) VALUES(%s,%s)',(OWNER,json.dumps({'currency':'JPY','limit':100,'initialMargin':20,'maintenanceMargin':10})))
        await conn.execute('INSERT INTO account_financing_requests(user_id,request_id,payload,result) VALUES(%s,%s,%s,%s)',(OWNER,original_id,fingerprint,raw))
    grant=await authorized(client,admin,old_pg);snapshot,*_=await export(client,grant)
    current=(await client.get(P,params={'accountKind':'real'})).json()
    data={'requestId':str(uuid4()),'manifestId':snapshot['manifestId'],'targetUserId':admin,'accountKind':'real','revision':current['revision'],'sourcePolicyKindConfirmed':True}
    proof=await client.post(P+'/preview',json=data);assert proof.status_code==200,proof.text
    done=await client.post(P+'/operations',json={'data':data,'preview':proof.json()['previewRevision']});assert done.status_code==200 and done.json()['state']=='completed',done.text
    assert done.json()['originalReceiptCount']==1
    original=await client.get(P+'/operations/'+original_id);assert original.status_code==200 and original.json()['sourcePolicyArchive'] and original.json()['policyRevision'] is None,original.text
    assert original.json()['policy']==old_policy and not original.json()['financialApplied']
    async with app.state.db.connection() as conn:
        stored=await(await conn.execute('SELECT result_raw,payload_hash FROM financing_source_policy_request_archives WHERE original_request_id=%s',(original_id,))).fetchone()
        assert bytes(stored['result_raw'])==raw.encode() and stored['payload_hash']==fingerprint
    headers=await native_headers(app.state.db,admin,'portfolio.read portfolio.write orders.read')
    for version in (1,2):
        body={'requestId':original_id,'revision':before_revision,'policy':old_result['policy']}
        replay=await client.post(f'/api/v{version}/account-assets/financing-policy',json=body,headers=headers)
        assert replay.status_code==200 and replay.json()['data']['policy']==old_result['policy'] and replay.json()['data']['accountId']==admin,replay.text
        unchanged=(await client.get(P,params={'accountKind':'real'})).json()
        assert unchanged['policy']['currency']=='JPY' and unchanged['policy']['limit']=='100'
        conflict=await client.post(f'/api/v{version}/account-assets/financing-policy',json={**body,'policy':{**body['policy'],'limit':98}},headers=headers)
        assert conflict.status_code==409,conflict.text
        receipt=await client.get(f'/api/v{version}/account-assets/operations/'+original_id,headers=headers)
        assert receipt.status_code==200 and receipt.json()['data']==replay.json()['data'],receipt.text
