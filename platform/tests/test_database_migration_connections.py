"""Migration source edits cannot replace runtime PG or silently reuse a stale source."""
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict


def body(config,revision=None,**extra):
    return {'request_id':str(uuid4()),'expected_revision':revision,'config':config,**extra}


def current(settings):
    fields=conninfo_to_dict(settings.database_url.get_secret_value())
    return {'host':fields['host'],'port':int(fields.get('port',5432)),'database':fields['dbname'],
            'username':fields.get('user','postgres'),'schema_name':'public'}


async def test_editor_is_admin_only_csrf_bound_encrypted_and_versioned(client,admin,db,settings):
    config=current(settings);data=body(config,password_mode='replace',password='SyntheticOnlyPassword9')
    runtime=settings.database_url.get_secret_value()
    denied=await client.put('/api/database-migration/source',json=data,headers={'x-csrf-token':'wrong'})
    assert denied.status_code==403
    response=await client.put('/api/database-migration/source',json=data)
    assert response.status_code==200,response.text
    assert 'SyntheticOnlyPassword9' not in response.text and 'ciphertext' not in response.text
    saved=response.json();source=saved['source'];assert source['password_configured']
    assert (await client.put('/api/database-migration/source',json=data)).json()==saved
    conflict=await client.put('/api/database-migration/source',json=data|{'password':'different'})
    assert conflict.status_code==409
    stale=await client.put('/api/database-migration/source',json=body(config))
    assert stale.status_code==409
    listing=(await client.get('/api/database-migration/connections')).json()
    assert listing['source']==source and listing['target']['managed_by']=='environment'
    assert settings.database_url.get_secret_value()==runtime
    async with db.connection() as conn:
        row=await(await conn.execute('SELECT password_ciphertext FROM database_migration_source')).fetchone()
        assert row['password_ciphertext']!='SyntheticOnlyPassword9'
        assert 'SyntheticOnlyPassword9' not in str(await(await conn.execute('SELECT result FROM database_migration_source_operations')).fetchall())
    # Saved source credentials never alter the live connection test.
    assert (await client.post('/api/database-migration/target/test')).json()['state']=='connected'
    await client.post('/api/session/logout')
    assert (await client.get('/api/database-migration/connections')).status_code==401


async def test_source_test_reads_only_registered_schema_and_rejects_current_database(client,admin,settings,pg):
    config=current(settings)
    same=await client.put('/api/database-migration/source',json=body(config))
    assert same.status_code==200,same.text
    denied=await client.post('/api/database-migration/source/test',json={'revision':same.json()['source']['revision']})
    assert denied.status_code==409
    name='alcor_migration_source_'+uuid4().hex
    with psycopg.connect(pg.get_uri(),autocommit=True) as conn:
        conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    try:
        with psycopg.connect(pg.get_uri(database=name),autocommit=True) as conn:
            conn.execute('CREATE SCHEMA ledger')
            conn.execute('CREATE TABLE ledger.originals(id text PRIMARY KEY,amount numeric)')
            conn.execute("INSERT INTO ledger.originals VALUES('source-original',123.000000000000000001)")
        source=config|{'database':name,'schema_name':'ledger'}
        settings.connection_targets.append({'kind':'postgresql','host':source['host'],'port':source['port'],'database':name})
        saved=await client.put('/api/database-migration/source',json=body(source,same.json()['source']['revision'],password_mode='clear'))
        assert saved.status_code==200,saved.text
        revision=saved.json()['source']['revision']
        result=await client.post('/api/database-migration/source/test',json={'revision':revision})
        assert result.status_code==200,result.text
        assert result.json()['read_only'] and result.json()['table_count']==1 and result.json()['schema']=='ledger'
        assert result.json()['response_ms']>=0
        with psycopg.connect(pg.get_uri(database=name)) as conn:
            assert conn.execute('SELECT amount::text FROM ledger.originals').fetchone()[0]=='123.000000000000000001'
            assert conn.execute("SELECT count(*) FROM pg_tables WHERE schemaname='ledger'").fetchone()[0]==1
        changed=await client.put('/api/database-migration/source',json=body(source|{'schema_name':'missing'},revision))
        assert changed.status_code==200
        assert (await client.post('/api/database-migration/source/test',json={'revision':revision})).status_code==409
        failed=await client.post('/api/database-migration/source/test',json={'revision':changed.json()['source']['revision']})
        assert failed.status_code==422 and 'Schema' in failed.text
    finally:
        async with await psycopg.AsyncConnection.connect(pg.get_uri(),autocommit=True) as conn:
            await conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))


async def test_changed_endpoint_cannot_inherit_another_password(client,admin,settings):
    config=current(settings)
    old=await client.put('/api/database-migration/source',json=body(config,password_mode='replace',password='Synthetic9'))
    changed=await client.put('/api/database-migration/source',json=body(config|{'database':'different'},old.json()['source']['revision']))
    assert changed.status_code==422
    for schema in ('pg_catalog','information_schema','bad;SELECT 1','a.b'):
        invalid=await client.put('/api/database-migration/source',json=body(config|{'schema_name':schema},old.json()['source']['revision']))
        assert invalid.status_code==422


async def test_stale_admin_requires_verification_before_save_or_probe(client,admin,db,settings,app,monkeypatch):
    config=current(settings)
    old=await client.put('/api/database-migration/source',json=body(config))
    assert old.status_code==200
    called=[]
    async def probe(*args):called.append(True);raise AssertionError('Unverified network access')
    monkeypatch.setattr(app.state.database_migration_connections,'probe',probe)
    async with db.connection() as conn:
        await conn.execute("UPDATE sessions SET created_at=clock_timestamp()-interval '1 hour'")
    for path,payload in [('/api/database-migration/source',body(config,old.json()['source']['revision'])),
                         ('/api/database-migration/source/test',{'revision':old.json()['source']['revision']})]:
        result=await (client.put(path,json=payload) if path.endswith('/source') else client.post(path,json=payload))
        assert result.status_code==403 and result.headers.get('X-Alcor-Reauthentication')=='required'
    assert called==[]


async def test_cancelled_unknown_save_cannot_arrive_late_or_undo_completed_save(client,admin,settings):
    config=current(settings)
    pending=body(config)
    path='/api/database-migration/source/operations/'+pending['request_id']
    cancelled=await client.post(path+'/cancel')
    assert cancelled.status_code==200 and cancelled.json()['state']=='cancelled'
    assert (await client.put('/api/database-migration/source',json=pending)).status_code==409
    assert (await client.get('/api/database-migration/connections')).json()['source'] is None
    assert (await client.get(path)).json()==cancelled.json()
    completed=body(config)
    saved=await client.put('/api/database-migration/source',json=completed)
    late_cancel=await client.post('/api/database-migration/source/operations/'+completed['request_id']+'/cancel')
    assert late_cancel.json()==saved.json()
    assert (await client.get('/api/database-migration/connections')).json()['source']['revision']==saved.json()['source']['revision']


async def test_migration_connections_and_cancellation_require_administrator(client,admin,settings):
    from alcor_api.cli import create_user
    from test_fire_web import fire_login
    client.cookies.clear()
    for prefix in ('/api/database-migration','/api/fire/database-migration'):
        assert (await client.get(prefix+'/connections')).status_code==401
    await create_user(settings,'ReaderOne','Synthetic9Read',role='user')
    login=await client.post('/api/session/login',json={'login':'ReaderOne','password':'Synthetic9Read'})
    client.headers['x-csrf-token']=login.json()['csrf']
    assert (await client.get('/api/database-migration/connections')).status_code==403
    assert (await client.post('/api/database-migration/preparations/cancel',json={'request_id':str(uuid4())})).status_code==403
    await fire_login(client,'ReaderOne','Synthetic9Read')
    assert (await client.get('/api/fire/database-migration/connections')).status_code==403
    assert (await client.post('/api/fire/database-migration/preparations/cancel',json={'request_id':str(uuid4())})).status_code==403
