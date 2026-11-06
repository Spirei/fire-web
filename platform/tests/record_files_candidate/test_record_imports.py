"""Owner-only HTTP record imports with exact originals; no real provider requests."""
import hashlib
import io
import json
from decimal import Decimal
from datetime import UTC, datetime, timedelta
from uuid import uuid4
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import pytest
from alcor_api.legacy_order_workbooks import NS, build_xlsx
from alcor_api.record_file_imports import read_xlsx
from test_legacy_portfolio import register, PASSWORD

ROOT = '/api/portfolio/record-imports'


def workbook(shared=False):
    raw = build_xlsx([('records', [['name', 'code', 'market', 'qty', 'cost', 'price', 'id'],
                                 ['Saved record', 'SYNTH', 'US', '0', '', '12.0000000001', 'source-identity']])])
    if not shared:
        return raw
    output = io.BytesIO()
    strings = ET.Element(NS + 'sst')
    with ZipFile(io.BytesIO(raw)) as archive, ZipFile(output, 'w') as target:
        for item in archive.infolist():
            body = archive.read(item.filename)
            if item.filename == 'xl/worksheets/sheet1.xml':
                tree = ET.fromstring(body)
                for index, cell in enumerate(tree.iter(NS + 'c')):
                    value = ''.join(n.text or '' for n in cell.iter(NS + 't'))
                    ET.SubElement(ET.SubElement(strings, NS + 'si'), NS + 't').text = value
                    for child in list(cell):
                        cell.remove(child)
                    cell.set('t', 's')
                    ET.SubElement(cell, NS + 'v').text = str(index)
                body = ET.tostring(tree)
            target.writestr(item.filename, body)
        target.writestr('xl/sharedStrings.xml', ET.tostring(strings))
    return output.getvalue()


@pytest.mark.parametrize('fmt', ['json', 'inline', 'shared'])
async def test_real_http_source_preview_confirm_replay_preserves_exact_source_identity(client, db, fmt):
    owner = await register(client)
    raw = json.dumps([{'name':'Saved record','code':'SYNTH','market':'US','qty':'0','cost':None,
                       'price':'12.0000000001','id':'source-identity'}]).encode() if fmt == 'json' else workbook(fmt == 'shared')
    identifier = str(uuid4())
    response = await client.post(ROOT+'/sources', data={'requestId':identifier,'format':'json' if fmt=='json' else 'xlsx'},
                                 files={'file':('records.json' if fmt=='json' else 'records.xlsx',raw)})
    assert response.status_code == 200, response.text
    source = response.json()
    assert source['state'] == 'parsed', source
    assert source['rows'][0]['id'] == 'source-identity'
    assert source['sourceSha256'] == hashlib.sha256(raw).hexdigest()
    original = await client.get(ROOT+'/sources/'+source['sourceId']+'/original')
    assert original.content == raw
    prepared = await client.post(ROOT+'/previews',json={'sourceId':source['sourceId']})
    assert prepared.status_code == 200, prepared.text
    proof = prepared.json()
    assert proof['rows'][0]['status'] == 'ready', proof
    assert proof['rows'][0]['price'] == '12.0000000001'
    assert proof['rows'][0]['cost'] is None
    command = {'requestId':str(uuid4()),'previewId':proof['previewId'],'confirm':True}
    applied = await client.post(ROOT+'/submissions',json=command)
    assert applied.status_code == 200, applied.text
    assert applied.json()['added'] == 1
    assert (await client.post(ROOT+'/submissions',json=command)).json() == applied.json()
    assert (await client.get(ROOT+'/operations/'+command['requestId'])).json() == applied.json()
    async with db.connection() as conn:
        rows = await (await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s',(owner,))).fetchall()
        assert len(rows)==1 and rows[0]['price'] == Decimal('12.0000000001')
        link = await (await conn.execute('SELECT * FROM record_import_links WHERE owner_id=%s',(owner,))).fetchone()
        assert link['original_id']=='source-identity' and link['target_record_id']==rows[0]['id']
        assert rows[0]['id'] != 'source-identity'


@pytest.mark.parametrize('outcome', ['revoke', 'unknown'])
async def test_ocr_revocation_retains_received_bytes_and_same_uuid_never_reissues(client, db, app, settings, monkeypatch, outcome):
    owner = await register(client)
    service = app.state.record_file_imports
    settings.record_ocr_targets = [{'id':'fake-installed','ownerId':owner,'instanceId':str(settings.instance_id),
        'approvedAccess':True,'purpose':'record.screenshot.ocr','provider':'deepseek','model':'deepseek-flash',
        'expiresAt':(datetime.now(UTC)+timedelta(hours=1)).isoformat(),'licenseRevision':'synthetic-license',
        'addresses':['8.8.8.8'],'host':'api.deepseek.com','credentialCiphertext':'synthetic-not-decrypted'}]
    calls = []
    provider = b'{"synthetic":"received-before-revocation"}'
    async def recognize(who, target_id, raw, **kwargs):
        calls.append(target_id)
        if outcome == 'unknown':
            raise TimeoutError('synthetic uncertain IO')
        async with db.connection() as conn:
            await conn.execute('DELETE FROM sessions WHERE user_id=%s',(owner,))
        return {'state':'recognized','raw':provider,'rows':[{'name':'No publication','code':'SYNTH','market':'US'}]}
    monkeypatch.setattr(service.ocr,'recognize',recognize)
    identifier = str(uuid4())
    async def upload():
        return await client.post(ROOT+'/sources',data={'requestId':identifier,'format':'image','targetId':'fake-installed'},files={'file':('image.png',b'synthetic-image')})
    result = await upload()
    assert result.status_code == 200, result.text
    expected = 'retained_unavailable' if outcome == 'revoke' else 'unknown'
    assert result.json()['state']==expected and result.json()['rows']==[]
    async with db.connection() as conn:
        stored = await (await conn.execute('SELECT provider_raw,result FROM record_import_source_results WHERE owner_id=%s AND request_id=%s',(owner,identifier))).fetchone()
        if outcome == 'revoke':
            assert bytes(stored['provider_raw'])==provider
            assert stored['result']['providerResponseRetained'] is True
        else:
            assert stored['provider_raw'] is None
        assert not await (await conn.execute('SELECT 1 FROM portfolio_records WHERE owner_id=%s',(owner,))).fetchone()
    logged_in = await client.post('/api/auth/login',json={'username':'LegacyPortfolio','password':PASSWORD})
    assert logged_in.status_code==200
    assert (await upload()).json() == result.json()
    assert (await client.get(ROOT+'/operations/'+identifier)).json()['state']==expected
    assert len(calls)==1


def test_shared_workbook_invalid_indices_formulas_and_entities_are_not_executed():
    raw = workbook(True)
    for mutation in ('index','formula','entity'):
        output = io.BytesIO()
        with ZipFile(io.BytesIO(raw)) as source, ZipFile(output,'w') as target:
            for item in source.infolist():
                body=source.read(item.filename)
                if item.filename=='xl/worksheets/sheet1.xml':
                    tree=ET.fromstring(body)
                    cell=next(tree.iter(NS+'c'))
                    if mutation=='index':cell.find(NS+'v').text='999999'
                    if mutation=='formula':ET.SubElement(cell,NS+'f').text='HYPERLINK("https://invalid")'
                    body=ET.tostring(tree)
                if mutation=='entity' and item.filename=='xl/sharedStrings.xml':body=b'<!DOCTYPE x [<!ENTITY y SYSTEM "file:///nonexistent">]>'+body
                target.writestr(item.filename,body)
        with pytest.raises(ValueError):
            read_xlsx(output.getvalue())


async def test_import_original_owner_mapping_and_collection_cas_are_enforced(client, db, app, settings):
    import httpx
    from alcor_api.cli import create_user
    from alcor_api.portfolio_records import PortfolioRecords
    owner = await register(client)
    raw = json.dumps([{'name':'Owned source','code':'SYNTH','market':'US','qty':'0','cost':None,
                       'price':None,'id':'foreign-source-id','user_id':'another-source-owner'}]).encode()
    loaded = await client.post(ROOT+'/sources',data={'requestId':str(uuid4()),'format':'json'},files={'file':('records.json',raw)})
    source = loaded.json()
    assert source['state']=='parsed', source
    blocked = await client.post(ROOT+'/previews',json={'sourceId':source['sourceId']})
    assert blocked.status_code==200 and blocked.json()['rows'][0]['status']=='blocked'
    invalid = await client.post(ROOT+'/previews',json={'sourceId':source['sourceId'],'mappings':{'1':{'recordId':'missing-explicit-record'}}})
    assert invalid.status_code==200 and invalid.json()['rows'][0]['status']=='blocked'
    assert '不能改为新增' in invalid.json()['rows'][0]['reason']
    await create_user(settings,'OtherImportOwner',PASSWORD,role='user')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers={'origin':'http://testserver'}) as peer:
        assert (await peer.post('/api/session/login',json={'login':'OtherImportOwner','password':PASSWORD})).status_code==200
        assert (await peer.get(ROOT+'/sources/'+source['sourceId']+'/original')).status_code==404
        assert (await peer.get(ROOT+'/operations/'+source['requestId'])).status_code==404
    row = {key:value for key,value in json.loads(raw)[0].items() if key!='user_id'}
    proof = (await client.post(ROOT+'/previews',json={'sourceId':source['sourceId'],'rows':[row]})).json()
    assert proof['rows'][0]['status']=='ready'
    service = PortfolioRecords(db)
    other = await service.preview(owner,'create',{'name':'Concurrent','market':'US','code':'OTHER',
            'qty':'0','cost':None,'price':None,'group':'','note':'','source':'manual'})
    await service.confirm(owner,other['previewId'],uuid4())
    refused = await client.post(ROOT+'/submissions',json={'requestId':str(uuid4()),'previewId':proof['previewId'],'confirm':True})
    assert refused.status_code==409
    async with db.connection() as conn:
        assert not await (await conn.execute('SELECT 1 FROM record_import_links WHERE owner_id=%s',(owner,))).fetchone()
