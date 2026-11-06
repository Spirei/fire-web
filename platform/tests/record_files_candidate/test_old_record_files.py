"""Direct old file/image/data routes; canonical-only success is not legacy evidence."""
import io
import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

from psycopg.types.json import Jsonb
from alcor_api.portfolio_records import PortfolioRecords
from alcor_api.record_file_imports import read_xlsx
from test_legacy_portfolio import register


async def test_old_image_importrow_numeric_status_and_apply_receipt(client, db, app, settings, monkeypatch):
    owner = await register(client)
    target={'id':'fake-installed','ownerId':owner,'instanceId':str(settings.instance_id),'approvedAccess':True,
        'purpose':'record.screenshot.ocr','provider':'deepseek','model':'deepseek-flash',
        'expiresAt':(datetime.now(UTC)+timedelta(hours=1)).isoformat(),'licenseRevision':'synthetic-license',
        'addresses':['8.8.8.8'],'host':'api.deepseek.com','credentialCiphertext':'synthetic-not-decrypted'}
    settings.record_ocr_targets=[target]
    async with db.connection() as conn:
        sid=uuid4()
        await conn.execute('INSERT INTO asset_catalog_sources(id,actor_id,source_label,sha256,original_text,manifest,result) VALUES(%s,%s,%s,%s,%s,%s,%s)',
            (sid,owner,'Synthetic confirmed public metadata','a'*64,'{}',Jsonb({'publicMetadataConfirmed':True}),Jsonb({})))
        await conn.execute("INSERT INTO asset_catalog_entries(id,type,market,code,name,source_id,material_state) VALUES('synthetic-stock','stock','US','SYNTH','Confirmed name',%s,'{}')",(sid,))
    calls=[]
    async def fake(who,tid,raw, **kwargs):
        app.state.record_file_imports.ocr.target(who,tid)
        calls.append(tid)
        return {'state':'recognized','raw':b'{"synthetic":"original"}','provider':'deepseek','text':'Saved|SYNTH|0||12.5|',
                'rows':[{'name':'Saved','code':'SYNTH','market':'','qty':'0','price':'12.5','cost':None}]}
    monkeypatch.setattr(app.state.record_file_imports.ocr,'recognize',fake)
    from PIL import Image
    picture=io.BytesIO();Image.new('RGB',(2,2)).save(picture,format='PNG')
    identified=await client.post('/api/records/import-image',files={'file':('image.png',picture.getvalue(),'image/png')})
    assert identified.status_code==200,identified.text
    value=identified.json();row=value['rows'][0]
    assert value['raw']=='Saved|SYNTH|0||12.5|' and value['provider']=='deepseek'
    assert row['market']=='US' and row['status']=='new' and row['matched'] is True
    assert row['matchedName']=='Confirmed name'
    assert row['qty']==0 and isinstance(row['qty'],(int,float)) and row['cost'] is None and row['price']==12.5
    rid=str(uuid4());body={'rows':value['rows'],'requestId':rid}
    applied=await client.post('/api/records/import-apply',json=body)
    assert applied.status_code==200,applied.text
    assert {k:applied.json()[k]for k in ('added','updated','skipped','total')}=={'added':1,'updated':0,'skipped':0,'total':1}
    assert (await client.post('/api/records/import-apply',json=body)).json()==applied.json()
    assert (await client.get('/api/portfolio/record-imports/operations/'+rid)).json()==applied.json()
    assert len(calls)==1
    # Null on the old route retains a real prior observation; canonical null remains unknown.
    changed=await client.post('/api/records/import-apply',json={'rows':[{'name':'Saved','code':'SYNTH','market':'US','qty':None,'price':None,'cost':None}],'requestId':str(uuid4())})
    assert changed.status_code==200 and changed.json()['updated']==1,changed.text
    async with db.connection() as conn:
        saved=await(await conn.execute('SELECT qty,price,cost FROM portfolio_records WHERE owner_id=%s',(owner,))).fetchone()
        assert saved['qty']==0 and saved['price']==Decimal('12.5') and saved['cost'] is None


async def test_record_json_xlsx_exports_and_old_personal_data_roundtrip_are_explicit(client,admin,db):
    service=PortfolioRecords(db)
    proof=await service.preview(admin,'create',{'name':'Exported','code':'SYNTH','market':'US','qty':'0','cost':None,
        'price':'12.0000000001','group':'','note':'exact','source':'manual'})
    created=await service.confirm(admin,proof['previewId'],uuid4())
    raw_json=await client.get('/api/portfolio/records/export')
    assert raw_json.status_code==200,raw_json.text
    record=raw_json.json()['records'][0]
    assert record['id']==created['recordId'] and record['source']=='manual'
    assert record['qty']=='0' and record['cost'] is None and record['price']=='12.0000000001'
    xlsx=await client.get('/api/portfolio/records/export?format=xlsx')
    assert xlsx.status_code==200 and xlsx.headers['x-alcor-history-included']=='false'
    rows=read_xlsx(xlsx.content)
    assert rows[0]['id']==created['recordId'] and rows[0]['qty']=='0' and rows[0]['price']=='12.0000000001'
    exported=await client.get('/api/v1/data/export')
    assert exported.status_code==200,exported.text
    data=exported.json()
    assert data['format']=='fire-site-backup' and data['version']==2
    source=next(r for r in data['data']['records'] if r['id']==created['recordId'])
    assert source['user_id']==admin and source['qty']=='0' and source['cost'] is None
    # The old URL preserves the raw file, but requires an explicit safe preview/confirm
    # instead of replaying arbitrary broker-history upserts from a site backup.
    rid=str(uuid4())
    subset={'format':'fire-site-backup','version':2,'data':{'records':[source]}}
    imported=await client.post('/api/v1/data/import',content=json.dumps(subset),headers={'x-alcor-request-id':rid,'content-type':'application/json'})
    assert imported.status_code==200,imported.text
    value=imported.json();assert value['requestId']==rid and value['preview'] is True and value['executed'] is False
    assert value['confirmationPath']=='/api/personal-data-transfer/submit'
    original=await client.get('/api/personal-data-transfer/originals/'+value['sourceId'])
    assert json.loads(original.content)==subset
