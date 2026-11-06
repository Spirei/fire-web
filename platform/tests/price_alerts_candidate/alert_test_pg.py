"""Candidate-only private PG WAL bounds with asynchronous reload acknowledgement."""

import shutil
import time
from pathlib import Path

import psycopg
import pytest


def owned(pg):
    conn = psycopg.connect(pg.get_uri(), autocommit=True)
    directory = Path(conn.execute("SHOW data_directory").fetchone()[0]).resolve()
    assert directory == pg.pgdata.resolve() and directory.name.startswith("alcor-test-")
    assert conn.execute("SHOW listen_addresses").fetchone()[0] == ""
    return conn


@pytest.fixture(scope="session", autouse=True)
def alert_wal_bound(pg):
    with owned(pg) as conn:
        conn.execute("ALTER SYSTEM SET max_wal_size='64MB'")
        conn.execute("ALTER SYSTEM SET min_wal_size='32MB'")
        conn.execute("ALTER SYSTEM SET checkpoint_timeout='30s'")
        assert conn.execute("SELECT pg_reload_conf()").fetchone()[0]
    for _ in range(100):
        with owned(pg) as conn:
            if conn.execute("SHOW max_wal_size").fetchone()[0] == "64MB":
                conn.execute("CHECKPOINT")
                break
        time.sleep(0.01)
    else:
        raise AssertionError("Private PG did not acknowledge WAL bounds")
    yield


@pytest.fixture(autouse=True)
def alert_checkpoint(pg, alert_wal_bound):
    assert shutil.disk_usage(pg.pgdata).free >= 512 * 1024**2
    yield
    with owned(pg) as conn:
        conn.execute("CHECKPOINT")
