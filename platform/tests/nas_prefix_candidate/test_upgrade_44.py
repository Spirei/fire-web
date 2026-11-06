"""Release44 eleven-SQL prefix upgrade; synthetic PG, never NAS acceptance."""
import hashlib
import shutil
from contextlib import asynccontextmanager
from uuid import uuid4

import psycopg
import pytest
from alcor_api.config import ROOT, Settings
from alcor_api.db import Database, TargetMismatch
from alcor_api.migrate import migrate
from psycopg import sql
from psycopg.rows import dict_row

# Byte-exact local object 2537d61a3c19aaa6f12336cd92f2068e6bd2338d.
# Compared read-only before this fixture was frozen; no live NAS reads.
OLD = {'0001_platform.sql': '02b490af45242d2d1dea3e5537f2aa6584c83a79c38cb923662dd502d7706751', '0002_registration.sql': 'b01a1eaa37b386b701ab04fd35310ea953222c62cef3607e6c17bf0e0add9d98', '0003_profiles.sql': '5d59b43e471ea875d398673fd5b4d1605f2b4854996f25937d2417de72729a2f', '0004_connection_drafts.sql': 'd0e468b15e74833c93ff61bb60af0fac92f0b048842d7f29630a91f5394cfd28', '0005_client_authorization.sql': '078e4d3e1d9e1d5fcb31c1f766bff3f86cbd6c5c5c3ca93e57f7fa09bddb6aa7', '0006_backups.sql': 'e0a087609e85256dd5d82fdac40df8b457e05d61c0c17ded6348b14bcb24043c', '0007_account_management.sql': '9d52b053c8c806289d23c1b9e3c77e1e27e0ac3a5d1f72454e9fbf0b123afa1d', '0008_native_identity.sql': 'f8778ac0a33e8d7994fef9084d75951d7f7319db0e0f91417a021a7c865580ce', '0009_legacy_v1_session.sql': '7fbd025e1ddaf623528562d13d6eafd52b0d16d5c58d37cf9ee0a97dd4196a1f', '0010_deployments.sql': 'ba5e419da87eed6e1b60415a74ce45735e1f6eb6871e935b60d3ae078485adb7', '0011_deployment_configuration.sql': '2671d2f421699f1f79891fbe83ea8a1f4abcd9669c1c77567fa369528e133c38'}
OBSERVED = tuple(OLD)



@asynccontextmanager
async def synthetic(pg,tmp_path):
    name='alcor_test_upgrade_'+uuid4().hex
    with psycopg.connect(pg.get_uri(),autocommit=True)as conn:conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    old=tmp_path/'observed-migrations';old.mkdir()
    for filename in OBSERVED:
        assert hashlib.sha256((ROOT/'migrations'/filename).read_bytes()).hexdigest()==OLD[filename]
        shutil.copyfile(ROOT/'migrations'/filename,old/filename)
    settings=Settings(database_url=pg.get_uri(database=name),instance_id=uuid4(),environment='test',migration_dir=old,redis_url=None,connection_secret_dir=tmp_path/'keys')
    try:
        await migrate(settings,name,initialize_empty=True)
        yield settings,name
    finally:
        with psycopg.connect(pg.get_uri(),autocommit=True)as conn:conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))


async def raw(settings):
    return await psycopg.AsyncConnection.connect(settings.database_url.get_secret_value(),row_factory=dict_row)


async def test_release44_eleven_to_current_preserves_originals_and_reentry(pg,tmp_path):
    async with synthetic(pg,tmp_path)as(old,name):
        async with await raw(old)as conn:
            await conn.execute("INSERT INTO users(id,username,password_hash,role) VALUES('synthetic-old-owner','Synthetic upgrade owner','not-a-real-credential','admin')")
            await conn.execute("INSERT INTO user_profiles(user_id,display_name,avatar,revision) VALUES('synthetic-old-owner','Synthetic preserved name',%s,%s)",(b'SYNTHETIC-ORIGINAL-AVATAR',uuid4()))
            await conn.execute("INSERT INTO users(id,username,password_hash,role,active) VALUES('synthetic-inactive','Synthetic inactive','not-a-real-credential','user',false)")
            await conn.execute("INSERT INTO identity_source_profiles(user_id,metadata) VALUES('synthetic-old-owner',%s::jsonb)", ('{"amount":123456789012345678901234.123456789,"tiny":1e-100,"currency":null,"unknown":[null,{"future":true}]}',))
            metadata_before=await(await conn.execute('SELECT metadata::text FROM identity_source_profiles')).fetchall()
            users_before=await(await conn.execute('SELECT id,role,active,password_hash FROM users ORDER BY id')).fetchall()
            before_user=await(await conn.execute("SELECT * FROM users WHERE id='synthetic-old-owner'")).fetchone()
            before_profile=await(await conn.execute("SELECT * FROM user_profiles WHERE user_id='synthetic-old-owner'")).fetchone()
            before_ledger=await(await conn.execute('SELECT * FROM schema_migrations ORDER BY name')).fetchall()
            before_marker=await(await conn.execute('SELECT * FROM alcor_instance')).fetchone()
        current=old.model_copy(update={'migration_dir':ROOT/'migrations'})
        # An unmigrated target is rejected, not silently initialized by reads.
        db=Database(current);await db.open()
        try:
            with pytest.raises(TargetMismatch):
                async with db.connection():pass
        finally:await db.close()
        await migrate(current,name)
        async with await raw(current)as conn:
            after_ledger=await(await conn.execute('SELECT * FROM schema_migrations ORDER BY name')).fetchall()
            assert len(after_ledger)==len(list((ROOT/'migrations').glob('[0-9]*.sql')))
            assert await(await conn.execute('SELECT singleton,revision,registered,guest FROM asset_library_access')).fetchall()==[
                {'singleton':True,'revision':0,'registered':True,'guest':True}]
            assert (await(await conn.execute('SELECT count(*) AS n FROM asset_library_access_operations')).fetchone())['n']==0
            assert [r for r in after_ledger if r['name']in OBSERVED]==before_ledger
            user=await(await conn.execute("SELECT * FROM users WHERE id='synthetic-old-owner'")).fetchone()
            profile=await(await conn.execute("SELECT * FROM user_profiles WHERE user_id='synthetic-old-owner'")).fetchone()
            assert all(user[key]==value for key,value in before_user.items())
            assert all(profile[key]==value for key,value in before_profile.items())
            assert await(await conn.execute('SELECT * FROM alcor_instance')).fetchone()==before_marker
            assert await(await conn.execute('SELECT metadata::text FROM identity_source_profiles')).fetchall()==metadata_before
            assert await(await conn.execute('SELECT id,role,active,password_hash FROM users ORDER BY id')).fetchall()==users_before
            for table in ('portfolio_records','trade_ledger','cash_ledger_entries','internal_orders'):
                assert (await(await conn.execute(sql.SQL('SELECT count(*) AS n FROM {}').format(sql.Identifier(table)))).fetchone())['n']==0
            assert {r['name']:r['sha256'] for r in after_ledger}=={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'migrations').glob('[0-9]*.sql')}
            await conn.execute('UPDATE asset_library_access SET revision=7,guest=false WHERE singleton')
        await migrate(current,name)
        db=Database(current);await db.open()
        try:
            async with db.connection()as conn:
                assert await(await conn.execute('SELECT * FROM schema_migrations ORDER BY name')).fetchall()==after_ledger
                assert await(await conn.execute('SELECT revision,registered,guest FROM asset_library_access')).fetchone()=={
                    'revision':7,'registered':True,'guest':False}
        finally:await db.close()


async def test_release44_bad_sha_and_foreign_identity_fail_atomically_and_capsule_prefix_is_supported(pg,tmp_path):
    async with synthetic(pg,tmp_path)as(old,name):
        current=old.model_copy(update={'migration_dir':ROOT/'migrations'})
        async with await raw(old)as conn:
            await conn.execute("UPDATE schema_migrations SET sha256=%s WHERE name='0001_platform.sql'",('0'*64,))
            bad=await(await conn.execute('SELECT * FROM schema_migrations ORDER BY name')).fetchall()
        with pytest.raises(TargetMismatch):await migrate(current,name)
        async with await raw(old)as conn:
            assert await(await conn.execute('SELECT * FROM schema_migrations ORDER BY name')).fetchall()==bad
            assert (await(await conn.execute("SELECT to_regclass('public.portfolio_records') AS present")).fetchone())['present']is None
            await conn.execute("UPDATE schema_migrations SET sha256=%s WHERE name='0001_platform.sql'",(hashlib.sha256((ROOT/'migrations/0001_platform.sql').read_bytes()).hexdigest(),))
        with pytest.raises(TargetMismatch):await migrate(current.model_copy(update={'instance_id':uuid4()}),name)
        from alcor_api.backup_stream_storage import StreamFailure, validate_schema
        # Actual release44 is a supported contiguous capsule schema prefix.
        # Pure validator only, not a real capsule/secret or restore.
        archived={name:hashlib.sha256((ROOT/'migrations'/name).read_bytes()).hexdigest()for name in OBSERVED}
        validate_schema(current,{'schema':archived,'tables':{}})
        for bad in ({**archived,'0001_platform.sql':'0'*64},{k:v for k,v in archived.items() if k!='0005_client_authorization.sql'}):
            with pytest.raises(StreamFailure):validate_schema(current,{'schema':bad,'tables':{}})
