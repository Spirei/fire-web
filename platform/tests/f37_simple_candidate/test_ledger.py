"""Original independent-ledger routes; no broker money or external IO."""
import hashlib
import io
from datetime import date
from uuid import uuid4
from xml.etree import ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from alcor_api.cli import create_user
from alcor_api.simple_ledger_xlsx import NS, export, parse
from fastapi import HTTPException
from simple_ops_candidate.test_simple_ops import financial_counts
from test_account_admin import login

P='/api/account/simple-ledger'


async def test_both_native_versions_legacy_session_owner_header_scope_and_explicit_credential_precedence(client,admin,app,db):
    from alcor_api.native_app_auth import issue_grant
    async with db.connection() as conn:
        user=await(await conn.execute('SELECT * FROM users WHERE id=%s',(admin,))).fetchone()
        web,_=await app.state.legacy_create_session(conn,user,str(uuid4()))
        v1,_=await app.state.legacy_create_session(conn,user,str(uuid4()),v1=True)
        read=await issue_grant(conn,user,'portfolio.read','Independent simple read')
        write=await issue_grant(conn,user,'portfolio.read portfolio.write','Independent simple write')
    before=await financial_counts(db)
    client.cookies.set('fire_session',web)
    for token in (web,v1):
        headers={'authorization':'Bearer '+token,'X-Simple-Ledger-User':admin,'X-Alcor-Request-Id':str(uuid4())}
        response=await client.put('/api/v1/simple-ledger',json={'cash':[{'id':'declared','cur':'USD','amount':'9007199254740993.00001'}],'hide':'nonempty','expected':'not a number'},headers=headers)
        assert response.status_code==200,response.text
        assert response.json()['data']['cash'][0]['amount']=='9007199254740993.00001'
        assert response.json()['data']['hide'] is True and response.json()['data']['expected']==8
        assert (await client.get('/api/v1/simple-ledger',headers=headers)).json()['data']==response.json()['data']
        assert (await client.put('/api/v1/simple-ledger',json={'cash':[{'id':'declared','cur':'USD','amount':'9007199254740993.00001'}],'hide':'nonempty','expected':'not a number'},headers=headers)).json()==response.json()
        assert (await client.get('/api/v2/simple-ledger',headers=headers)).status_code==401
    for version in (1,2):
        headers={'authorization':'Bearer '+read['access_token']}
        assert (await client.get(f'/api/v{version}/simple-ledger',headers=headers)).status_code==200
        assert (await client.put(f'/api/v{version}/simple-ledger',json={'cash':[]},headers=headers)).status_code==403
        headers={'authorization':'Bearer '+write['access_token'],'X-Alcor-Request-Id':str(uuid4())}
        saved=await client.put(f'/api/v{version}/simple-ledger',json={'invest':[],'fx':{'CNY':None}},headers=headers)
        assert saved.status_code==200,saved.text
        assert saved.json()['data']['fx']['CNY'] is None
        operation=await client.get(f'/api/v{version}/simple-ledger/operations/'+headers['X-Alcor-Request-Id'],headers=headers)
        assert operation.status_code==200 and operation.json()['data']['ledger']==saved.json()['data'],operation.text
        unknown=str(uuid4())
        closed=await client.post(f'/api/v{version}/simple-ledger/operations/'+unknown+'/close',json={},headers=headers)
        assert closed.status_code==200 and closed.json()['data']['executed'] is False,closed.text
        assert (await client.put(f'/api/v{version}/simple-ledger',json={'cash':[]},headers={**headers,'X-Alcor-Request-Id':unknown})).status_code==409
        assert (await client.get(f'/api/v{version}/simple-ledger',headers={**headers,'X-Simple-Ledger-User':'different-owner'})).status_code==409
    for bad in ('','Bearer bad','Bearer '+'N'*64):
        assert (await client.get('/api/v1/simple-ledger',headers={'authorization':bad})).status_code==401
    assert (await client.get('/api/v2/simple-ledger')).status_code==401
    assert await financial_counts(db)==before


async def test_old_tool_mime_raw_retention_failure_terminal_close_owner_isolation_and_no_ledger_apply(client,admin,app,db,settings):
    async with db.connection() as conn:
        user=await(await conn.execute('SELECT * FROM users WHERE id=%s',(admin,))).fetchone()
        web,_=await app.state.legacy_create_session(conn,user,str(uuid4()))
    headers={'authorization':'Bearer '+web};before=await financial_counts(db)
    invalid=await client.post('/api/simple-app/tool/export',json={},headers=headers)
    assert invalid.status_code==400 and invalid.json()['ok'] is False,invalid.text
    source=await client.post('/api/simple-app/tool/export',json={'invest':[{'name':'Declared wallet','cur':'USD','hist':[{'d':'2026-01-01','v':'7.000000000000000001','inn':'0','out':'0'}]}]},headers=headers)
    assert source.status_code==200,source.text
    rid=str(uuid4());form={'requestId':rid}
    parsed=await client.post('/api/simple-app/tool/import',data=form,files={'file':('export.bin',source.content,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')},headers=headers)
    assert parsed.status_code==200 and parsed.json()['applied'] is False,parsed.text
    assert parsed.json()['invest'][0]['hist'][0]['v']=='7.000000000000000001'
    assert (await client.get(P)).json()['revision']==0
    original=await client.get(P+'/originals/'+rid)
    assert original.content==source.content and original.headers['x-content-sha256']==hashlib.sha256(source.content).hexdigest()
    assert (await client.post(P+'/operations/'+rid+'/close',json={})).json()['state']=='parsed'
    failed_id=str(uuid4());bad=b'not a workbook'
    failed=await client.post(P+'/tool/import',data={'requestId':failed_id},files={'file':('bad.xlsx',bad,'application/octet-stream')})
    assert failed.status_code==400 and failed.json()['state']=='rejected',failed.text
    assert (await client.get(P+'/operations/'+failed_id)).json()['state']=='rejected'
    assert (await client.get(P+'/originals/'+failed_id)).content==bad
    assert (await client.post(P+'/tool/import',data={'requestId':failed_id},files={'file':('bad.xlsx',bad,'application/octet-stream')})).json()==failed.json()
    closed=str(uuid4());close=await client.post(P+'/operations/'+closed+'/close',json={})
    assert close.json()=={'requestId':closed,'state':'closed','executed':False,'scope':'independent_personal_ledger'}
    assert (await client.put(P,json={'requestId':closed,'expectedRevision':0,'ledger':{}})).status_code==409
    await create_user(settings,'SimpleOther','Synthetic9Pass')
    peer=await login(app,'SimpleOther')
    try:
        for suffix in ('/operations/'+rid,'/operations/'+failed_id,'/originals/'+rid):assert (await peer.get(P+suffix)).status_code==404
    finally:await peer.aclose()
    async with db.connection() as conn,conn.transaction():
        await conn.execute('ALTER TABLE simple_ledger_files DISABLE TRIGGER retain_simple_ledger_file')
        await conn.execute('UPDATE simple_ledger_files SET raw=%s WHERE owner_id=%s AND request_id=%s',(b'restored corrupt bytes',admin,rid))
        await conn.execute('ALTER TABLE simple_ledger_files ENABLE TRIGGER retain_simple_ledger_file')
    assert (await client.get(P+'/originals/'+rid)).status_code==503
    assert (await client.get(P+'/operations/'+rid)).status_code==503
    assert (await client.post(P+'/operations/'+rid+'/close',json={})).status_code==503
    assert await financial_counts(db)==before


def modified(raw,change):
    output=io.BytesIO()
    with ZipFile(io.BytesIO(raw)) as archive,ZipFile(output,'w',ZIP_DEFLATED) as target:
        files={name:archive.read(name)for name in archive.namelist()};change(files)
        for name,body in files.items():target.writestr(name,body)
    return output.getvalue()


def test_workbook_registered_relationships_date1904_iso_cells_and_unknown_flow_are_not_balances():
    raw=export([{'name':'Observed','cur':'USD','hist':[{'d':'2026-01-01','v':'7.000000000000000001'}]}])
    def date1904(files):
        book=ET.fromstring(files['xl/workbook.xml']);ET.SubElement(book,NS+'workbookPr',date1904='1');files['xl/workbook.xml']=ET.tostring(book)
        files['xl/styles.xml']=f'<styleSheet xmlns="{NS[1:-1]}"><cellXfs count="1"><xf numFmtId="14"/></cellXfs></styleSheet>'.encode()
        sheet=ET.fromstring(files['xl/worksheets/sheet1.xml']);cell=next(c for c in sheet.iter(NS+'c')if c.get('r')=='B5');cell.set('s','0');cell.find(NS+'v').text=str((date(2026,1,1)-date(1904,1,1)).days);files['xl/worksheets/sheet1.xml']=ET.tostring(sheet)
        files['xl/worksheets/sheet99.xml']=files['xl/worksheets/sheet1.xml']
    shifted=parse(modified(raw,date1904))
    assert len(shifted)==1 and shifted[0]['hist'][0]['d']=='2026-01-01'
    def iso(files):
        sheet=ET.fromstring(files['xl/worksheets/sheet1.xml']);cell=next(c for c in sheet.iter(NS+'c')if c.get('r')=='B5');cell.set('t','d');cell.find(NS+'v').text='2026-01-01T00:00:00Z';files['xl/worksheets/sheet1.xml']=ET.tostring(sheet)
    assert parse(modified(raw,iso))[0]['hist'][0]['d']=='2026-01-01'
    unknown=parse(export([{'name':'Only a declared flow','cur':None,'hist':[{'d':'2026-01-01','v':None,'inn':'12','out':'0'}]}]))[0]
    assert unknown['amount'] is None and unknown['hist'][0]['v'] is None and unknown['inAmt'] is None and unknown['cur'] is None and unknown['market'] is None
    def external(files):files['xl/_rels/workbook.xml.rels']=b'<Relationships><Relationship Id="rId1" TargetMode="External" Target="https://example.invalid/sheet.xml"/></Relationships>'
    with pytest.raises(HTTPException):parse(modified(raw,external))


def test_frozen_original_normalize_metadata_arrays_and_declared_fx_transport(tmp_path):
    import json
    import subprocess
    from decimal import Decimal
    from pathlib import Path

    from alcor_api.simple_ledger import legacy_normalize
    fixture=Path(__file__).parents[1]/'fixtures/simple-ledger-source'
    original=(fixture/'simpleStore.ts').read_bytes()
    assert hashlib.sha256(original).hexdigest()==json.loads((fixture/'source.json').read_text())['sha256']
    source=original.decode();statement='import { getDb } from "./db";'
    assert source.count(statement)==1
    source=source.replace(statement,'')
    module=tmp_path/'original-normalize.ts'
    module.write_text(source+"\nimport {readFileSync} from 'node:fs';process.stdout.write(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(normalizeSimple)));\n")
    inputs=[{}, {'hide':'false','excludeFixed':[],'cash':{},'invest':None,'members':[],'fx':'ignored','displayCur':''}, {'expected':'invalid','reminder':'','cashflow':'x'}, {'expected':None,'reminder':'2.5','fx':{'USD':None},'cash':[{'id':'declared','amount':'9007199254740993.123456789'}]}]
    output=subprocess.run(['node','--experimental-strip-types',str(module)],input=json.dumps(inputs),text=True,capture_output=True,check=True)
    old=json.loads(output.stdout)
    for raw,expected in zip(inputs,old,strict=True):
        current=legacy_normalize(raw)
        # Canonical exact text is an explicit transport delta; source defaults
        # remain declared display preferences, never observed live FX.
        assert {k:None if v is None else Decimal(str(v)) for k,v in current['fx'].items()}=={k:None if v is None else Decimal(str(v))for k,v in expected['fx'].items()}
        assert {k:v for k,v in current.items()if k!='fx'}=={k:v for k,v in expected.items()if k!='fx'}
