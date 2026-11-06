"""F34's explicit JSON parent reuses the same F10 authority and original bytes."""
import hashlib
import json
from uuid import UUID, uuid4, uuid5

import pytest
from psycopg.types.json import Jsonb
from test_trading import setup


@pytest.mark.asyncio
async def test_personal_json_order_parent_preview_confirm_and_false_source_bindings(client,admin,db):
    _,record=await setup(client)
    parent_id=str(uuid4())
    payload={'format':'fire-site-backup','version':2,'data':{'tradeOrders':[{
        'id':'old-order','record_id':'old-record','user_id':'old-owner','status':'filled',
        'market':'US','code':'AAPL','side':'buy','qty':'2','price':'10','fees':'1',
        'amount':'20','order_no':'old-order-123','traded_at':'2026-09-01T12:00:00Z'}]}}
    raw=json.dumps(payload,ensure_ascii=False,indent=2)+'\n'
    prepared=await client.post('/api/personal-data-transfer/preview',json={
        'requestId':parent_id,'payloadText':raw,'mappings':{'mode':'mapped-domain-import','sourceOwnerId':'old-owner','records':{'old-record':record['id']}}})
    assert prepared.status_code==200,prepared.text
    plan=prepared.json();assert plan['confirmSupported'] and not plan['blocked'],prepared.text
    assert plan['orderPlan']['rows'][0]['state']=='ready'
    original=await client.get('/api/personal-data-transfer/originals/'+plan['sourceId'])
    assert original.status_code==200 and original.content==raw.encode()
    assert hashlib.sha256(original.content).hexdigest()==hashlib.sha256(raw.encode()).hexdigest()
    async with db.connection() as conn:
        assert not await(await conn.execute('SELECT 1 FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone()
        assert not await(await conn.execute('SELECT 1 FROM legacy_order_import_sources WHERE owner_id=%s',(admin,))).fetchone()
    body={'requestId':parent_id,'previewId':plan['previewId']}
    confirmed=await client.post('/api/personal-data-transfer/submit',json=body)
    assert confirmed.status_code==200,confirmed.text
    assert (await client.post('/api/personal-data-transfer/submit',json=body)).json()==confirmed.json()
    child_id=str(uuid5(UUID(parent_id),'orders'))
    async with db.connection() as conn:
        child=await(await conn.execute('''SELECT p.*,s.id AS original_source_id FROM legacy_order_import_operations o
            JOIN legacy_order_import_previews p ON p.owner_id=o.owner_id AND p.id=o.preview_id
            JOIN legacy_order_import_sources s ON s.owner_id=p.owner_id AND s.id=p.source_id
            WHERE o.owner_id=%s AND o.request_id=%s''',(admin,child_id))).fetchone()
        assert child['result']['personalTransfer']['parentRequestId']==parent_id
        assert child['result']['personalTransfer']['parentSourceId']==plan['sourceId']
        assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone())['n']==1
    for failure in ('false_parent','changed_json_bytes'):
        fake_parent=uuid4();rid=str(uuid5(fake_parent,'orders'));source_id=uuid4();preview_id=uuid4()
        result={**child['result'],'personalTransfer':{**child['result']['personalTransfer'],'parentRequestId':str(fake_parent),'parentSourceId':str(uuid4()),'childRequestId':rid}}
        async with db.connection() as conn:
            await conn.execute('''INSERT INTO legacy_order_import_sources(owner_id,id,filename,sha256,raw,rows,principal,origin_instance)
                SELECT owner_id,%s,filename,sha256,CASE WHEN %s THEN raw||decode('20','hex') ELSE raw END,rows,principal,origin_instance
                FROM legacy_order_import_sources WHERE owner_id=%s AND id=%s''',(source_id,failure=='changed_json_bytes',admin,child['original_source_id']))
            await conn.execute('''INSERT INTO legacy_order_import_previews(owner_id,id,source_id,snapshot_revision,mappings,result,principal)
                SELECT owner_id,%s,%s,snapshot_revision,mappings,%s,principal FROM legacy_order_import_previews WHERE owner_id=%s AND id=%s''',
                (preview_id,source_id,Jsonb(result),admin,child['id']))
        rejected=await client.post('/api/trading/history/import/submissions',json={'requestId':rid,'previewId':str(preview_id),'confirm':True})
        assert rejected.status_code==409,rejected.text
        async with db.connection() as conn:
            assert not await(await conn.execute('SELECT 1 FROM legacy_order_import_operations WHERE owner_id=%s AND request_id=%s',(admin,rid))).fetchone()
            assert (await(await conn.execute('SELECT count(*) n FROM trade_ledger WHERE owner_id=%s',(admin,))).fetchone())['n']==1
