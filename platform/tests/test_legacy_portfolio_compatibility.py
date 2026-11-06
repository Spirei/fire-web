"""Synthetic legacy golden contracts against the actually mounted HTTP routes."""
import json
from datetime import datetime
from uuid import uuid4

import pytest
from alcor_api.portfolio_receipts import archive_original_receipt, validate_original_receipt
from alcor_api.portfolio_records import PortfolioRecords
from fastapi import HTTPException
from psycopg.errors import RaiseException
from test_legacy_portfolio import grant, record, register


@pytest.mark.asyncio
@pytest.mark.parametrize('version', [1, 2])
async def test_assignment_holes_actual_time_and_market_projection(client, db, version):
    owner = await register(client)
    headers = await grant(db, owner)
    first = await record(db, owner, code='AAPL', market='US', accountMarket='')
    second = await record(db, owner, code='MSFT', market='US', accountMarket='')
    hk = await record(db, owner, code='00700', market='HK')
    ids = [first['recordId'], second['recordId']]
    path = f'/api/v{version}/records'
    group = (await client.post(f'/api/v{version}/watch-groups', headers=headers, json={'name':'Synthetic'})).json()['data']['group']['id']
    assigned = await client.post(path+'/group-assign', headers=headers, json={'ids':['absent', ids[0], 'missing', ids[1], ids[0]], 'groupId':group})
    assert assigned.status_code == 200 and assigned.json()['data'] == {'updated':2}
    async with db.connection() as conn:
        rows = await (await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND id=ANY(%s) ORDER BY watch_group_sort', (owner, ids))).fetchall()
    assert [r['watch_group_sort'] for r in rows] == [1,3]
    assert rows[0]['updated_at'] > datetime.fromisoformat(first['record']['updatedAt'])
    assert all(r['qty'] is None and r['price'] == 0 and r['cost'] == -2.5 for r in rows)
    assert (await client.post(path+'/group-assign', headers=headers,json={'ids':['absent'],'groupId':group})).json()['data'] == {'updated':0}
    prior = (await client.get(path, headers=headers)).json()['meta']['collectionRevision']
    reordered = await client.post(path+'/group-reorder', headers=headers,json={'ids':ids,'groupId':'market:US'})
    assert reordered.status_code == 200 and reordered.json()['data'] == {'updated':2}
    listing = (await client.get(path, headers=headers)).json()['data']
    assert [r['id'] for r in listing] == [*ids,hk['recordId']]
    stamps = [datetime.fromisoformat(r['updatedAt']) for r in listing[:2]]
    assert (stamps[0]-stamps[1]).total_seconds() == .001
    single = (await client.get(path+'/'+ids[1],headers=headers)).json()['data']
    assert single == listing[1]
    async with db.connection() as conn:
        actual = await (await conn.execute('SELECT updated_at FROM portfolio_records WHERE owner_id=%s AND id=%s',(owner,ids[1]))).fetchone()
    assert actual['updated_at'] > stamps[1]
    assert (await client.get(path+f'?collectionRevision={prior}',headers=headers)).status_code == 409
    # A subsequent real metadata update invalidates only that record's projection.
    service = PortfolioRecords(db)
    current = await service.snapshot(owner, ids[1])
    proof = await service.preview(owner,'update',{**{k: current['record'][k] for k in ('name','code','market','price','cost','qty','group','note')}, 'note':'edited'}, record_id=ids[1], revision=current['record']['revision'])
    await service.confirm(owner,proof['previewId'],uuid4())
    async with db.connection() as conn:
        assert not await (await conn.execute('SELECT 1 FROM portfolio_legacy_ordering WHERE owner_id=%s AND record_id=%s',(owner,ids[1]))).fetchone()


def failed(identifier):
    return json.dumps({'requestId': identifier,'kind': 'update','recordId': 'source-record','state': 'failed','code': 40902,'message': '版本变化','record': None,'deleted': False,'revision': None,'collectionRevision': 18,'createdAt': '2026-01-01T00:00:00.001Z','completedAt': '2026-01-01T00:00:01.002Z'},ensure_ascii=False,indent=1).encode()


@pytest.mark.asyncio
@pytest.mark.parametrize('version',[1,2])
async def test_original_receipt_bytes_uuid_reservation_and_provenance(client,db,version):
    owner = await register(client)
    headers = await grant(db,owner)
    identifier = str(uuid4())
    raw = failed(identifier)
    async with db.connection() as conn:
        target = (await (await conn.execute('SELECT current_database() AS name')).fetchone())['name']
    kwargs = {'owner': owner,'request_id': identifier,'raw': raw,'source_instance': uuid4(),'source_owner_id': 'explicit-source-owner','import_batch': uuid4(),'expected_database': target,'expected_instance': db.settings.instance_id}
    sha = await archive_original_receipt(db,**kwargs)
    assert await archive_original_receipt(db,**kwargs) == sha
    with pytest.raises(HTTPException) as conflict:
        await archive_original_receipt(db,**dict(kwargs,source_owner_id='another-owner'))
    assert conflict.value.status_code == 409
    with pytest.raises(ValueError):
        await archive_original_receipt(db,**dict(kwargs,expected_database='wrong-target'))
    response = await client.get(f'/api/v{version}/records/operations/{identifier}',headers=headers)
    assert response.status_code == 200
    assert response.content == b'{"code":0,"message":"ok","data":'+raw+b'}'
    assert 'no-store' in response.headers['cache-control']
    assert response.json()['data']['code'] == 40902
    service = PortfolioRecords(db)
    proof = await service.preview(owner,'create',{'name':'New','code':'NEW','market':'US','price':None,'cost':None,'qty':None,'group':'','note':''})
    before = await service.list(owner)
    with pytest.raises(HTTPException) as duplicate:
        await service.confirm(owner,proof['previewId'],identifier)
    assert duplicate.value.status_code == 409
    assert await service.list(owner) == before
    async with db.connection() as conn:
        with pytest.raises(RaiseException):
            async with conn.transaction():
                await conn.execute('DELETE FROM portfolio_legacy_receipts WHERE owner_id=%s AND request_id=%s',(owner,identifier))
    client.cookies.clear()
    other = await register(client,'OtherReceiptOwner')
    foreign = await grant(db,other)
    assert (await client.get(f'/api/v{version}/records/operations/{identifier}',headers=foreign)).status_code == 404


def test_original_receipt_invalid_ambiguous_json_rejected():
    identifier = str(uuid4())
    raw = failed(identifier)
    validate_original_receipt(raw,identifier)
    for bad in [raw[:-1]+b',"code":0}',raw.replace(b'40902',b'NaN'),raw.replace(identifier.encode(),str(uuid4()).encode())]:
        with pytest.raises(ValueError):
            validate_original_receipt(bad,identifier)


@pytest.mark.asyncio
async def test_legacy_empty_market_and_null_group_and_atomic_failure(client, db):
    owner = await register(client)
    headers = await grant(db, owner)
    created = await record(db, owner)
    identifier = created['recordId']
    for group_id in (None, [], ''):
        result = await client.post('/api/v2/records/group-assign',headers=headers,json={'ids':[identifier],'groupId':group_id})
        assert result.status_code == 200 and result.json()['data'] == {'updated':1}
    assert (await client.post('/api/v2/records/group-reorder',headers=headers,json={'ids':[identifier],'groupId':'market:'})).status_code == 200
    from alcor_api.watchlists import WatchGroups
    service = PortfolioRecords(db)
    before = await service.snapshot(owner,identifier)
    async with db.connection() as conn:
        await conn.execute("CREATE FUNCTION reject_test_watch_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$")
        await conn.execute('CREATE TRIGGER reject_test_watch_receipt BEFORE INSERT ON watch_group_operations FOR EACH ROW EXECUTE FUNCTION reject_test_watch_receipt()')
    with pytest.raises(RaiseException):
        await WatchGroups(db).mutate(owner,'legacy-assign',{'ids':[identifier],'groupId':''},uuid4())
    assert await service.snapshot(owner,identifier) == before


@pytest.mark.parametrize('kind',['create','update','delete'])
def test_original_completed_receipt_preserves_nonzero_revision_and_exact_numbers(kind):
    identifier = str(uuid4())
    value = json.loads(failed(identifier))
    value.update(kind=kind,state='completed',code=0,message='ok',revision=7,deleted=kind=='delete')
    if kind != 'delete':
        value['record'] = {'id':value['recordId'],'name':'Example','code':'EX','market':'US','group':'','note':'','updatedAt':value['completedAt'],'price':0,'cost':1.234567890123,'qty':''}
    raw = json.dumps(value,ensure_ascii=False,indent=2).encode()
    assert validate_original_receipt(raw,identifier)[0] == value


@pytest.mark.asyncio
@pytest.mark.parametrize('version',[1,2])
@pytest.mark.parametrize('kind',['create','update','delete'])
async def test_archived_success_is_returned_without_reserializing(client,db,version,kind):
    owner = await register(client)
    headers = await grant(db,owner,'portfolio.read')
    identifier = str(uuid4())
    value = json.loads(failed(identifier))
    value.update(kind=kind,state='completed',code=0,message='ok',revision=3,deleted=kind=='delete')
    if kind != 'delete':
        value['record'] = {'id':value['recordId'],'name':'Example','code':'EX','market':'US','group':'','note':'','updatedAt':value['completedAt'],'price':0,'cost':2.345678901234,'qty':''}
    raw = json.dumps(value,indent=2,ensure_ascii=False).encode()
    async with db.connection() as conn:
        target = (await (await conn.execute('SELECT current_database() AS name')).fetchone())['name']
    await archive_original_receipt(db,owner=owner,request_id=identifier,raw=raw,source_instance=uuid4(),source_owner_id='source-owner',import_batch=uuid4(),expected_database=target,expected_instance=db.settings.instance_id)
    response = await client.get(f'/api/v{version}/records/operations/{identifier}',headers=headers)
    assert response.status_code == 200 and response.content == b'{"code":0,"message":"ok","data":'+raw+b'}'
    assert response.json()['data'] == value
    assert (await PortfolioRecords(db).list(owner))['records'] == []
