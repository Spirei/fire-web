"""Actual old TS geometry oracle and fake local OCR, never actual screenshots/Vision."""
import hashlib
import json
import subprocess
from datetime import UTC,datetime,timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from alcor_api.record_snapshot_parser import parse_snapshot,raw_text
from test_legacy_portfolio import register


def line(text,x,y):return {'text':text,'x':x,'y':y,'w':0.05,'h':0.02}


VECTORS=[
 [line('名称',0,.95),line('成本',.4,.95),line('AAPL',0,.8),line('Apple Inc',.1,.8),line('100',.3,.8),line('120.25',.5,.8),line('130.50',.7,.8),line('+1.2%',.9,.8)],
 [line('00700.HK',0,.8),line('腾讯控股',.2,.802),line('100股',.4,.8),line('300.5',.6,.8),line('2915亿',.8,.8),line('00700.HK',0,.6),line('重复',.2,.6)],
 [line('SH600519',0,.8),line('贵州茅台',.2,.8),line('成本',.35,.8),line('1500.5',.5,.8),line('现价',.6,.8),line('1600.2',.8,.8)],
 [line('总资产',0,.9),line('NASDAQ',0,.8),line('股票名称',0,.7),line('不存在',0,.6),line('Alphabet Inc',0,.5),line('BABA.US',0,.4),line('-0.25%',.5,.4)],
 [line('7203.JP',0,.9),line('Toyota Motor',.2,.9),line('10',.4,.9),line('123.45',.6,.9),line('005930.KS',0,.7),line('Samsung',.2,.7)],
]


def test_actual_original_typescript_geometry_and_raw_text_match():
    source=Path(__file__).parents[1]/'fixtures/record-vision-source/snapshotParser.ts'
    script='import {parseSnapshot,rawText} from '+json.dumps(source.as_uri())+';const vectors='+json.dumps(VECTORS,ensure_ascii=False)+';console.log(JSON.stringify(vectors.map(x=>({rows:parseSnapshot(x),raw:rawText(x)}))));'
    result=subprocess.run(['node','--experimental-strip-types','--input-type=module','-e',script],capture_output=True,text=True,check=True,timeout=10)
    expected=json.loads((source.parent/'source-sha256.json').read_text())
    assert hashlib.sha256(source.read_bytes()).hexdigest()==expected['lib/snapshotParser.ts']
    assert json.loads(result.stdout)==[{'rows':parse_snapshot(v),'raw':raw_text(v)}for v in VECTORS]


@pytest.mark.parametrize('outcome',['observed','revoke'])
async def test_installed_local_provider_has_durable_attempt_original_and_no_reexecution(client,app,db,settings,monkeypatch,outcome):
    from alcor_api import local_record_vision
    owner=await register(client)
    settings.record_ocr_targets=[{'id':'local-vision','provider':'apple-vision','model':'apple-vision-v1','ownerId':owner,
        'instanceId':str(settings.instance_id),'purpose':'record.screenshot.ocr','approvedAccess':True,
        'licenseRevision':'synthetic-local-license','expiresAt':(datetime.now(UTC)+timedelta(hours=1)).isoformat()}]
    original=json.dumps(VECTORS[0]).encode();calls=[]
    async def fake(raw,mime):
        calls.append(mime)
        if outcome=='revoke':
            async with db.connection() as conn:await conn.execute('DELETE FROM sessions WHERE user_id=%s',(owner,))
        return original
    monkeypatch.setattr(local_record_vision,'recognize',fake)
    import io
    from PIL import Image
    picture=io.BytesIO();Image.new('RGB',(2,2)).save(picture,format='PNG')
    rid=str(uuid4())
    response=await client.post('/api/portfolio/record-imports/sources',data={'format':'image','requestId':rid,'targetId':'local-vision'},files={'file':('safe.png',picture.getvalue(),'image/png')})
    assert response.status_code==200,response.text
    value=response.json()
    assert value['state']==('recognized'if outcome=='observed'else'retained_unavailable'),value
    async with db.connection() as conn:
        archived=await(await conn.execute('SELECT r.provider_raw FROM record_import_source_results r JOIN record_import_sources s ON s.owner_id=r.owner_id AND s.id=r.source_id WHERE s.owner_id=%s AND s.request_id=%s',(owner,uuid5_attempt(rid)))).fetchone()
        assert bytes(archived['provider_raw'])==original
    if outcome=='observed':
        assert value['provider']=='apple-vision' and value['rows'][0]['code']=='AAPL'
        again=await client.post('/api/portfolio/record-imports/sources',data={'format':'image','requestId':rid,'targetId':'local-vision'},files={'file':('safe.png',picture.getvalue(),'image/png')})
        assert again.json()==value
    assert calls==['image/png']


def uuid5_attempt(rid):
    from uuid import UUID,uuid5
    return uuid5(UUID(rid),'ocr-attempt:0')


@pytest.mark.parametrize('first',['empty','unknown','revoke','rejected'])
async def test_explicit_fallback_preserves_each_attempt_and_never_follows_unknown_or_revoked(client,app,db,settings,monkeypatch,first):
    from alcor_api import local_record_vision
    from alcor_api.record_image_ocr import hashed_target
    owner=await register(client)
    common={'ownerId':owner,'instanceId':str(settings.instance_id),'purpose':'record.screenshot.ocr','approvedAccess':True,
        'licenseRevision':'synthetic-license','expiresAt':(datetime.now(UTC)+timedelta(hours=1)).isoformat()}
    cloud={**common,'id':'cloud','provider':'deepseek','model':'deepseek-flash','addresses':['8.8.8.8'],
           'host':'api.deepseek.com','credentialCiphertext':'synthetic-not-decrypted','fallbackTargetId':'local'}
    local={**common,'id':'local','provider':'apple-vision','model':'apple-vision-v1'}
    settings.record_ocr_targets=[cloud,local]
    rid=str(uuid4());seen=[]
    async def cloud_reply(who,tid,raw):
        seen.append('cloud')
        if first=='revoke':
            async with db.connection() as conn:await conn.execute('DELETE FROM sessions WHERE user_id=%s',(owner,))
        return {'state':'unknown'if first=='unknown'else'rejected'if first=='rejected'else'recognized','rows':[],'raw':b'synthetic-cloud-original','text':'',
                'status':401 if first=='rejected' else 200,'complete':True,
                'provider':'deepseek','targetFingerprint':hashed_target(cloud)}
    async def local_reply(raw,mime):
        seen.append('local')
        async with db.connection() as conn:
            stored=await(await conn.execute('SELECT provider_raw FROM record_import_source_results WHERE owner_id=%s AND request_id=%s',(owner,uuid5_attempt(rid)))).fetchone()
            assert bytes(stored['provider_raw'])==b'synthetic-cloud-original'
        return json.dumps(VECTORS[0]).encode()
    monkeypatch.setattr(app.state.record_file_imports.ocr,'recognize_cloud',cloud_reply)
    monkeypatch.setattr(local_record_vision,'recognize',local_reply)
    import io
    from PIL import Image
    picture=io.BytesIO();Image.new('RGB',(2,2)).save(picture,format='PNG')
    path='/api/records/import-image' if first=='empty' else '/api/portfolio/record-imports/sources'
    data={'requestId':rid} if first=='empty' else {'format':'image','requestId':rid,'targetId':'cloud'}
    response=await client.post(path,data=data,files={'file':('safe.png',picture.getvalue(),'image/png')})
    assert response.status_code==200,response.text
    expected={'empty':'recognized','unknown':'unknown','revoke':'retained_unavailable','rejected':'recognized'}
    assert response.json()['state']==expected[first],response.text
    assert seen==(['cloud','local']if first in ('empty','rejected')else['cloud'])
    async with db.connection() as conn:
        stored=await(await conn.execute('SELECT provider_raw FROM record_import_source_results WHERE owner_id=%s AND request_id=%s',(owner,uuid5_attempt(rid)))).fetchone()
        assert bytes(stored['provider_raw'])==b'synthetic-cloud-original'


async def test_legacy_local_unavailable_environment_is_503_without_invoking_any_command(client,app,db,settings,monkeypatch):
    from alcor_api import local_record_vision
    owner=await register(client)
    settings.record_ocr_targets=[{'id':'local-only','provider':'apple-vision','model':'apple-vision-v1','ownerId':owner,
        'instanceId':str(settings.instance_id),'purpose':'record.screenshot.ocr','approvedAccess':True,
        'licenseRevision':'synthetic-local-license','expiresAt':(datetime.now(UTC)+timedelta(hours=1)).isoformat()}]
    monkeypatch.setattr(local_record_vision.sys,'platform','linux')
    async def forbidden(*args,**kwargs):raise AssertionError('No actual OS tool may run')
    monkeypatch.setattr(local_record_vision,'command',forbidden)
    import io
    from PIL import Image
    picture=io.BytesIO();Image.new('RGB',(2,2)).save(picture,format='PNG')
    response=await client.post('/api/records/import-image',files={'file':('safe.png',picture.getvalue(),'image/png')})
    assert response.status_code==503,response.text
    assert response.json()['state']=='unavailable' and 'macOS' in response.json()['error']
    rid=response.headers['x-alcor-request-id']
    assert (await client.get('/api/portfolio/record-imports/operations/'+rid)).json()['state']=='unavailable'


@pytest.mark.skipif(__import__('sys').platform!='darwin',reason='Actual Apple Vision requires macOS')
async def test_actual_macos_swift_vision_only_synthetic_text_and_private_temp_cleanup(tmp_path,monkeypatch):
    import io
    import math
    from PIL import Image,ImageDraw,ImageFont
    from alcor_api import local_record_vision
    # This is only generated text, never a real screenshot or financial observation.
    image=Image.new('RGB',(1000,260),'white')
    font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',80)
    ImageDraw.Draw(image).text((40,65),'AAPL SYNTHETIC',fill='black',font=font)
    buffer=io.BytesIO();image.save(buffer,format='PNG')
    monkeypatch.setattr(local_record_vision.tempfile,'tempdir',str(tmp_path))
    actual_command=local_record_vision.command;compiles=[]
    async def observed_command(arguments,*args,**kwargs):
        if len(arguments)>1 and arguments[1]=='swiftc':compiles.append(arguments)
        return await actual_command(arguments,*args,**kwargs)
    monkeypatch.setattr(local_record_vision,'command',observed_command)
    raw=await local_record_vision.recognize(buffer.getvalue(),'image/png')
    again=await local_record_vision.recognize(buffer.getvalue(),'image/png')
    assert len(compiles)==1 and json.loads(again)==json.loads(raw)
    rows=json.loads(raw)
    assert rows and any('AAPL' in row['text'].upper() for row in rows)
    assert all(all(isinstance(row[k],(int,float)) and math.isfinite(row[k]) and 0<=row[k]<=1 for k in ('x','y','w','h')) for row in rows)
    import shutil
    caches=list(tmp_path.iterdir())
    assert len(caches)==1 and caches[0].name.startswith('alcor-record-vision-')
    assert len(list(caches[0].glob('*/manifest.json')))==1
    shutil.rmtree(caches[0])
    assert list(tmp_path.iterdir())==[]


@pytest.mark.parametrize('failure',['stream','budget'])
async def test_cloud_partial_http_bytes_are_archived_and_unknown_never_falls_back(client,app,db,settings,monkeypatch,failure):
    import io
    from contextlib import asynccontextmanager
    from cryptography.fernet import Fernet
    import httpcore
    from PIL import Image
    import alcor_api.record_image_ocr as module
    owner=await register(client);key=Fernet.generate_key()
    token=Fernet(key).encrypt(json.dumps({'kind':'record-ocr:partial','instance':str(settings.instance_id),'password':'synthetic-provider-token'}).encode()).decode()
    settings.record_ocr_targets=[{'id':'partial','provider':'deepseek','model':'deepseek-flash','ownerId':owner,
        'instanceId':str(settings.instance_id),'purpose':'record.screenshot.ocr','approvedAccess':True,
        'licenseRevision':'synthetic-license','expiresAt':(datetime.now(UTC)+timedelta(hours=1)).isoformat(),
        'addresses':['8.8.8.8'],'host':'api.deepseek.com','credentialCiphertext':token,'fallbackTargetId':'not-installed'}]
    monkeypatch.setattr(module.NotificationSecurity,'existing_key',lambda self:key)
    async def pins(host,port):return ['8.8.8.8']
    monkeypatch.setattr(module,'resolve',pins)
    calls=[]
    class Reply:
        status=200
        async def aiter_stream(self):
            yield b'first-part'
            if failure=='stream':raise httpcore.ReadError('synthetic interrupted body')
            yield b'x'*1000000
    class Pool:
        def __init__(self,**kwargs):pass
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
        @asynccontextmanager
        async def stream(self,*args,**kwargs):
            calls.append('POST');yield Reply()
    monkeypatch.setattr(module.httpcore,'AsyncConnectionPool',Pool)
    picture=io.BytesIO();Image.new('RGB',(2,2)).save(picture,format='PNG');rid=str(uuid4())
    async def upload():return await client.post('/api/portfolio/record-imports/sources',data={'format':'image','requestId':rid,'targetId':'partial'},files={'file':('safe.png',picture.getvalue(),'image/png')})
    response=await upload()
    assert response.status_code==200,response.text
    assert response.json()['state']=='unknown' and response.json()['complete'] is False
    expected=b'first-part' if failure=='stream' else b'first-part'+b'x'*(1000000-len(b'first-part'))
    async with db.connection() as conn:
        archived=await(await conn.execute('SELECT provider_raw,result FROM record_import_source_results WHERE owner_id=%s AND request_id=%s',(owner,uuid5_attempt(rid)))).fetchone()
        assert bytes(archived['provider_raw'])==expected and archived['result']['complete'] is False
        assert archived['result']['providerRawSha256']==hashlib.sha256(expected).hexdigest()
    assert (await upload()).json()==response.json() and calls==['POST']


async def test_private_compiled_cache_reuses_verified_bytes_and_rejects_symlinks(tmp_path,monkeypatch):
    from alcor_api import local_record_vision as module
    from fastapi import HTTPException
    monkeypatch.setattr(module.tempfile,'tempdir',str(tmp_path))
    source=tmp_path/'source.swift';source.write_text('// synthetic compile only')
    work=tmp_path/'work';work.mkdir(mode=0o700);calls=[]
    async def compile_fake(arguments,*args):
        calls.append(arguments)
        Path(arguments[arguments.index('-o')+1]).write_bytes(b'synthetic-trusted-binary')
        return b''
    monkeypatch.setattr(module,'command',compile_fake)
    binary=await module.cached_binary(source,'/Synthetic/MacOSX.sdk',work)
    assert (await module.cached_binary(source,'/Synthetic/MacOSX.sdk',work))==binary and len(calls)==1
    binary.unlink();binary.symlink_to(source)
    with pytest.raises(HTTPException) as error:
        await module.cached_binary(source,'/Synthetic/MacOSX.sdk',work)
    assert error.value.status_code==503 and len(calls)==1
