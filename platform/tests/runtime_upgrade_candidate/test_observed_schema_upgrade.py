"""Upgrade the observed 16-name runtime schema, using only synthetic local data."""
from contextlib import asynccontextmanager
import hashlib
from pathlib import Path
import shutil
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
import pytest

from alcor_api.config import ROOT, Settings
from alcor_api.db import Database, TargetMismatch
from alcor_api.migrate import migrate

# Names observed through read-only schema_migrations, no user/financial rows read.
OBSERVED = tuple(f'{i:04d}_{name}.sql' for i,name in enumerate((
 'platform','registration','profiles','connection_drafts','client_authorization','backups',
 'account_management','native_identity','legacy_v1_session','deployments','deployment_configuration','account_closure'),1)) + (
 '0020_numeric_account_uid.sql','0021_account_preferences.sql','0027_profile_personal_media.sql','0076_account_request_activity.sql')


@asynccontextmanager
async def synthetic(pg,tmp_path):
    name='alcor_test_upgrade_'+uuid4().hex
    with psycopg.connect(pg.get_uri(),autocommit=True)as conn:conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    old=tmp_path/'observed-migrations';old.mkdir()
    for filename in OBSERVED:shutil.copyfile(ROOT/'migrations'/filename,old/filename)
    settings=Settings(database_url=pg.get_uri(database=name),instance_id=uuid4(),environment='test',migration_dir=old,redis_url=None,connection_secret_dir=tmp_path/'keys')
    try:
        await migrate(settings,name,initialize_empty=True)
        yield settings,name
    finally:
        with psycopg.connect(pg.get_uri(),autocommit=True)as conn:conn.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(name)))


async def raw(settings):
    return await psycopg.AsyncConnection.connect(settings.database_url.get_secret_value(),row_factory=dict_row)


async def test_observed_16_to_current_complete_reentry_preserves_identity_originals_and_instance(pg,tmp_path):
    async with synthetic(pg,tmp_path)as(old,name):
        async with await raw(old)as conn:
            await conn.execute("INSERT INTO users(id,username,password_hash,role) VALUES('synthetic-old-owner','Synthetic upgrade owner','not-a-real-credential','admin')")
            await conn.execute("INSERT INTO user_profiles(user_id,display_name,avatar,revision,bio) VALUES('synthetic-old-owner','Synthetic preserved name',%s,%s,'Synthetic original biography')",(b'SYNTHETIC-ORIGINAL-AVATAR',uuid4()))
            await conn.execute("INSERT INTO account_request_activity(user_id,day,requests) VALUES('synthetic-old-owner','2026-11-02',17)")
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
            assert len(after_ledger)==len(list((ROOT/'migrations').glob('[0-9]*.sql')))==149
            assert {r['name']:r['sha256'] for r in after_ledger}=={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT/'migrations').glob('[0-9]*.sql')}
            assert await(await conn.execute('SELECT singleton,revision,registered,guest FROM asset_library_access')).fetchall()==[
                {'singleton':True,'revision':0,'registered':True,'guest':True}]
            assert (await(await conn.execute('SELECT count(*) AS n FROM asset_library_access_operations')).fetchone())['n']==0
            assert [r for r in after_ledger if r['name']in OBSERVED]==before_ledger
            user=await(await conn.execute("SELECT * FROM users WHERE id='synthetic-old-owner'")).fetchone()
            profile=await(await conn.execute("SELECT * FROM user_profiles WHERE user_id='synthetic-old-owner'")).fetchone()
            assert all(user[key]==value for key,value in before_user.items())
            assert all(profile[key]==value for key,value in before_profile.items())
            assert await(await conn.execute('SELECT * FROM alcor_instance')).fetchone()==before_marker
            assert (await(await conn.execute('SELECT requests FROM account_request_activity')).fetchone())['requests']==17
        await migrate(current,name)
        db=Database(current);await db.open()
        try:
            async with db.connection()as conn:
                assert await(await conn.execute('SELECT * FROM schema_migrations ORDER BY name')).fetchall()==after_ledger
        finally:await db.close()


async def test_observed_upgrade_bad_sha_and_foreign_identity_fail_atomically_and_old_restore_is_not_assumed(pg,tmp_path):
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
        from alcor_api.backup_stream_storage import validate_schema,StreamFailure
        # The observed sparse history is not a supported contiguous capsule prefix.
        # This is a precondition refusal, never a real backup or restore operation.
        archived={name:hashlib.sha256((ROOT/'migrations'/name).read_bytes()).hexdigest()for name in OBSERVED}
        with pytest.raises(StreamFailure):validate_schema(current,{'schema':archived,'tables':{}})
