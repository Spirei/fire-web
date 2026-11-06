"""Upgrade the parallel 0.1.52 schema without replaying identities or preferences."""

import shutil
from uuid import uuid4

import psycopg
from alcor_api.config import ROOT, Settings
from alcor_api.migrate import migrate
from psycopg import sql


async def test_parallel_052_upgrade_preserves_identity_preferences_and_history(pg, tmp_path):
    name = "alcor_test_upgrade52_" + uuid4().hex
    with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    old = tmp_path / "schema52"
    old.mkdir()
    for path in (ROOT / "migrations").glob("*.sql"):
        if int(path.name[:4]) <= 12 or int(path.name[:4]) in {20, 21}:
            shutil.copyfile(path, old / path.name)
    settings = Settings(
        database_url=pg.get_uri(database=name), instance_id=uuid4(), environment="test", migration_dir=old
    )
    try:
        await migrate(settings, name, initialize_empty=True)
        with psycopg.connect(pg.get_uri(database=name)) as conn:
            conn.execute(
                "INSERT INTO users(id,username,password_hash,role) VALUES('synthetic-upgrade','SyntheticUpgrade','SyntheticHash','admin')"
            )
            conn.execute(
                "INSERT INTO account_preferences(user_id,appearance,avatar_status) VALUES('synthetic-upgrade','{\"mode\":\"dark\"}','focus')"
            )
            user = conn.execute("SELECT * FROM users").fetchall()
            prefs = conn.execute("SELECT * FROM account_preferences").fetchall()
            history = conn.execute("SELECT * FROM schema_migrations ORDER BY name").fetchall()
        settings.migration_dir = ROOT / "migrations"
        await migrate(settings, name)
        await migrate(settings, name)
        with psycopg.connect(pg.get_uri(database=name)) as conn:
            assert conn.execute("SELECT * FROM users").fetchall() == user
            assert conn.execute("SELECT * FROM account_preferences").fetchall() == prefs
            assert (
                conn.execute(
                    "SELECT * FROM schema_migrations WHERE name=ANY(%s) ORDER BY name",
                    ([row[0] for row in history],),
                ).fetchall()
                == history
            )
            for table in ["portfolio_records", "cash_ledger_entries", "trade_ledger", "identity_mail_outbox"]:
                # New domain tables start empty: upgrading never synthesizes financial history.
                exists = conn.execute("SELECT to_regclass(%s)", (table,)).fetchone()[0]
                assert exists is not None
                assert (
                    conn.execute(sql.SQL("SELECT count(*) FROM {}").format(sql.Identifier(table))).fetchone()[
                        0
                    ]
                    == 0
                )
    finally:
        with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
