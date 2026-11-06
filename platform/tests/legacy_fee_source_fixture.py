"""Real registry/grant/read-only export over synthetic old tables only.

No manifest/raw/complete/authority insertion or runtime authority monkey patch.
The target's test-only legacy placeholder represents an existing old canonical
row. It is never described as a successful new financial import.
"""
from source_window_fixture import active_window
import json
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import httpx
import psycopg
from psycopg import sql
from alcor_api.main import create_app
from alcor_api.security import COOKIE,digest
from alcor_api.source_snapshot import TABLES


async def operation(client,path,data):
    response=await client.post(path+'/preview',json=data);assert response.status_code==200,response.text
    response=await client.post(path+'/operations',json={'data':data,'preview':response.json()['preview']});assert response.status_code==200,response.text
    return response.json()


async def target_placeholder(client,db,pg,*,legacy=True,opening_at="2026-01-01T00:00:00Z",occurred_at="2026-09-01T12:00:00Z"):
    async with db.connection() as conn:
        actual=Path((await(await conn.execute('SHOW data_directory')).fetchone())['data_directory']).resolve()
        database=(await(await conn.execute('SELECT current_database() name')).fetchone())['name']
    async with await psycopg.AsyncConnection.connect(pg.get_uri()) as conn:
        expected=Path((await(await conn.execute('SHOW data_directory')).fetchone())[0]).resolve()
        assert (await(await conn.execute('SHOW listen_addresses')).fetchone())[0]==''
    assert actual==expected and database.startswith('alcor_test_')
    response=await client.post('/api/broker-accounts',json={'request_id':str(uuid4()),'name':'Synthetic fee baseline account','provider_id':'longbridge','account_kind':'real','currency':'USD','currencies':['USD']});assert response.status_code==201,response.text
    account=response.json()['data']['id']
    await operation(client,'/api/cash',{'requestId':str(uuid4()),'accountId':account,'accountKind':'real','currency':'USD','action':'opening','amount':'1000','occurredAt':opening_at,'openingBasis':'new_external_opening'})
    response=await client.post('/api/portfolio/records/preview',json={'kind':'create','data':{'name':'Synthetic legacy baseline','code':'TEST','market':'US','qty':'0','cost':'0','price':None,'group':'','note':'','brokerAccountId':account}});assert response.status_code==200,response.text
    response=await client.post('/api/portfolio/records/confirm',json={'previewId':response.json()['previewId'],'requestId':str(uuid4())});assert response.status_code==200,response.text
    record=response.json()['record']
    # Existing test schema representation of an old unresolved canonical row;
    # only the known isolated table default changes, never a source authority.
    async with db.connection() as conn:
        name=(await(await conn.execute('SELECT current_database() value')).fetchone())['value']
        assert name.startswith('alcor_test_')
        if legacy:await conn.execute("ALTER TABLE trade_ledger ALTER COLUMN source SET DEFAULT 'unverified_legacy'")
    try:
        fill=await operation(client,'/api/trading',{'requestId':str(uuid4()),'recordId':record['id'],'recordRevision':record['revision'],'side':'buy','quantity':'10','price':'10','amount':'100','fees':'0','currency':'USD','settlementCurrency':'USD','occurredAt':occurred_at,'confirmedActualFill':True})
    finally:
        async with db.connection() as conn:
            if legacy:await conn.execute("ALTER TABLE trade_ledger ALTER COLUMN source SET DEFAULT 'owner_recorded'")
    return account,fill


async def owner(client,db):
    token=client.cookies[COOKIE]
    async with db.connection() as conn:
        return await(await conn.execute('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=%s',(digest(token),))).fetchone()


async def old_rows_from_target(client,db,trade_id,source_owner,*,registered_fee='0',actual_known=False):
    who=await owner(client,db)
    async with db.connection() as conn:
        row=await(await conn.execute('SELECT * FROM trade_ledger WHERE owner_id=%s AND id=%s',(who['id'],trade_id))).fetchone()
        record=await(await conn.execute('SELECT * FROM portfolio_records WHERE owner_id=%s AND id=%s',(who['id'],row['record_id']))).fetchone()
        account=await(await conn.execute('SELECT * FROM broker_accounts WHERE owner_id=%s AND id=%s',(who['id'],row['account_id']))).fetchone()
        opening=await(await conn.execute("SELECT * FROM cash_ledger_entries WHERE owner_id=%s AND account_id=%s AND kind='opening'",(who['id'],row['account_id']))).fetchone()
    account_id='old-'+account['id'];record_id='old-'+record['id'];order_id='old-'+str(row['id']);fund_id='old-fund-'+str(opening['id'])
    data={table:[] for table in TABLES}
    data['broker_accounts']=[{'id':account_id,'user_id':source_owner,'name':'Synthetic frozen fee source','provider_id':account['provider_id'],'currency':'USD','currencies_json':'["USD"]','account_kind':account['account_kind'],'holding_source':'manual','revision':1,'created_at':opening['occurred_at'].isoformat(),'updated_at':opening['occurred_at'].isoformat()}]
    data['records']=[{'id':record_id,'user_id':source_owner,'name':'Synthetic old fee asset','code':record['code'],'market':record['market'],'account_market':record['account_market'],'qty':str(row['after_quantity']),'cost':None if row['after_cost'] is None else str(row['after_cost']),'source':'','broker_account_id':account_id,'revision':record['revision'],'updated_at':row['occurred_at'].isoformat()}]
    data['record_revisions']=[{'user_id':source_owner,'record_id':record_id,'revision':record['revision']}]
    data['trade_orders']=[{'id':order_id,'user_id':source_owner,'record_id':record_id,'market':record['market'],'code':record['code'],'side':row['side'],'status':'filled','qty':str(row['quantity']),'price':str(row['price']),'amount':str(row['amount']),'fees':registered_fee,'traded_at':row['occurred_at'].isoformat(),'created_at':row['occurred_at'].isoformat(),'position_qty_before':str(row['before_quantity']),'position_cost_before':None if row['before_cost'] is None else str(row['before_cost']),'position_qty_after':str(row['after_quantity']),'position_cost_after':None if row['after_cost'] is None else str(row['after_cost']),'order_type':'limit','tif':'day','session':'regular'}]
    data['app_asset_order_versions']=[{'order_id':order_id,'revision':1}]
    data['broker_cash_order_links']=[{'order_id':order_id,'user_id':source_owner,'account_id':account_id,'currency':'USD'}]
    data['fund_transactions']=[{'id':fund_id,'user_id':source_owner,'currency':'USD','type':'opening','amount':str(opening['amount']),'direction':1,'occurred_at':opening['occurred_at'].isoformat(),'created_at':opening['occurred_at'].isoformat()}]
    data['broker_cash_accounts']=[{'user_id':source_owner,'account_id':account_id,'currency':'USD','revision':1,'opening_amount':str(opening['amount']),'opening_at':opening['occurred_at'].isoformat(),'opening_basis':'new_external_opening'}]
    data['broker_cash_entries']=[{'id':'old-cash-'+str(opening['id']),'user_id':source_owner,'account_id':account_id,'currency':'USD','kind':'opening','amount':str(opening['amount']),'direction':1,'occurred_at':opening['occurred_at'].isoformat(),'created_at':opening['occurred_at'].isoformat(),'operation_id':str(opening['request_id']),'fund_id':fund_id}]
    data['app_asset_operations']=[{'user_id':source_owner,'request_id':str(row['request_id']),'result_json':json.dumps({'kind':'submit_trade','state':'completed','data':{'items':[{'id':order_id}]}})}]
    if actual_known:
        assert row['source']=='owner_recorded' and registered_fee is not None
        data['trade_fee_details']=[{'order_id':order_id,'user_id':source_owner,'input_json':json.dumps({'source':'owner_recorded','confirmed':True,'brokerAccountId':account_id,'providerId':account['provider_id']}),'detail_json':json.dumps({'source':'owner_recorded','currency':'USD','total':registered_fee,'brokerAccountId':account_id,'providerId':account['provider_id']}),'created_at':row['occurred_at'].isoformat()}]
    return data,order_id


@asynccontextmanager
async def registered_source(client,db,pg,definition,tmp_path,data,*,password='Synthetic9Pass',prepare_source=None):
    who=await owner(client,db)
    assert definition.expected_database.startswith('alcor_synthetic_legacy_')
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=definition.expected_database)) as conn:
        directory=Path((await(await conn.execute('SHOW data_directory')).fetchone())[0]).resolve()
        assert directory==definition.expected_data_directory.resolve()
        assert (await(await conn.execute('SELECT current_database()')).fetchone())[0]==definition.expected_database
        for table in TABLES:
            await conn.execute(sql.SQL('DELETE FROM {}').format(sql.Identifier(table)))
            for item in data[table]:
                await conn.execute(sql.SQL('INSERT INTO {} ({}) VALUES ({})').format(sql.Identifier(table),sql.SQL(',').join(map(sql.Identifier,item)),sql.SQL(',').join(sql.Placeholder() for _ in item)),tuple(item.values()))
    if prepare_source is not None:definition=await prepare_source(definition)
    directory=tmp_path/('registered-fee-source-'+uuid4().hex);directory.mkdir(mode=0o700)
    file=directory/'registry.json'
    file.write_text(json.dumps({'version':2,'platformInstance':str(db.settings.instance_id),'sources':[{'alias':definition.alias,'instance':definition.instance,'kind':definition.kind,'owners':list(definition.owners),'timezone':definition.timezone,'schemaHash':definition.expected_schema_hash,'locator':definition.locator,'expectedDatabase':definition.expected_database,'expectedDataDirectory':str(definition.expected_data_directory),'expectedRole':definition.expected_role,'expectedFileIdentity':None,'expectedDatasetIdentity':definition.expected_dataset_identity, "migrationWindow": active_window().document()}]}));file.chmod(0o600)
    settings=db.settings.model_copy(update={'legacy_source_registry_path':file})
    app=create_app(settings)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver',headers=dict(client.headers),cookies=client.cookies) as approved:
            response=await approved.post('/api/legacy-financial/authorizations',json={'requestId':str(uuid4()),'sourceAlias':definition.alias,'sourceOwner':definition.owners[0],'targetUserId':who['id']});assert response.status_code==200,response.text
            grant=response.json()
            response=await approved.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/consent',json={'requestId':str(uuid4()),'revision':grant['grantRevision'],'password':password,'code':'','approve':True});assert response.status_code==200,response.text
            grant=response.json()
            request={'requestId':str(uuid4()),'grantRevision':grant['grantRevision'],'predecessorHash':None}
            response=await approved.post('/api/legacy-financial/authorizations/'+grant['grantId']+'/snapshots',json=request);assert response.status_code==200,response.text
            exported=response.json()
            yield approved,app,grant,exported,request


import pytest_asyncio
from psycopg.rows import dict_row
from alcor_api.source_snapshot import SourceDefinition,PgSnapshot,schema_digest
from legacy_source.synthetic_legacy import OWNER,seed_pg

@pytest_asyncio.fixture
async def old_pg(pg):
    name='alcor_synthetic_legacy_'+uuid4().hex;role='alcor_source_reader_'+uuid4().hex
    async with await psycopg.AsyncConnection.connect(pg.get_uri(),autocommit=True) as conn:
        await conn.execute(sql.SQL('CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION').format(sql.Identifier(role)))
        await conn.execute(sql.SQL('GRANT pg_read_all_settings TO {}').format(sql.Identifier(role)))
        await conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    async with await psycopg.AsyncConnection.connect(pg.get_uri(database=name),autocommit=True,row_factory=dict_row) as conn:
        await seed_pg(conn)
        await conn.execute(sql.SQL('GRANT SELECT(id) ON users TO {}').format(sql.Identifier(role)))
        await conn.execute(sql.SQL('GRANT EXECUTE ON FUNCTION pg_control_system() TO {}').format(sql.Identifier(role)))
        for table in TABLES:await conn.execute(sql.SQL('GRANT SELECT ON {} TO {}').format(sql.Identifier(table),sql.Identifier(role)))
        directory=Path((await(await conn.execute('SHOW data_directory')).fetchone())['data_directory'])
        schema=await PgSnapshot().schema(conn)
        dataset=await(await conn.execute("SELECT system_identifier::text,(SELECT oid::text FROM pg_database WHERE datname=current_database()) database_oid FROM pg_control_system()")).fetchone()
    from psycopg.conninfo import conninfo_to_dict,make_conninfo
    info=conninfo_to_dict(pg.get_uri(database=name));info['user']=role
    definition=SourceDefinition('synthetic-old-pg','frozen-old-instance','postgres',(OWNER,),'America/New_York',schema_digest(schema),make_conninfo(**info),name,directory,role,expected_dataset_identity={'kind':'postgres','systemIdentifier':dataset['system_identifier'],'databaseOid':dataset['database_oid']}, migration_window=active_window())
    yield definition
    async with await psycopg.AsyncConnection.connect(pg.get_uri(),autocommit=True) as conn:
        await conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))
        await conn.execute(sql.SQL('DROP ROLE {}').format(sql.Identifier(role)))
