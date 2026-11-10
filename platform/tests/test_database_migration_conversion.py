"""Real prepared archives, conversion provenance, duplicate admission and fail-closed gaps."""
import json
import threading
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg.types.json import Jsonb

from alcor_api.backups import BackupFailure
from alcor_api.database_migration_capture import CaptureBudget
from alcor_api.database_migration_jobs import execute as prepare
from alcor_api.database_migration_conversion import execute as convert
from alcor_api.database_migration_transform import FrozenTables,transform
from alcor_api.worker import claim
from test_database_migration_preparation import migration_source


def add_source(dsn):
    with psycopg.connect(dsn) as conn:
        conn.execute('CREATE TABLE ledger.users(id text PRIMARY KEY,username text,password_hash text)')
        conn.execute("INSERT INTO ledger.users VALUES('source-owner','source-login','must-not-return')")
        conn.execute('''CREATE TABLE ledger.broker_accounts(id text,user_id text,name text,provider_id text,currency text,currencies_json text,account_kind text,holding_source text,revision bigint,created_at text,updated_at text)''')
        conn.execute("INSERT INTO ledger.broker_accounts VALUES('old-account','source-owner','Original broker','longbridge','USD','[\"USD\"]','','manual',1,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')")
        conn.execute('''CREATE TABLE ledger.records(id text,user_id text,name text,code text,market text,account_market text,price numeric,qty numeric,cost numeric,group_name text,watch_group_id text,watch_group_sort bigint,note text,source text,broker_account_id text,revision bigint,updated_at text)''')
        conn.execute("""INSERT INTO ledger.records VALUES('position','source-owner','Source security','TEST','US','',123.000000000000000001,2,100.000000000000000001,'Original broker','',0,'source note','manual','old-account',1,'2020-01-01T00:00:00Z'),('watch','source-owner','Watch security','NEXT','US','',NULL,NULL,NULL,'','',0,'','','',1,'2020-01-01T00:00:00Z')""")


async def test_real_conversion_retains_exact_values_and_blocks_unproved_import(client,db,settings,pg,migration_source,monkeypatch):
    config,revision=migration_source
    add_source(pg.get_uri(database=config['database']))
    started=await client.post('/api/fire/database-migration/preparations',json={'request_id':str(uuid4()),'source_revision':revision})
    assert started.status_code==202,started.text
    task=await claim(db,uuid4());await prepare(db,task)
    prefix='/api/fire/database-migration/preparations/'+str(task['id'])+'/conversion'
    context=await client.get(prefix)
    assert context.status_code==200,context.text
    assert context.json()['users']==[{'id':'source-owner','username':'source-login'}]
    assert 'must-not-return' not in context.text and 'password_hash' not in context.text
    command={'request_id':str(uuid4()),'source_owner':'source-owner','timezone':'Asia/Shanghai','account_kinds':{'old-account':'real'},'market_accounts':{'US':'old-account'}}
    admitted=await client.post(prefix,json=command)
    assert admitted.status_code==202,admitted.text
    assert (await client.post(prefix,json=command)).json()['id']==admitted.json()['id']
    assert (await client.post(prefix,json=command|{'request_id':str(uuid4())})).status_code==409
    job=await claim(db,uuid4());assert str(job['id'])==admitted.json()['id']
    await convert(db,job)
    response=await client.get('/api/fire/tasks/'+str(job['id']))
    assert response.status_code==200,response.text
    value=response.json();assert value['status']=='succeeded',value
    result=value['result'];assert result['phase']=='conversion_requires_review'
    assert result['business_written'] is False and result['cutover_ready'] is False
    domains={row['key']:row for row in result['domains']}
    assert domains['positions']['source']==2 and domains['positions']['holdings']==1
    assert result['issue_counts']['source_table_coverage_incomplete']>=1
    directory=settings.backup_dir/'database-migration-conversions'/str(job['id'])/'attempt-1'
    plan=json.loads((directory/'conversion-plan.json').read_bytes())
    raw=plan['raw_snapshot']['tables']['records']['rows'][0]
    assert raw['price']['text']=='123.000000000000000001'
    assert raw['cost']['text']=='100.000000000000000001' and raw['cost']['storedDecimalExact'] is True
    assert plan['raw_rewritten'] is False and 'must-not-return' not in (directory/'conversion-plan.json').read_text()
    assert 'rawBase64' not in response.text and 'raw_snapshot' not in response.text and str(settings.backup_dir) not in response.text
    async with db.connection() as conn:
        for table in ('portfolio_records','trade_ledger','cash_ledger_entries'):
            assert (await(await conn.execute(f'SELECT count(*) AS n FROM {table}')).fetchone())['n']==0
    assert (await client.get(prefix)).json()['items'][0]['id']==str(job['id'])
    assert result['portfolio_ready'] is True
    from alcor_api.database_migration_portfolio import execute as import_portfolio
    from alcor_api.portfolio_records import PortfolioRecords
    endpoint='/api/fire/database-migration/conversions/'+str(job['id'])+'/portfolio'
    payload={'request_id':str(uuid4()),'plan_sha256':result['plan_sha256'],'confirmed_registered_values':True}
    admitted_import=await client.post(endpoint,json=payload)
    assert admitted_import.status_code==202,admitted_import.text
    assert (await client.post(endpoint,json=payload)).json()['id']==admitted_import.json()['id']
    import_task=await claim(db,uuid4())
    assert str(import_task['id'])==admitted_import.json()['id']
    # A changed live source cannot be silently replaced by an older position snapshot.
    with psycopg.connect(pg.get_uri(database=config['database'])) as original:
        original.execute("UPDATE ledger.records SET qty=3 WHERE id='position'")
    with pytest.raises(BackupFailure,match='来源持仓或分组已变化'):
        await import_portfolio(db,import_task)
    with psycopg.connect(pg.get_uri(database=config['database'])) as original:
        original.execute("UPDATE ledger.records SET qty=2 WHERE id='position'")
    # Fault after one native record operation must roll back the entire batch.
    original_confirm=PortfolioRecords.confirm
    calls=0
    async def fail_second(self,*args,**kwargs):
        nonlocal calls
        calls+=1
        if calls==2:raise BackupFailure('synthetic interrupted batch')
        return await original_confirm(self,*args,**kwargs)
    monkeypatch.setattr(PortfolioRecords,'confirm',fail_second)
    with pytest.raises(BackupFailure,match='synthetic interrupted batch'):
        await import_portfolio(db,import_task)
    async with db.connection() as conn:
        for table in ('portfolio_records','broker_accounts','trade_ledger','cash_ledger_entries','database_migration_portfolio_imports'):
            assert (await(await conn.execute(f'SELECT count(*) AS n FROM {table}')).fetchone())['n']==0
    monkeypatch.setattr(PortfolioRecords,'confirm',original_confirm)
    import alcor_api.worker as worker
    original_finish=worker.finish
    async def forbidden_separate_finish(*args,**kwargs):
        raise AssertionError('business, receipt and completed task must commit together')
    monkeypatch.setattr(worker,'finish',forbidden_separate_finish)
    await import_portfolio(db,import_task)
    monkeypatch.setattr(worker,'finish',original_finish)
    imported=(await client.get('/api/fire/tasks/'+str(import_task['id']))).json()
    assert imported['status']=='succeeded',imported
    assert imported['result']['counts']=={'records':2,'holdings':1,'accounts':1,'groups':0}
    assert imported['result']['business_written'] is True and imported['result']['cash_posted'] is False
    assert imported['result']['history_imported'] is False and imported['result']['identity_switched'] is False
    cancelled=await client.post('/api/fire/database-migration/portfolio/cancel',json={'request_id':payload['request_id']})
    assert cancelled.status_code==200 and cancelled.json()['status']=='succeeded'
    assert cancelled.json()['result']['business_written'] is True
    async with db.connection() as conn:
        rows=await(await conn.execute('SELECT code,qty,cost,price,history_state FROM portfolio_records ORDER BY code')).fetchall()
        position=next(row for row in rows if row['code']=='TEST')
        assert str(position['cost'])=='100.000000000000000001' and str(position['price'])=='123.000000000000000001'
        assert position['qty']==2 and position['history_state']=='unknown'
        for table in ('trade_ledger','cash_ledger_entries'):
            assert (await(await conn.execute(f'SELECT count(*) AS n FROM {table}')).fetchone())['n']==0
    # Unknown acknowledgement and worker re-entry read the same atomic commit.
    await import_portfolio(db,import_task)
    assert (await client.post(endpoint,json=payload)).json()['id']==admitted_import.json()['id']
    assert (await client.post(endpoint,json=payload|{'request_id':str(uuid4())})).status_code==409
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) AS n FROM portfolio_records')).fetchone())['n']==2
        assert (await(await conn.execute('SELECT count(*) AS n FROM database_migration_portfolio_imports')).fetchone())['n']==1
    resumed=(await client.get(prefix)).json()
    assert resumed['resume']['preparation']['id']==str(task['id'])
    assert resumed['resume']['portfolio_request_id']==payload['request_id']
    assert resumed['previous_input']['market_accounts']==command['market_accounts']
    # A later verified snapshot must still lead to the original business import.
    async with db.connection() as conn:
        original_preparation=await(await conn.execute('SELECT * FROM tasks WHERE id=%s',(task['id'],))).fetchone()
        newer_id=uuid4()
        newer_payload=original_preparation['payload']|{'_retry':{'archive_task':str(task['id']),'archive_attempt':1}}
        await conn.execute("INSERT INTO tasks(id,owner_id,request_id,fingerprint,kind,status,attempts,payload,result) VALUES(%s,%s,%s,'synthetic-new-snapshot','database.migration.prepare','succeeded',1,%s,%s)",
                           (newer_id,task['owner_id'],uuid4(),Jsonb(newer_payload),Jsonb(original_preparation['result'])))
    newer=(await client.get('/api/fire/database-migration/preparations/'+str(newer_id)+'/conversion')).json()
    assert newer['resume']['preparation']['id']==str(task['id'])
    assert newer['resume']['conversion_request_id']==command['request_id']
    listing=(await client.get('/api/fire/database-migration/preparations')).json()['items']
    assert listing[0]['id']==str(task['id']) and listing[0]['has_imports'] is True
    settings.source_revision='b'*40
    duplicate=await client.post('/api/fire/database-migration/preparations',json={'request_id':str(uuid4()),'source_revision':revision})
    assert duplicate.status_code==409 and '无需重新准备' in duplicate.text
    settings.source_revision='a'*40
    # Changing the sealed source after admission must stop the next task before conversion.
    next_command=command|{'request_id':str(uuid4())}
    again=await client.post(prefix,json=next_command);assert again.status_code==202,again.text
    next_task=await claim(db,uuid4())
    original=settings.backup_dir/'database-migrations'/str(task['id'])/'attempt-1/source'
    manifest=json.loads((original/'manifest.json').read_bytes())
    record_table=next(row for row in manifest['tables'] if row['name']=='records')
    with (original/record_table['file']).open('ab') as changed:changed.write(b'{}\n')
    with pytest.raises(BackupFailure,match='变化'):await convert(db,next_task)


async def test_conversion_cannot_use_failed_or_other_owners_preparation(client,db,settings,pg,migration_source):
    _config,revision=migration_source
    task=await client.post('/api/fire/database-migration/preparations',json={'request_id':str(uuid4()),'source_revision':revision})
    prefix='/api/fire/database-migration/preparations/'+task.json()['id']+'/conversion'
    assert (await client.get(prefix)).status_code==409
    command={'request_id':str(uuid4()),'source_owner':'source-owner','timezone':'Asia/Shanghai'}
    assert (await client.post(prefix,json=command)).status_code==409
    assert (await client.post('/api/fire/database-migration/preparations/'+str(uuid4())+'/conversion',json=command)).status_code==404
    cancelled=await client.post('/api/fire/database-migration/conversions/cancel',json={'request_id':command['request_id']})
    assert cancelled.status_code==200 and cancelled.json()['status']=='cancelled'
    late=await client.post(prefix,json=command)
    assert late.status_code==202 and late.json()['status']=='cancelled'
    async with db.connection() as conn:
        assert (await(await conn.execute("SELECT count(*) AS n FROM tasks WHERE kind='database.migration.convert' AND status='queued'")).fetchone())['n']==0


def test_explicit_order_attribution_wins_without_rewriting_a_conflicting_market_rule():
    from alcor_api.database_migration_transform import choose_account
    facts={'accounts':{'source-a':{},'source-b':{}},'labels':{'original-label':'source-a'},'markets':{'US':'source-a','HK':'source-b'},'names':{'Exact original name':['source-a']}}
    assert choose_account('US','original-label',None,**facts)==('source-a',False)
    assert choose_account('HK','original-label',None,**facts)==(None,True)
    assert choose_account('HK','original-label',None,override='source-a',**facts)==('source-a',False)
    assert facts['markets']['HK']=='source-b'
    assert choose_account('XX','unknown',None,**facts)==(None,False)
    assert choose_account('XX','Exact original name',None,**facts)==('source-a',False)
    assert choose_account('XX','unknown',None,override='other-owner-account',**facts)==(None,True)
