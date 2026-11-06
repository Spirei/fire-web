"""Read-only configuration tooling against owned, disposable PG databases."""

import importlib.util
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg import sql


@pytest.fixture
def fire_tools():
    spec = importlib.util.spec_from_file_location(
        "fire_platform_tools", Path(__file__).parents[2] / "scripts/platform.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_inspection_reads_existing_identity_without_minting_a_new_one(
    settings, monkeypatch, fire_tools
):
    monkeypatch.setenv("FIRE_DATABASE_URL", settings.database_url.get_secret_value())
    monkeypatch.delenv("FIRE_INSTANCE_ID", raising=False)
    result = await fire_tools.inspect_database()
    assert result["state"] == "marked" and result["instance_id"] == str(settings.instance_id)
    assert not result["configured_identity_matches"] and not result["wrote_database"]
    monkeypatch.setenv("FIRE_INSTANCE_ID", str(settings.instance_id))
    monkeypatch.setenv("FIRE_ENVIRONMENT", settings.environment)
    assert (await fire_tools.inspect_database())["configured_identity_matches"]
    monkeypatch.setenv("FIRE_ENVIRONMENT", "production")
    assert not (await fire_tools.inspect_database())["configured_identity_matches"]


async def test_empty_and_unmarked_old_databases_are_inspected_without_initialization(
    pg, monkeypatch, fire_tools
):
    name = "alcor_test_" + uuid4().hex
    with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    try:
        uri = pg.get_uri(database=name)
        monkeypatch.setenv("FIRE_DATABASE_URL", uri)
        assert (await fire_tools.inspect_database()) == {
            "state": "empty_requires_explicit_initialization",
            "wrote_database": False,
        }
        with psycopg.connect(uri) as conn:
            assert conn.execute("SELECT to_regclass('public.alcor_instance')").fetchone()[0] is None
            conn.execute("CREATE TABLE legacy_evidence(id int PRIMARY KEY, body text)")
            conn.execute("INSERT INTO legacy_evidence VALUES(1,'Synthetic immutable evidence')")
        assert (await fire_tools.inspect_database()) == {
            "state": "unmarked_nonempty",
            "wrote_database": False,
        }
        with psycopg.connect(uri) as conn:
            assert conn.execute("SELECT * FROM legacy_evidence").fetchall() == [
                (1, "Synthetic immutable evidence")
            ]
            assert conn.execute("SELECT to_regclass('public.alcor_instance')").fetchone()[0] is None
    finally:
        with psycopg.connect(pg.get_uri(), autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
