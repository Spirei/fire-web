"""Reproduce the real immutable-migration failure using synthetic data only."""

import hashlib
import shutil
from uuid import uuid4

import psycopg
import pytest
from alcor_api.config import ROOT, Settings
from alcor_api.db import TargetMismatch
from alcor_api.migrate import migrate
from psycopg import sql

APPLIED_0008 = "f8778ac0a33e8d7994fef9084d75951d7f7319db0e0f91417a021a7c865580ce"


async def test_byte_exact_old_schema_upgrades_without_rewriting_history_or_data(pg, tmp_path):
    name = "alcor_test_upgrade_" + uuid4().hex
    with psycopg.connect(pg.get_uri(), autocommit=True) as c:
        c.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    uri = pg.get_uri(database=name)
    old = tmp_path / "old-migrations"
    old.mkdir()
    for file in sorted((ROOT / "migrations").glob("000[1-8]_*.sql")):
        shutil.copyfile(file, old / file.name)
    assert hashlib.sha256((old / "0008_native_identity.sql").read_bytes()).hexdigest() == APPLIED_0008
    settings = Settings(database_url=uri, instance_id=uuid4(), environment="test", migration_dir=old)
    try:
        await migrate(settings, name, initialize_empty=True)
        with psycopg.connect(uri) as c:
            c.execute(
                "INSERT INTO users(id,username,password_hash,role) VALUES('qa-existing','OldSyntheticUser','SyntheticHashOnly','admin')"
            )
            c.execute(
                "INSERT INTO users(id,username,password_hash,role) VALUES('qa-fallback','OldFallbackUser','SyntheticHashOnly','user')"
            )
            c.execute(
                "INSERT INTO identity_source_profiles(user_id,metadata) VALUES('qa-existing','{\"uid\":\"synthetic-source-uid\"}')"
            )
            c.execute(
                "INSERT INTO sessions(token_hash,user_id,client_id,session_version,expires_at) VALUES('qa-old-session','qa-existing','legacy-web',1,clock_timestamp()+interval '1 day')"
            )
            old_users = c.execute("SELECT * FROM users ORDER BY id")
            user_columns = [column.name for column in old_users.description]
            before = old_users.fetchall()
            old_sessions = c.execute("SELECT * FROM sessions WHERE token_hash='qa-old-session'")
            session_columns = [column.name for column in old_sessions.description]
            session = old_sessions.fetchone()
            assert not {"uid", "deleted_at"} & set(user_columns)
            # Preserve every historical column while allowing additive future columns.
            select_users = sql.SQL("SELECT {} FROM users ORDER BY id").format(
                sql.SQL(",").join(map(sql.Identifier, user_columns))
            )
            select_session = sql.SQL("SELECT {} FROM sessions WHERE token_hash='qa-old-session'").format(
                sql.SQL(",").join(map(sql.Identifier, session_columns))
            )
            history = c.execute(
                "SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name"
            ).fetchall()
        # Reproduce the accidental edit: it must still fail, never bless the new hash.
        bad = old / "0008_native_identity.sql"
        original = bad.read_text()
        bad.write_text(original.replace("'new-web','legacy-web'", "'new-web','legacy-web','legacy-v1'"))
        with pytest.raises(TargetMismatch, match="0008_native_identity.sql"):
            await migrate(settings, name)
        with psycopg.connect(uri) as c:
            assert (
                c.execute("SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name").fetchall()
                == history
            )
            assert c.execute(select_users).fetchall() == before
        settings.migration_dir = ROOT / "migrations"
        await migrate(settings, name)
        await migrate(settings, name)
        with psycopg.connect(uri) as c:
            assert c.execute(select_users).fetchall() == before
            assert c.execute(select_session).fetchone() == session
            assert c.execute("SELECT id,uid,deleted_at FROM users ORDER BY id").fetchall() == [
                ("qa-existing", "1", None),
                ("qa-fallback", "2", None),
            ]
            assert (
                c.execute(
                    "SELECT metadata->>'uid' FROM identity_source_profiles WHERE user_id='qa-existing'"
                ).fetchone()[0]
                == "synthetic-source-uid"
            )
            assert (
                c.execute(
                    "SELECT name,sha256,applied_at FROM schema_migrations WHERE name<'0009' ORDER BY name"
                ).fetchall()
                == history
            )
            assert (
                c.execute(
                    "SELECT count(*) FROM schema_migrations WHERE name='0009_legacy_v1_session.sql'"
                ).fetchone()[0]
                == 1
            )
            c.execute(
                "INSERT INTO sessions(token_hash,user_id,client_id,session_version,expires_at) VALUES('qa-v1-session','qa-existing','legacy-v1',1,clock_timestamp()+interval '1 day')"
            )
            assert (
                c.execute(
                    "SELECT count(*) FROM schema_migrations WHERE name='0012_account_closure.sql'"
                ).fetchone()[0]
                == 1
            )
            c.execute(
                "INSERT INTO users(id,username,password_hash,role) VALUES('qa-new','NewSyntheticUser','SyntheticHashOnly','user')"
            )
            assert c.execute("SELECT uid,deleted_at FROM users WHERE id='qa-new'").fetchone() == (
                "3",
                None,
            )
            c.execute("INSERT INTO users(id,uid,username,password_hash,role) VALUES('qa-duplicate','1','DuplicateSyntheticUser','SyntheticHashOnly','user')")
            assert c.execute("SELECT uid FROM users WHERE id='qa-duplicate'").fetchone()[0]=="4"
            with pytest.raises(psycopg.Error), c.transaction():
                c.execute("UPDATE users SET uid='1' WHERE id='qa-duplicate'")
    finally:
        with psycopg.connect(pg.get_uri(), autocommit=True) as c:
            c.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
