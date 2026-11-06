"""Personal file declarations are enforced before preview and old preview execution."""
import copy
import json
from uuid import uuid4

from alcor_api.personal_data_transfer import digest, validate
from psycopg.types.json import Jsonb

ROOT='/api/personal-data-transfer'
TABLES=('personal_data_transfer_sources','personal_data_transfer_previews','personal_data_transfer_operations','personal_data_transfer_before_images','portfolio_records','cash_ledger_entries','trade_ledger')


def payload(version=2):
    return {'format':'fire-site-backup','version':version,'data':{'profile':{'nickname':'Manifest owner'}}}


async def counts(db,owner):
    async with db.connection() as conn:
        return {table:(await(await conn.execute('SELECT count(*) n FROM '+table+' WHERE owner_id=%s',(owner,))).fetchone())['n'] for table in TABLES}


def test_legal_old_and_current_manifest_variants_keep_historical_compatibility():
    data={'records':[{'id':'source-r','user_id':'source-owner'}],'watchGroups':[{'id':'source-g','user_id':'source-owner'}],'userSettings':[{'user_id':'source-owner','fire':'{}'}],'tradeOrders':[],'fundTransactions':[],'activities':[],'celebs':[],'profile':{'nickname':'Synthetic'},'siteSettings':{'title':'Synthetic'}}
    arrays={key:len(value) for key,value in data.items() if isinstance(value,list)}
    old_counts={**arrays,'profile':1,'siteSettings':1}
    manifests=(None,{'app':'Alcor','appVersion':'old','counts':old_counts,'excluded':'Original legacy export metadata'}, {'counts':arrays,'portable':True,'blocked':[],'scope':'current_owner_only','excluded':['credentials','media_bytes']}, {'portable':True}, {'app':'Historical metadata, no counts'})
    for version in (1,2):
        for manifest in manifests:
            document={'format':'fire-site-backup','version':version,'data':copy.deepcopy(data)}
            if manifest is not None:document['manifest']=copy.deepcopy(manifest)
            before=copy.deepcopy(document)
            actual,actual_counts=validate(document)
            assert actual==data and actual_counts==arrays and document==before
    # Original Web counts an empty/missing nickname as zero, not dict key count.
    for profile in ({},{'nickname':''}):
        document=payload();document['data']['profile']=profile;document['manifest']={'counts':{'profile':0,'records':0,'siteSettings':0}}
        validate(document)


async def test_invalid_or_explicitly_incomplete_claims_never_create_preview_or_business_rows(client,admin,db):
    before=await counts(db,admin)
    bad=(None,[], 'not-an-object', {'portable':False}, {'portable':0}, {'portable':'true'}, {'portable':None}, {'blocked':[{'domain':'ledger','reason':'omitted_history'}]}, {'portable':True,'blocked':[{'domain':'ledger'}]}, {'blocked':{}}, {'blocked':''}, {'blocked':None}, {'counts':[]}, {'counts':None}, {'counts':{'records':1}}, {'counts':{'records':-1}}, {'counts':{'records':False}}, {'counts':{'records':'0'}}, {'counts':{'records':0.0}}, {'counts':{'profile':0}}, {'counts':{'siteSettings':1}}, {'counts':{'brokerAccounts':0}})
    for manifest in bad:
        document=payload();document['manifest']=manifest
        response=await client.post(ROOT+'/preview',json={'requestId':str(uuid4()),'payloadText':json.dumps(document),'mappings':{'mode':'mapped-domain-import'}})
        assert response.status_code==422,(manifest,response.text)
    assert await counts(db,admin)==before
    # Genuine old files without any manifest remain executable through the actual coordinator.
    for version in (1,2):
        document=payload(version)
        prepared=await client.post(ROOT+'/preview',json={'requestId':str(uuid4()),'payloadText':json.dumps(document),'mappings':{}})
        assert prepared.status_code==200,prepared.text
        plan=prepared.json();assert plan['confirmSupported'] and not plan['blocked']
        completed=await client.post(ROOT+'/submit',json={'requestId':plan['requestId'],'previewId':plan['previewId']})
        assert completed.status_code==200 and completed.json()['state']=='completed',completed.text


async def test_old_unsafe_preview_is_revalidated_before_before_image_but_completed_replay_is_immutable(client,admin,db,monkeypatch):
    from alcor_api import personal_data_transfer as module
    original=module.validate
    def historical_validator(document):
        # Model the precise pre-fix behavior: data checked, manifest ignored.
        return original({key:value for key,value in document.items() if key!='manifest'})
    document=payload();document['manifest']={'portable':False,'blocked':[{'domain':'ledger','reason':'actual_history_missing'}],'counts':{'profile':1}}
    with monkeypatch.context() as patch:
        patch.setattr(module,'validate',historical_validator)
        prepared=await client.post(ROOT+'/preview',json={'requestId':str(uuid4()),'payloadText':json.dumps(document),'mappings':{}})
    assert prepared.status_code==200,prepared.text
    plan=prepared.json();assert plan['confirmSupported'] and not plan['blocked']
    before=await counts(db,admin)
    assert before['personal_data_transfer_sources']==1 and before['personal_data_transfer_previews']==1
    assert before['personal_data_transfer_before_images']==0
    command={'requestId':plan['requestId'],'previewId':plan['previewId']}
    rejected=await client.post(ROOT+'/submit',json=command)
    assert rejected.status_code==422,rejected.text
    assert await counts(db,admin)==before
    # A previously completed immutable operation is history, not a new application:
    # revalidation must not retroactively block or rewrite its original receipt.
    historical={'requestId':plan['requestId'],'state':'completed','executed':True,'historicalReceiptFixture':True}
    async with db.connection() as conn:
        await conn.execute('INSERT INTO personal_data_transfer_operations(owner_id,request_id,request_hash,result) VALUES(%s,%s,%s,%s)',(admin,plan['requestId'],digest(command),Jsonb(historical)))
        old=(await(await conn.execute('SELECT result::text value FROM personal_data_transfer_operations WHERE owner_id=%s AND request_id=%s',(admin,plan['requestId']))).fetchone())['value']
    replay=await client.post(ROOT+'/submit',json=command)
    assert replay.status_code==200 and replay.json()==historical,replay.text
    async with db.connection() as conn:
        now=(await(await conn.execute('SELECT result::text value FROM personal_data_transfer_operations WHERE owner_id=%s AND request_id=%s',(admin,plan['requestId']))).fetchone())['value']
    assert now==old
    final=await counts(db,admin)
    assert final=={**before,'personal_data_transfer_operations':before['personal_data_transfer_operations']+1}
