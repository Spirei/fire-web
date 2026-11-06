import asyncio
import os
import tempfile
import shutil
from pathlib import Path
from uuid import uuid4

import httpx
import pgserver
import psycopg
import pytest
import pytest_asyncio
from psycopg import sql

from alcor_api.cli import create_user
from alcor_api.config import ROOT, Settings
from alcor_api.db import Database
from alcor_api.main import create_app
from alcor_api.migrate import migrate


@pytest.fixture(scope="session")
def pg():
    parent = Path(os.environ.get("ALCOR_TEST_ROOT", ROOT / ".local/test-runs"))
    parent.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix="alcor-test-", dir=parent))
    directory.chmod(0o700)
    server = pgserver.get_server(directory, cleanup_mode="stop")
    with psycopg.connect(server.get_uri()) as conn:
        assert Path(conn.execute("SHOW data_directory").fetchone()[0]).resolve() == directory.resolve()
        assert conn.execute("SHOW listen_addresses").fetchone()[0] == ""
    yield server
    server.cleanup()
    assert not server.get_postmaster_info().process.is_running()
    # Finder can recreate .DS_Store during removal; housekeeping must not mask database checks.
    shutil.rmtree(directory, ignore_errors=True)


@pytest_asyncio.fixture
async def settings(pg, tmp_path):
    name = "alcor_test_" + uuid4().hex
    with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    settings = Settings(
        database_url=pg.get_uri(database=name),
        redis_url=None,
        connection_targets=[],
        backup_dir=None,
        backup_secret_dir=None,
        file_root=None,
        pg_tools_dir=None,
        restore_targets=[],
        instance_id=uuid4(),
        environment="test",
        public_origin="http://testserver",
        connection_secret_dir=tmp_path / "connection-secrets",
    )
    await migrate(settings, name, initialize_empty=True)
    yield settings
    with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
        assert name.startswith("alcor_test_")
        conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


@pytest_asyncio.fixture
async def db(settings):
    db = Database(settings)
    await db.open()
    yield db
    await db.close()


@pytest_asyncio.fixture
async def app(settings):
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        yield app


@pytest_asyncio.fixture
async def client(app):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as client:
        yield client


@pytest_asyncio.fixture
async def admin(settings, client):
    user_id = await create_user(settings, "AdminOne", "Synthetic9Pass", email="admin@example.invalid")
    result = await client.post(
        "/api/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"}
    )
    assert result.status_code == 200, result.text
    client.headers["x-csrf-token"] = result.json()["csrf"]
    return user_id


@pytest.fixture
def fx_target_policy(settings):
    settings.fx_provider_targets = [
        {"target": ["http", "provider.example", 80, "/rates"], "addresses": ["192.0.2.20"], "allow_plaintext": True},
        {"target": ["https", "provider.example", 443, "/rates"], "addresses": ["192.0.2.20"]},
    ]
