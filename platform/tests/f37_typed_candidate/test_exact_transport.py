"""Actual HTTP/JSONB numeric types and separate legacy defaults; synthetic owners only."""
import asyncio
import hashlib
import json
import subprocess
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import httpx
from alcor_api.cli import create_user
from alcor_api.security import COOKIE
from psycopg.types.json import Jsonb
from simple_ops_candidate.test_simple_ops import financial_counts
from test_account_admin import login

ROOT='/api/account/simple-ledger'
HUGE=900719925474099312345678901234567890123456789


def read(response):
    return json.loads(response.text,parse_float=Decimal,parse_int=int)


def command(rid,revision=0):
    return ('{"requestId":'+json.dumps(rid)+',"expectedRevision":'+str(revision)+',"ledger":'
        '{"fx":{},"cash":[],"invest":[],"opaque":{"tiny":1e-1000,"scaled":1.2300,"huge":'+str(HUGE)+',"literal":"1e-1000","unknown":{"flag":false,"value":null,"raw":[1.2300,1e-1000]}}}}')


def assert_numbers(body):
    opaque=body['ledger']['opaque']
    assert isinstance(opaque['tiny'],Decimal) and opaque['tiny']==Decimal('1e-1000')
    assert isinstance(opaque['scaled'],Decimal) and opaque['scaled']==Decimal('1.2300')
    assert type(opaque['huge']) is int and opaque['huge']==HUGE
    assert type(opaque['literal']) is str and opaque['literal']=='1e-1000'
    assert opaque['unknown']['flag'] is False and opaque['unknown']['value'] is None
    assert opaque['unknown']['raw']==[Decimal('1.2300'),Decimal('1e-1000')]
    assert all(isinstance(item,Decimal) for item in opaque['unknown']['raw'])


async def test_canonical_exact_jsonb_numeric_types_replay_conflict_stale_and_owner(client,admin,db,settings,app):
    financial=await financial_counts(db)
    initial=await client.get(ROOT);assert initial.status_code==200,initial.text
    assert initial.json()['revision']==0
    # These are valid finite JSON tokens, but outside PostgreSQL numeric bounds.
    for token in ('1e1000000','1e-1000000'):
        rejected=await client.put(ROOT,content=command(str(uuid4())).replace('"tiny":1e-1000','"tiny":'+token),headers={'content-type':'application/json'})
        assert rejected.status_code in (400,413),rejected.text
        async with db.connection() as conn:
            for table in ('simple_ledger_heads','simple_ledger_versions','simple_ledger_operations'):
                assert (await(await conn.execute('SELECT count(*) n FROM '+table+' WHERE owner_id=%s',(admin,))).fetchone())['n']==0
    rid=str(uuid4());raw=command(rid)
    saved=await client.put(ROOT,content=raw,headers={'content-type':'application/json'})
    assert saved.status_code==200,saved.text
    assert_numbers(read(saved))
    fetched=await client.get(ROOT);assert fetched.status_code==200,fetched.text
    assert_numbers(read(fetched))
    receipt=await client.get(ROOT+'/operations/'+rid);assert receipt.status_code==200,receipt.text
    assert_numbers(read(receipt))
    replay=await client.put(ROOT,content=raw,headers={'content-type':'application/json'})
    assert replay.status_code==200,replay.text
    assert read(replay)==read(saved)
    # Numeric source tokens and text declarations must never share a new fingerprint.
    changed=await client.put(ROOT,content=raw.replace('"tiny":1e-1000','"tiny":"1e-1000"'),headers={'content-type':'application/json'})
    assert changed.status_code==409,changed.text
    stale=await client.put(ROOT,content=command(str(uuid4())),headers={'content-type':'application/json'})
    assert stale.status_code==409,stale.text
    assert_numbers(read(await client.get(ROOT)))
    await create_user(settings,'TypedOther','Synthetic9Pass')
    peer=await login(app,'TypedOther')
    try:
        foreign=await peer.get(ROOT+'/operations/'+rid)
        assert foreign.status_code==404,foreign.text
        other=await peer.get(ROOT)
        assert other.status_code==200 and other.json()['revision']==0 and 'opaque' not in other.json()['ledger']
        mismatch=await client.get(ROOT,headers={'x-simple-ledger-user':'foreign-owner'})
        assert mismatch.status_code==409,mismatch.text
    finally:await peer.aclose()
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM simple_ledger_versions WHERE owner_id=%s',(admin,))).fetchone())['n']==1
        assert (await(await conn.execute('SELECT count(*) n FROM simple_ledger_operations WHERE owner_id=%s',(admin,))).fetchone())['n']==1
        stored=await(await conn.execute('SELECT result FROM simple_ledger_operations WHERE owner_id=%s AND request_id=%s',(admin,rid))).fetchone()
        assert stored['result']['fingerprintVersion']=='typed-exact-v2'
    assert await financial_counts(db)==financial


async def test_pre_versioned_fingerprint_receipt_replays_immutable_old_result_without_writes(client,admin,db):
    rid=str(uuid4());raw=command(rid)
    parsed=json.loads(raw,parse_float=Decimal)
    # Exact historical v1 fingerprint: old wire converted Decimal to strings.
    old_wire=json.loads(json.dumps(parsed,default=str,ensure_ascii=False))
    fingerprint=hashlib.sha256(json.dumps(old_wire,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    historical={'requestId':rid,'state':'completed','revision':7,'ledger':old_wire['ledger'],'scope':'independent_personal_ledger','legacyClientIdempotency':True,'protocolMode':'canonical'}
    async with db.connection() as conn,conn.transaction():
        await conn.execute('INSERT INTO simple_ledger_operations(owner_id,request_id,fingerprint,result)VALUES(%s,%s,%s,%s)',(admin,rid,fingerprint,Jsonb(historical)))
        original=await(await conn.execute('SELECT fingerprint,result::text AS bytes FROM simple_ledger_operations WHERE owner_id=%s AND request_id=%s',(admin,rid))).fetchone()
    replay=await client.put(ROOT,content=raw,headers={'content-type':'application/json'})
    assert replay.status_code==200,replay.text
    assert read(replay)==historical  # Retain the historical bug honestly; do not rewrite original receipt.
    async with db.connection() as conn:
        after=await(await conn.execute('SELECT fingerprint,result::text AS bytes FROM simple_ledger_operations WHERE owner_id=%s AND request_id=%s',(admin,rid))).fetchone()
        assert after==original
        for table in ('simple_ledger_heads','simple_ledger_versions'):
            assert (await(await conn.execute('SELECT count(*) n FROM '+table+' WHERE owner_id=%s',(admin,))).fetchone())['n']==0
    # Only a truly absent version is historical; null or future versions cannot select v1.
    for version in (None,'future-unrecognized'):
        invalid_id=str(uuid4());invalid_raw=command(invalid_id)
        old=json.loads(json.dumps(json.loads(invalid_raw,parse_float=Decimal),default=str,ensure_ascii=False))
        invalid_fp=hashlib.sha256(json.dumps(old,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        async with db.connection() as conn,conn.transaction():
            await conn.execute('INSERT INTO simple_ledger_operations(owner_id,request_id,fingerprint,result)VALUES(%s,%s,%s,%s)',(admin,invalid_id,invalid_fp,Jsonb({**historical,'requestId':invalid_id,'fingerprintVersion':version})))
        refused=await client.put(ROOT,content=invalid_raw,headers={'content-type':'application/json'})
        assert refused.status_code==409,refused.text


async def test_canonical_unknown_fx_legacy_defaults_and_strict_mixed_credentials(client,admin,db,app,tmp_path):
    initial=await client.get(ROOT)
    assert initial.status_code==200,initial.text
    assert not {'USD','HKD'} & set(initial.json()['ledger']['fx'])
    async with db.connection() as conn:
        user=await(await conn.execute('SELECT * FROM users WHERE id=%s',(admin,))).fetchone()
        token,_=await app.state.legacy_create_session(conn,user,str(uuid4()))
    platform=client.cookies.get(COOKIE)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app,raise_app_exceptions=False),base_url='http://testserver',headers={'origin':'http://testserver'}) as browser:
        old=await browser.get('/api/v1/simple-ledger',headers={'cookie':'fire_session='+token})
        assert old.status_code==200,old.text
        assert old.json()['data']['fx']=={'CNY':'1','HKD':'0.92','USD':'7.18'}
        saved_old=await browser.put('/api/v1/simple-ledger',headers={'authorization':'Bearer '+token,'x-alcor-request-id':str(uuid4())},json={'hide':'nonempty','expected':'invalid','cash':[]})
        assert saved_old.status_code==200,saved_old.text
        assert saved_old.json()['data']['hide'] is True and saved_old.json()['data']['expected']==8
        assert saved_old.json()['data']['fx']==old.json()['data']['fx']
        fixture=Path(__file__).parents[1]/'fixtures/simple-ledger-source'
        original=(fixture/'simpleStore.ts').read_bytes()
        assert hashlib.sha256(original).hexdigest()==json.loads((fixture/'source.json').read_text())['sha256']
        source=original.decode();statement='import { getDb } from "./db";'
        assert source.count(statement)==1
        module=tmp_path/'original-metadata.ts'
        module.write_text(source.replace(statement,'')+"\nprocess.stdout.write(JSON.stringify(normalizeSimple({reminder:'36.5',expected:'7.25'})));\n")
        oracle=await asyncio.to_thread(subprocess.run,['node','--experimental-strip-types',str(module)],capture_output=True,text=True,check=True)
        expected=json.loads(oracle.stdout,parse_float=Decimal)
        fractional=await browser.put('/api/v1/simple-ledger',headers={'authorization':'Bearer '+token,'x-alcor-request-id':str(uuid4())},json={'reminder':'36.5','expected':'7.25'})
        assert fractional.status_code==200,fractional.text
        for response in (fractional,await browser.get('/api/v1/simple-ledger',headers={'cookie':'fire_session='+token})):
            assert response.status_code==200,response.text
            metadata=read(response)['data']
            for key in ('reminder','expected'):
                assert isinstance(metadata[key],Decimal) and metadata[key]==expected[key]

        for stale in ('stale-compatibility-cookie',''):
            cookie=f'{COOKIE}={platform}; fire_session={stale}; stocklog_session='
            good=await browser.get(ROOT,headers={'cookie':cookie})
            assert good.status_code==200,good.text
        for bad in ('','bad-platform'):
            denied=await browser.get(ROOT,headers={'cookie':f'{COOKIE}={bad}; fire_session={token}'})
            assert denied.status_code in (401,403),denied.text
        for authorization in ('','Basic invalid','Bearer ','Bearer invalid'):
            denied=await browser.get(ROOT,headers={'cookie':f'{COOKIE}={platform}; fire_session={token}','authorization':authorization,'x-csrf-token':client.headers['x-csrf-token']})
            assert denied.status_code in (401,403),denied.text
        duplicate=await browser.get(ROOT,headers=[('cookie',f'{COOKIE}={platform}; fire_session={token}'),('authorization','Bearer invalid'),('authorization','Bearer another')])
        assert duplicate.status_code in (401,403),duplicate.text
    # Saving a fresh canonical document must not install static legacy FX either.
    current=await client.get(ROOT);revision=current.json()['revision']
    response=await client.put(ROOT,json={'requestId':str(uuid4()),'expectedRevision':revision,'ledger':{'cash':[],'invest':[]}})
    assert response.status_code==200,response.text
    assert not {'USD','HKD'} & set(response.json()['ledger']['fx'])


async def test_short_exponent_array_expansion_budget_rejected_without_writes_but_single_exact(client,admin,db):
    opaque='['+','.join(['1e-16383']*129)+']'
    rid=str(uuid4())
    raw='{"requestId":'+json.dumps(rid)+',"expectedRevision":0,"ledger":{"opaque":'+opaque+'}}'
    refused=await client.put(ROOT,content=raw,headers={'content-type':'application/json'})
    assert refused.status_code==413,refused.text
    async with db.connection() as conn:
        for table in ('simple_ledger_heads','simple_ledger_versions','simple_ledger_operations'):
            assert (await(await conn.execute('SELECT count(*) n FROM '+table+' WHERE owner_id=%s',(admin,))).fetchone())['n']==0
    assert (await client.get(ROOT+'/operations/'+rid)).status_code==404
    single='{"requestId":'+json.dumps(str(uuid4()))+',"expectedRevision":0,"ledger":{"opaque":[1e-16383]}}'
    saved=await client.put(ROOT,content=single,headers={'content-type':'application/json'})
    assert saved.status_code==200,saved.text
    for response in (saved,await client.get(ROOT)):
        assert response.status_code==200,response.text
        value=read(response)['ledger']['opaque'][0]
        assert isinstance(value,Decimal) and value==Decimal('1e-16383')
