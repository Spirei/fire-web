"""Retained originals, unknown reference values and no collection on legacy GETs."""
import hashlib
import json
from datetime import UTC, datetime
from decimal import Decimal, localcontext
from fractions import Fraction
from uuid import uuid4

import pytest
from alcor_api.fx_reference import persist
from alcor_api.market_calendar import Calendars
from alcor_api.reference_integrity import fx_observation
from request_telemetry_tables import business_table_hashes


async def test_inserted_fx_value_without_original_evidence_is_unavailable_not_quoted(client,app,db,admin):
    raw=b'{"amount":1,"base":"USD","date":"2026-01-02","rates":{"HKD":7.8}}'
    observation=uuid4()
    async with db.connection() as conn,conn.transaction():
        await persist(conn,raw,datetime(2026,1,3,tzinfo=UTC),observation)
    good=await client.get('/api/reference/rates')
    assert good.status_code==200 and good.json()['rates']=={'USD':'1','HKD':'7.8'}
    async with db.connection() as conn,conn.transaction():
        # Simulate an incoherent restored/partially imported projection using a
        # new append-only row; no trigger or financial authority is disabled.
        await conn.execute("INSERT INTO fx_values(observation_id,currency,rate) VALUES(%s,'JPY',150)",(observation,))
        before=await business_table_hashes(conn)
    response=await client.get('/api/reference/rates')
    assert response.status_code==200 and response.json()['state']=='retained_unavailable',response.text
    assert response.json()['rates']=={'USD':'1'} and response.json()['quoted']==[]
    assert response.json()['updatedAt'] is None and response.json()['receivedAt'] is None
    from alcor_api.financing_model import debt
    from alcor_api.financing_policies import saved_rates
    from alcor_api.legacy_asset_snapshot import convert
    assert convert(Decimal('12.3456789'),'JPY','JPY',response.json()['rates'])==Decimal('12.3456789')
    assert convert(Decimal('12.3456789'),'JPY','USD',response.json()['rates']) is None
    async with db.connection() as conn,conn.transaction():
        rates,evidence=await saved_rates(conn)
    assert evidence['observationId']==str(observation) and evidence['receivedAt'] is None
    assert evidence['integrityState']=='unavailable' and evidence['fallback'] is False
    assert debt({'JPY':Decimal(-100)},'JPY',rates)==100
    with pytest.raises(ValueError):debt({'JPY':Decimal(-100)},'USD',rates)
    for path in ('/api/v1/rates','/api/v2/rates'):
        response=await client.get(path+'?refresh=1')
        assert response.status_code==502 and response.json()['code']==50002,response.text
    async with db.connection() as conn,conn.transaction():
        assert await business_table_hashes(conn)==before
        kept=await(await conn.execute('SELECT original_bytes,raw_sha256 FROM fx_observations WHERE id=%s',(observation,))).fetchone()
        assert bytes(kept['original_bytes'])==raw and kept['raw_sha256']==hashlib.sha256(raw).hexdigest()


async def test_retained_calendar_original_corruption_cannot_publish_verified_days_or_etag(client,db):
    await Calendars(db).ensure_builtin()
    normal=await client.get('/api/v2/market-calendar?market=HK&year=2026')
    assert normal.status_code==200
    async with db.connection() as conn,conn.transaction():
        # Synthetic restored-corruption vector only in this isolated test DB.
        # Production's immutable trigger remains unchanged and re-enabled.
        await conn.execute('ALTER TABLE market_calendar_releases DISABLE TRIGGER retain_calendar_release')
        await conn.execute("UPDATE market_calendar_releases SET original_bytes=original_bytes || ' '::bytea")
        await conn.execute('ALTER TABLE market_calendar_releases ENABLE TRIGGER retain_calendar_release')
        before=await business_table_hashes(conn)
    for suffix in ('?market=HK&year=2026','/batch?year=2026','/batch?year=2028'):
        bad=await client.get('/api/v2/market-calendar'+suffix,headers={'If-None-Match':normal.headers['etag']})
        assert bad.status_code==503 and 'etag' not in bad.headers,bad.text
    assert await Calendars(db).discovery() is None
    async with db.connection() as conn,conn.transaction():
        assert await business_table_hashes(conn)==before


def test_custom_non_usd_exact_fraction_reparse_and_mismatched_projection_rejected():
    from alcor_api.fx_provider_parser import parse
    raw=b'{"data":{"base":"EUR","rates":{"USD":1.2,"JPY":180},"timestamp":"1700000000"}}'
    config={'url':'https://fixed.example/[redacted]','declared_base':'EUR','time_field':'data.timestamp','time_precision':'epoch_seconds'}
    ratios=parse(raw,'EUR')['usd_ratios']
    row={'provider':'custom','provider_revision':uuid4(),'source_uri':config['url'],'base_currency':'USD','original_bytes':raw,
         'raw_sha256':hashlib.sha256(raw).hexdigest(),'received_at':datetime(2026,1,3,tzinfo=UTC),
         'observation_date':None,'source_instant':datetime.fromtimestamp(1700000000,UTC),'source_precision':'instant',
         'normalized_sha256':hashlib.sha256(json.dumps({key:[str(value.numerator),str(value.denominator)] for key,value in ratios.items()},sort_keys=True).encode()).hexdigest()}
    with localcontext() as precision:
        precision.prec=50
        values=[{'currency':key,'rate':Decimal(value.numerator)/Decimal(value.denominator),'numerator':Decimal(value.numerator),'denominator':Decimal(value.denominator)} for key,value in ratios.items() if key!='USD']
    fx_observation(row,values,config)
    assert Fraction(next(value for value in values if value['currency']=='EUR')['rate'])!=Fraction(5,6)
    for changed in ([{**value,'rate':value['rate']+1} for value in values], [{**value,'numerator':None,'denominator':None} for value in values]):
        with pytest.raises(ValueError):fx_observation(row,changed,config)
    with pytest.raises(ValueError):fx_observation({**row,'original_bytes':raw+b' '},values,config)


@pytest.mark.parametrize('status,raw,complete',[(401,b'{"error":"synthetic-credential-echo"}',True),(200,b'{broken-json',True),(200,b'x'*131073,False)])
async def test_failed_fx_keeps_private_bounded_response_and_original_uuid_never_refetches(client,db,app,admin,status,raw,complete):
    import httpx
    calls=[]
    def reply(request):
        calls.append(request)
        return httpx.Response(status,content=raw)
    service=app.state.reference_rates
    service.transport=httpx.MockTransport(reply)
    async with db.connection() as conn:
        await conn.execute('UPDATE fx_config SET enabled=true')
    request_id=str(uuid4())
    queued=await client.post('/api/reference/rates/refresh',json={'requestId':request_id})
    assert queued.status_code==202,queued.text
    assert await service.once()=='failed'
    receipt=await client.get('/api/reference/rates/operations/'+request_id)
    assert receipt.status_code==200 and receipt.json()['state']=='failed',receipt.text
    original=receipt.json()['responseOriginal']
    assert original['httpStatus']==status and original['complete']==complete
    assert original['method']=='POST' and original['access']=='current_admin_password_and_factor'
    assert 'synthetic-credential-echo' not in receipt.text
    assert (await client.get(original['downloadPath'])).status_code==404
    denied=await client.post(original['downloadPath'],json={'password':'wrong-proof'})
    assert denied.status_code==403 and 'synthetic-credential-echo' not in denied.text,denied.text
    downloaded=await client.post(original['downloadPath'],json={'password':'Synthetic9Pass'})
    assert downloaded.status_code==200,downloaded.text
    assert downloaded.content==raw[:131072]
    assert downloaded.headers['x-alcor-source-sha256']==hashlib.sha256(raw[:131072]).hexdigest()
    assert downloaded.headers['x-alcor-source-complete']==str(complete).lower()
    assert 'no-store' in downloaded.headers['cache-control']
    assert (await client.post('/api/reference/rates/refresh',json={'requestId':request_id})).status_code==202
    assert await service.once()=='idle' and len(calls)==1
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM fx_response_pages')).fetchone())['n']==1
        assert (await(await conn.execute('SELECT count(*) n FROM fx_observations')).fetchone())['n']==0
        # Losing the administrative role cannot reuse even the exact password.
        await conn.execute("UPDATE users SET role='user' WHERE id=%s",(admin,))
    revoked=await client.post(original['downloadPath'],json={'password':'Synthetic9Pass'})
    assert revoked.status_code==403 and raw[:30].decode(errors='replace') not in revoked.text


async def test_fx_response_arriving_after_disable_is_retained_without_observation_or_retry(client,db,app,admin):
    import httpx
    raw=b'{"amount":1,"base":"USD","date":"2026-01-02","rates":{"HKD":7.8}}'
    calls=[]
    async def reply(request):
        calls.append(request)
        async with db.connection() as conn:
            await conn.execute('UPDATE fx_config SET enabled=false,revision=revision+1')
        return httpx.Response(200,content=raw)
    service=app.state.reference_rates
    service.transport=httpx.MockTransport(reply)
    async with db.connection() as conn:
        await conn.execute('UPDATE fx_config SET enabled=true')
    request_id=str(uuid4())
    await client.post('/api/reference/rates/refresh',json={'requestId':request_id})
    assert await service.once()=='failed'
    receipt=(await client.get('/api/reference/rates/operations/'+request_id)).json()
    assert receipt['responseOriginal']['httpStatus']==200 and receipt['responseOriginal']['complete'] is True
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM fx_observations')).fetchone())['n']==0
        kept=await(await conn.execute('SELECT raw_bytes FROM fx_response_pages')).fetchone()
        assert bytes(kept['raw_bytes'])==raw
    assert (await client.get('/api/v2/rates')).json()['data']['quoted']==[]
    await client.post('/api/reference/rates/refresh',json={'requestId':request_id})
    assert await service.once()=='disabled' and len(calls)==1


async def test_response_storage_boundary_never_labels_oversized_prefix_complete(client,db,app,admin):
    from alcor_api.fx_response_originals import LIMIT, ResponseRejected, retain
    service=app.state.reference_rates
    async with db.connection() as conn:
        await conn.execute('UPDATE fx_config SET enabled=true')
    request_id=str(uuid4())
    assert (await client.post('/api/reference/rates/refresh',json={'requestId':request_id})).status_code==202
    state,task=await service.claim_task()
    assert state=='running'
    oversized=b'{"rates":{"HKD":7.8}}'+b' ' * LIMIT
    assert ResponseRejected(oversized,200,True).complete is False
    await retain(db,task,str(db.settings.instance_id),oversized,200,True,'http_response_body')
    from fastapi import HTTPException
    for changed,origin in ((task,str(uuid4())),({**task,'owner_id':'other-owner'},str(db.settings.instance_id)),({**task,'provider_revision':uuid4()},str(db.settings.instance_id))):
        with pytest.raises(HTTPException) as refused:
            await retain(db,changed,origin,oversized,200,True,'http_response_body')
        assert refused.value.status_code==503
    # Repeating exactly the same archival step is safe, never a new collection.
    await retain(db,task,str(db.settings.instance_id),oversized,200,True,'http_response_body')
    async with db.connection() as conn:
        page=await(await conn.execute('SELECT raw_bytes,raw_sha256,complete FROM fx_response_pages WHERE task_id=%s',(task['id'],))).fetchone()
        assert bytes(page['raw_bytes'])==oversized[:LIMIT] and page['complete'] is False
        assert page['raw_sha256']==hashlib.sha256(oversized[:LIMIT]).hexdigest()
        assert (await(await conn.execute('SELECT count(*) n FROM fx_observations')).fetchone())['n']==0
