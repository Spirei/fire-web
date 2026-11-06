"""Explicit initialization/CRUD over the same preference and record authority."""

import asyncio
import json
from uuid import uuid4

import pytest
from request_telemetry_tables import REQUEST_TELEMETRY_TABLES
from alcor_api.backups import tables_and_hashes
from alcor_api.native_app_auth import issue_grant
from alcor_api.portfolio_records import PortfolioRecords


async def native(db,owner,scope='portfolio.read portfolio.write'):
    async with db.connection() as conn:
        user=await (await conn.execute('SELECT * FROM users WHERE id=%s',(owner,))).fetchone()
        pair=await issue_grant(conn,user,scope,'Synthetic watch groups')
    return {'authorization':'Bearer '+pair['access_token']},pair


async def initialize(client,headers):
    response=await client.post('/api/watch-groups/operations',headers=headers,json={'requestId':str(uuid4()),'expectedRevision':0,'action':'initialize','data':{}})
    assert response.status_code==200,response.text
    return response.json()


async def hashes(db):
    async with db.connection() as conn,conn.transaction():result=await tables_and_hashes(conn)
    # Legacy GET retains its real PG abuse-throttle counter. It must not seed,
    # migrate, touch receipts/preferences/records or change any business table.
    # Delayed observability flushes are independent of the read route, including
    # under concurrent regression load. These are not preferences or receipts.
    telemetry = REQUEST_TELEMETRY_TABLES | {"auth_rate_limits"}
    return {name: row for name, row in result.items() if name not in telemetry}


@pytest.mark.parametrize('version',[1,2])
async def test_uninitialized_GETs_are_pure_explicit_initialize_CAS_and_receipt(client,db,admin,version):
    headers,_=await native(db,admin);before=await hashes(db)
    canonical=await client.get('/api/watch-groups',headers=headers)
    assert canonical.status_code==200 and canonical.json()=={'groups':[],'revision':0,'initialized':False}
    old=await client.get(f'/api/v{version}/watch-groups',headers=headers)
    assert old.status_code==409 and '显式初始化' in old.json()['message']
    assert await hashes(db)==before
    accepted=await initialize(client,headers)
    assert accepted['initialized'] is True and accepted['revision']==1
    before=await hashes(db)
    result=await client.get(f'/api/v{version}/watch-groups',headers=headers)
    assert result.status_code==200 and len(result.json()['data']['groups'])==6
    receipt=await client.get('/api/watch-groups/operations/'+accepted['requestId'],headers=headers)
    assert receipt.json()==accepted and await hashes(db)==before


@pytest.mark.parametrize('version',[1,2])
async def test_new_owner_create_rename_visible_assign_delete_and_original_tombstone_replay(client,db,admin,version):
    headers,_=await native(db,admin);path=f'/api/v{version}/watch-groups'
    created=await client.post(path,headers=headers,json={'name':'  Research  '})
    assert created.status_code==200,created.text
    group=created.json()['data']['group'];assert group['name']=='Research' and group['sort']==6
    uid=str(uuid4())
    updated=await client.put(path+'/'+group['id'],headers={**headers,'x-alcor-request-id':uid},json={'name':'Long term','visible':True})
    assert updated.status_code==200,updated.text
    assert updated.json()['data']['group']['name']=='Long term' and updated.json()['data']['group']['visible']==1
    operations=await client.get('/api/watch-groups/operations/'+uid,headers=headers)
    assert operations.status_code==200 and operations.json()['group']['id']==group['id']
    records=PortfolioRecords(db)
    preview=await records.preview(admin,'create',{'name':'Observed record','code':'AAPL','market':'US','price':None,'qty':None,'cost':None,'group':'','note':''})
    record=(await records.confirm(admin,preview['previewId'],uuid4()))['recordId']
    assigned=await client.post(f'/api/v{version}/records/group-assign',headers=headers,json={'ids':[record],'groupId':group['id']})
    assert assigned.status_code==200,assigned.text
    async with db.connection() as conn:
        before=await (await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s',(admin,record))).fetchone()
    uid=str(uuid4());deleted=await client.delete(path+'/'+group['id'],headers={**headers,'x-alcor-request-id':uid})
    assert deleted.status_code==200 and deleted.json()['data']=={'deleted':True}
    replay=await client.delete(path+'/'+group['id'],headers={**headers,'x-alcor-request-id':uid})
    assert replay.json()==deleted.json()
    again=await client.delete(path+'/'+group['id'],headers=headers)
    assert again.status_code==200 and again.json()['data']=={'deleted':False}
    async with db.connection() as conn:
        current=await (await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s',(admin,record))).fetchone()
        tombstone=await (await conn.execute('SELECT deleted_at FROM watch_groups WHERE owner_id=%s AND id=%s',(admin,group['id']))).fetchone()
        assert (await (await conn.execute('SELECT count(*) AS n FROM cash_ledger_entries')).fetchone())['n']==0
        assert (await (await conn.execute('SELECT count(*) AS n FROM trade_ledger')).fetchone())['n']==0
    assert current['watch_group_id'] is None and current['watch_group_sort']==0 and tombstone['deleted_at'] is not None
    for field in ('qty','cost','price','source','group_name'):assert current[field]==before[field]
    assert current['revision']>before['revision']


async def test_read_scope_cannot_initialize_or_write_and_unknown_ids_do_not_claim_deletion(client,db,admin):
    read,_=await native(db,admin,'portfolio.read')
    denied=await client.post('/api/watch-groups/operations',headers=read,json={'requestId':str(uuid4()),'expectedRevision':0,'action':'initialize','data':{}})
    assert denied.status_code==403
    headers,_=await native(db,admin);await initialize(client,headers)
    for version in (1,2):
        path=f'/api/v{version}/watch-groups/unknown-legacy-id'
        for method in ('PUT','DELETE'):
            response=await client.request(method,path,headers=read,json={'name':'Blocked'} if method=='PUT' else None)
            assert response.status_code==403 and response.headers['x-alcor-retire-context']=='true'
        missing=await client.delete(path,headers=headers)
        assert missing.status_code==409 and '不能推断已删除' in missing.json()['message']
        icon=await client.put(path,headers=headers,json={'icon':'https://example.invalid/icon.png'})
        assert icon.status_code==409 and '旧编号需明确映射' in icon.json()['message']
    market=(await client.get('/api/v2/watch-groups',headers=headers)).json()['data']['groups'][0]['id']
    denied=await client.delete('/api/v2/watch-groups/'+market,headers=headers)
    assert denied.status_code==400 and '市场分组不可删除' in denied.json()['message']


async def test_late_native_revocation_no_group_changes_and_UUID_conflict_is_atomic(client,db,admin):
    headers,pair=await native(db,admin);await initialize(client,headers)
    response=await client.post('/api/v2/watch-groups',headers=headers,json={'name':'Owned'})
    group=response.json()['data']['group'];uid=str(uuid4())
    update=await client.put('/api/v2/watch-groups/'+group['id'],headers={**headers,'x-alcor-request-id':uid},json={'name':'Renamed'})
    assert update.status_code==200
    conflict=await client.put('/api/v2/watch-groups/'+group['id'],headers={**headers,'x-alcor-request-id':uid},json={'name':'Different'})
    assert conflict.status_code==409
    async def chunks():
        async with db.connection() as conn:await conn.execute("UPDATE identity_app_grants SET scope='portfolio.read' WHERE id=%s",(pair['grant_id'],))
        yield json.dumps({'name':'Forbidden late update'}).encode()
    denied=await client.put('/api/v2/watch-groups/'+group['id'],headers=headers,content=chunks())
    assert denied.status_code==403 and denied.headers['x-alcor-retire-context']=='true'
    async with db.connection() as conn:
        current=await (await conn.execute('SELECT name FROM watch_groups WHERE owner_id=%s AND id=%s',(admin,group['id']))).fetchone()
    assert current['name']=='Renamed'


async def test_initialization_and_default_preferences_do_not_auto_migrate_legacy_record_broker_names(client,db,admin):
    records=PortfolioRecords(db)
    preview=await records.preview(admin,'create',{'name':'Metadata only','code':'AAPL','market':'US','price':None,'qty':None,'cost':None,'group':'Legacy broker label','note':''})
    record=(await records.confirm(admin,preview['previewId'],uuid4()))['recordId']
    headers,_=await native(db,admin);await initialize(client,headers)
    read=await client.get('/api/v2/watch-groups',headers=headers)
    assert len(read.json()['data']['groups'])==6
    async with db.connection() as conn:
        value=await (await conn.execute('SELECT group_name,watch_group_id FROM portfolio_records WHERE owner_id=%s AND id=%s',(admin,record))).fetchone()
    assert value['group_name']=='Legacy broker label' and value['watch_group_id'] is None


@pytest.mark.parametrize('version',[1,2])
async def test_actual_old_route_store_CRUD_goldens_on_explicitly_initialized_collection(client,db,admin,version):
    import hashlib
    import os
    import subprocess
    from pathlib import Path

    root=os.environ.get('ALCOR_WATCH_LEGACY_ROOT')
    if not root:pytest.skip('Explicit read-only old Web source required')
    here=Path(__file__).parent;evidence=json.loads((here/'source-evidence.json').read_text())
    for name,wanted in evidence['source_sha256'].items():assert hashlib.sha256((Path(root)/name).read_bytes()).hexdigest()==wanted
    headers,_=await native(db,admin);await initialize(client,headers)
    steps=[{'method':'GET'},{'method':'POST','body':{'name':' Research ','extra':True}},{'method':'PUT','target':'custom','body':{'name':None,'visible':'0x1'}},{'method':'PUT','target':'custom','body':{'visible':[]}},{'method':'PUT','target':'custom','body':{'name':['a','b'],'visible':False}},{'method':'PUT','target':'market','body':{'name':'美股重命名','visible':1}},{'method':'DELETE','target':'custom'},{'method':'DELETE','target':'custom'},{'method':'GET'},{'method':'POST','body':{'name':'港股'}},{'method':'DELETE','target':'market'}]
    old=json.loads(await asyncio.to_thread(subprocess.check_output,['node',str(here/'run_old_group_golden.cjs'),root],input=json.dumps({'version':version,'steps':steps}),text=True))
    assert old['memoryOnly'] is True
    aliases={};custom='';market='';path=f'/api/v{version}/watch-groups'
    for step,expected in zip(steps,old['results'],strict=True):
        target=custom if step.get('target')=='custom' else market if step.get('target')=='market' else ''
        response=await client.request(step['method'],path+('/'+target if target else ''),headers=headers,json=step.get('body') if 'body' in step else None)
        assert response.status_code==expected['status'],response.text
        current=response.json();wanted=expected['body']
        if step['method']=='GET':
            by_market={g['market']:g for g in current['data']['groups'] if g['kind']=='market'}
            for group in wanted['data']['groups']:
                if group['kind']=='market':aliases[group['id']]=by_market[group['market']]['id']
            market=by_market['US']['id']
        if step['method']=='POST' and response.status_code==200:
            custom=current['data']['group']['id'];aliases[wanted['data']['group']['id']]=custom
        def mapped(value):
            if isinstance(value,list):return [mapped(v) for v in value]
            if isinstance(value,dict):return {k:aliases.get(v,v) if k=='id' and isinstance(v,str) else mapped(v) for k,v in value.items()}
            return value
        assert current==mapped(wanted)


@pytest.fixture(scope='session')
def actual_ios_decoder(tmp_path_factory):
    import hashlib
    import os
    import shutil
    import subprocess
    from pathlib import Path

    root=os.environ.get('ALCOR_WATCH_IOS_ROOT')
    if not root or not shutil.which('swiftc'):pytest.skip('Explicit old iOS source and Swift compiler required')
    source=Path(root)/'StockLog/Models/Models.swift';evidence=json.loads((Path(__file__).parent/'source-evidence.json').read_text())
    assert hashlib.sha256(source.read_bytes()).hexdigest()==evidence['ios_sha256']['StockLog/Models/Models.swift']
    text=source.read_text();start=text.index('struct WatchGroup:');end=text.index('// MARK: - 行情',start)
    directory=tmp_path_factory.mktemp('actual-watch-group-swift');model=directory/'Original.swift';model.write_text('import Foundation\n'+text[start:end])
    harness=directory/'Main.swift';harness.write_text('''import Foundation
struct Batch: Codable { let groups:[WatchGroup] }
@main struct Main { static func main() throws { let batch=try JSONDecoder().decode(Batch.self,from:FileHandle.standardInput.readDataToEndOfFile());FileHandle.standardOutput.write(try JSONEncoder().encode(batch)) } }
''')
    binary=directory/'decode';subprocess.run(['swiftc','-module-cache-path',str(directory/'module-cache'),str(model),str(harness),'-o',str(binary)],capture_output=True,check=True,text=True)
    return binary


async def test_actual_old_iOS_WatchGroup_decoder_roundtrips_original_seven_fields(client,db,admin,actual_ios_decoder):
    import subprocess

    headers,_=await native(db,admin)
    created=await client.post('/api/v2/watch-groups',headers=headers,json={'name':'iOS metadata'})
    assert created.status_code==200
    result=(await client.get('/api/v2/watch-groups',headers=headers)).json()['data']
    decoded=json.loads(await asyncio.to_thread(subprocess.check_output,[str(actual_ios_decoder)],input=json.dumps(result),text=True))
    assert decoded==result
