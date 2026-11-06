"""Provider secrets must match the same PG snapshot as their backup dump."""

from uuid import uuid4

import pytest
from alcor_api.backups import BackupFailure, capture_provider_key
from alcor_api.fx_custom import decrypt_existing, existing_key, kind, vault
from alcor_api.fx_reference import FxWorker
from fastapi import HTTPException


async def sealed(db):
    identifier = uuid4()
    cipher = vault(db).encrypt(
        '{"url":"https://provider.example/rates"}', kind(identifier), db.settings.instance_id
    )
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO fx_provider_revisions(id,config,secret_cipher,credential_instance) VALUES(%s,'{}',%s,%s)",
            (identifier, cipher, db.settings.instance_id),
        )
    return identifier


@pytest.mark.asyncio
async def test_snapshot_capture_excludes_later_first_configuration(db):
    async with db.connection() as snapshot, snapshot.transaction():
        await snapshot.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        await snapshot.execute("SELECT pg_export_snapshot()")
        identifier = await sealed(db)
        entries = {}
        await capture_provider_key(snapshot, db.settings, entries)
        assert entries == {}
    async with db.connection() as snapshot:
        await capture_provider_key(snapshot, db.settings, entries)
        row = await (
            await snapshot.execute("SELECT * FROM fx_provider_revisions WHERE id=%s", (identifier,))
        ).fetchone()
    assert decrypt_existing(entries["secrets/fx-providers.key"], row).startswith('{"url"')


@pytest.mark.asyncio
@pytest.mark.parametrize("damage", ["missing", "wrong"])
async def test_sealed_snapshot_fails_with_missing_or_wrong_key_never_recreates(db, damage):
    await sealed(db)
    path = db.settings.connection_secret_dir / "fx-providers" / "connections.key"
    path.unlink()
    if damage == "wrong":
        vault(db).key()
    before = path.read_bytes() if path.exists() else None
    entries = {}
    async with db.connection() as snapshot:
        with pytest.raises(BackupFailure):
            await capture_provider_key(snapshot, db.settings, entries)
    assert entries == {}
    assert (path.read_bytes() if path.exists() else None) == before
    if damage == "missing":
        with pytest.raises(HTTPException):
            existing_key(db.settings)
        assert not path.exists()


@pytest.mark.asyncio
async def test_missing_key_fails_only_task_without_network_or_key_creation(db):
    identifier = await sealed(db)
    path = db.settings.connection_secret_dir / "fx-providers" / "connections.key"
    path.unlink()
    task_id = uuid4()
    async with db.connection() as conn:
        await conn.execute("UPDATE fx_config SET enabled=true")
        await conn.execute(
            "INSERT INTO fx_refresh_tasks(id,provider,state,provider_revision) VALUES(%s,'custom','queued',%s)",
            (task_id, identifier),
        )
    worker = FxWorker(db, enabled=True)
    assert await worker.once() == "failed"
    assert not path.exists()
    async with db.connection() as conn:
        row = await (
            await conn.execute("SELECT state,error_code FROM fx_refresh_tasks WHERE id=%s", (task_id,))
        ).fetchone()
    assert row == {"state": "failed", "error_code": "provider_unavailable"}


import test_backups as backup_tests

backup_app = backup_tests.backup_app
bc = backup_tests.bc
configured = backup_tests.configured


@pytest.mark.asyncio
async def test_full_backup_never_publishes_missing_provider_key(bc, backup_app, configured):
    db = backup_app.state.db
    await sealed(db)
    path = db.settings.connection_secret_dir / "fx-providers" / "connections.key"
    path.unlink()
    with pytest.raises(BackupFailure):
        await backup_tests.create_capsule(bc, backup_app, configured)
    assert not path.exists()
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM backups")).fetchone())["n"] == 0
    assert not list(configured.backup_dir.glob("*.enc"))


@pytest.mark.asyncio
@pytest.mark.parametrize("mismatch", ["kind", "instance"])
async def test_snapshot_checks_each_cipher_binding(db, mismatch):
    await sealed(db)
    identifier = uuid4()
    cipher = vault(db).encrypt(
        "synthetic",
        kind(uuid4()) if mismatch == "kind" else kind(identifier),
        uuid4() if mismatch == "instance" else db.settings.instance_id,
    )
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO fx_provider_revisions(id,config,secret_cipher,credential_instance) VALUES(%s,'{}',%s,%s)",
            (identifier, cipher, db.settings.instance_id),
        )
        with pytest.raises(BackupFailure):
            await capture_provider_key(conn, db.settings, {})


@pytest.mark.asyncio
async def test_database_failure_preserves_running_for_recovery(db, monkeypatch):
    import psycopg
    import alcor_api.fx_custom as custom_module

    identifier = await sealed(db)
    task_id = uuid4()
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO fx_refresh_tasks(id,provider,state,provider_revision) VALUES(%s,'custom','queued',%s)",
            (task_id, identifier),
        )

    async def unavailable(*args, **kwargs):
        raise psycopg.OperationalError("isolated injected DB interruption")

    monkeypatch.setattr(custom_module, "read", unavailable)
    with pytest.raises(psycopg.OperationalError):
        await FxWorker(db, enabled=True).once()
    async with db.connection() as conn:
        row = await (
            await conn.execute("SELECT state,error_code FROM fx_refresh_tasks WHERE id=%s", (task_id,))
        ).fetchone()
    assert row == {"state": "running", "error_code": None}
