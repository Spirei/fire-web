"""Direct old transfer URL: exact originals, explicit confirmation and truthful replay."""
import hashlib
import json
from uuid import uuid4

from personal_transfer_candidate.test_transfer import record, payload


async def test_old_data_url_preview_confirm_and_replay_keep_actual_outcome_and_before_image(client,admin,db):
    source=payload({'records':[record('old-explicit-transfer')],'profile':{'nickname':'Imported fixture'}})
    raw=json.dumps(source,ensure_ascii=False,indent=2).encode()
    rid=str(uuid4());headers={'content-type':'application/json','x-alcor-request-id':rid}
    exported=await client.get('/api/v1/data/export')
    assert exported.status_code==200 and exported.json()['format']=='fire-site-backup'
    original_before=exported.json()
    prepared=await client.post('/api/v1/data/import',content=raw,headers=headers)
    assert prepared.status_code==200,prepared.text
    plan=prepared.json()
    assert plan['requestId']==rid and plan['executed'] is False and plan['confirmSupported']
    assert (await client.get('/api/personal-data-transfer/originals/'+plan['sourceId'])).content==raw
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM portfolio_records WHERE owner_id=%s',(admin,))).fetchone()
    command={'requestId':rid,'previewId':plan['previewId']}
    # Preview mode is not permission to commit, even with a valid old preview.
    blocked=await client.post('/api/v1/data/import?preview=1',json=command)
    assert blocked.status_code==400,blocked.text
    saved=await client.post('/api/v1/data/import',json=command)
    assert saved.status_code==200 and saved.json()['executed'] is True,saved.text
    result=saved.json()
    assert (await client.post('/api/v1/data/import',json=command)).json()==result
    # Re-uploading the original UUID queries the persisted outcome; it cannot
    # falsely overwrite a completed receipt with executed:false.
    assert (await client.post('/api/v1/data/import',content=raw,headers=headers)).json()==result
    changed=json.dumps(payload({'profile':{'nickname':'Other content'}})).encode()
    assert (await client.post('/api/v1/data/import',content=changed,headers=headers)).status_code==409
    assert (await client.get('/api/personal-data-transfer/operations/'+rid)).json()==result
    before=await client.get('/api/personal-data-transfer/before-images/'+rid)
    assert before.status_code==200 and hashlib.sha256(before.content).hexdigest()==result['beforeImageSha256']
    before_payload=before.json()
    assert before_payload['data']==original_before['data']
    after=(await client.get('/api/v1/data/export')).json()
    assert len(after['data']['records'])==1 and after['data']['profile']['nickname']=='Imported fixture'
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM personal_data_transfer_operations WHERE owner_id=%s AND request_id=%s',(admin,rid))).fetchone())['n']==1
        assert (await(await conn.execute('SELECT count(*) n FROM personal_data_transfer_before_images WHERE owner_id=%s',(admin,))).fetchone())['n']==1
        assert not await(await conn.execute('SELECT 1 FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone()


async def test_old_data_explicit_bad_credentials_cannot_fall_back_to_good_web_cookie(client,admin):
    for authorization in ('','garbage','Bearer  bad'):
        for method,path,kwargs in [('GET','/api/v1/data/export',{}),('POST','/api/v1/data/import',{'json':{'format':'fire-site-backup','version':2,'data':{}}})]:
            response=await client.request(method,path,headers={'authorization':authorization},**kwargs)
            assert response.status_code==401,response.text
