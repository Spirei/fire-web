from source_window_fixture import active_window
import shutil
import tempfile
from pathlib import Path
from uuid import uuid4

import pgserver
import psycopg
import pytest
import pytest_asyncio
from psycopg import sql
from psycopg.rows import dict_row

from alcor_api.source_snapshot import PgSnapshot,SourceDefinition,schema_digest
from .synthetic_legacy import OWNER,seed_pg


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
        for table in __import__('alcor_api.source_snapshot',fromlist=['TABLES']).TABLES:await conn.execute(sql.SQL('GRANT SELECT ON {} TO {}').format(sql.Identifier(table),sql.Identifier(role)))
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


@pytest_asyncio.fixture
async def settings(pg,tmp_path,old_pg):
    import json
    from alcor_api.config import ROOT,Settings
    from alcor_api.migrate import migrate
    name='alcor_test_authority_'+uuid4().hex
    with psycopg.connect(pg.get_uri(),autocommit=True) as conn:conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    settings=Settings(database_url=pg.get_uri(database=name),instance_id=uuid4(),environment='local',public_origin='http://testserver',redis_url=None,connection_targets=[],connection_secret_dir=tmp_path/'secrets',backup_dir=None,backup_secret_dir=None,file_root=None,restore_targets=[])
    assert settings.migration_dir.resolve()==(ROOT/'migrations').resolve()
    await migrate(settings,name,initialize_empty=True)
    directory=tmp_path/'source-registry';directory.mkdir(mode=0o700)
    file=directory/'sources.json'
    definition=old_pg
    file.write_text(json.dumps({'version':2,'platformInstance':str(settings.instance_id),'sources':[{'alias':definition.alias,'instance':definition.instance,'kind':definition.kind,'owners':list(definition.owners),'timezone':definition.timezone,'schemaHash':definition.expected_schema_hash,'locator':definition.locator,'expectedDatabase':definition.expected_database,'expectedDataDirectory':str(definition.expected_data_directory),'expectedRole':definition.expected_role,'expectedFileIdentity':None,'expectedDatasetIdentity':definition.expected_dataset_identity, "migrationWindow": active_window().document()}]}))
    file.chmod(0o600);settings.legacy_source_registry_path=file
    yield settings
    with psycopg.connect(pg.get_uri(),autocommit=True) as conn:conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))


@pytest_asyncio.fixture
async def app(settings,old_pg):
    from alcor_api.main import create_app
    app=create_app(settings)
    async with app.router.lifespan_context(app):yield app


@pytest_asyncio.fixture
async def client(app):
    import httpx
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app,raise_app_exceptions=False),base_url='http://testserver',headers={'origin':'http://testserver'}) as client:yield client


@pytest_asyncio.fixture
async def admin(settings,client):
    from alcor_api.cli import create_user
    identifier=await create_user(settings,'SourceAdministrator','Synthetic9Pass')
    response=await client.post('/api/session/login',json={'login':'SourceAdministrator','password':'Synthetic9Pass'});assert response.status_code==200,response.text
    client.headers['x-csrf-token']=response.json()['csrf']
    return identifier
