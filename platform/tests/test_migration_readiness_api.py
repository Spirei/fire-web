"""Isolated PG HTTP tests for admin VPS migration readiness preflight."""

from uuid import uuid4

import pytest

from alcor_api.cli import create_user
from test_legacy_registered_cash import archive, reseal, sealed_book, store_packet
from test_legacy_trade_corrections import native_headers
from test_native_ledger import _create_manual_broker_and_record

READINESS = "/api/personal-data-transfer/migration-readiness"
CHECKPOINT = "/api/personal-data-transfer/ledger-reconcile/checkpoint"


@pytest.mark.asyncio
async def test_migration_readiness_admin_only_and_tracks_checkpoint_sealing(
    client, app, admin, db, tmp_path,
):
    secret_dir = tmp_path / "sec-backup"
    conn_dir = tmp_path / "sec-conn"
    files_dir = tmp_path / "files"
    assets_dir = tmp_path / "assets"
    for d, mode in ((secret_dir, 0o700), (conn_dir, 0o700), (files_dir, 0o700), (assets_dir, 0o700)):
        d.mkdir(mode=mode)
        d.chmod(mode)
    (secret_dir / "backup.key").write_bytes(b"synthetic-key-placeholder")
    (files_dir / "sample.bin").write_bytes(b"1234567890")

    app.state.db.settings.backup_dir = tmp_path
    app.state.db.settings.backup_secret_dir = secret_dir
    app.state.db.settings.connection_secret_dir = conn_dir
    app.state.db.settings.file_root = files_dir
    app.state.db.settings.asset_root = assets_dir
    db.settings.backup_dir = tmp_path

    stored = sealed_book()
    stored["originals"]["funds"][0]["amount"] = "12083.51"
    reseal(stored)
    binding, _ = archive(tmp_path, stored)
    await store_packet(db, admin, stored, binding)
    await _create_manual_broker_and_record(
        client, name="Longbridge", code="GOOGL", qty="18", cost="367.486", price="320",
    )

    # Non-admin user must be denied (403).
    regular = await create_user(
        db.settings, "ReadinessUser", "Readiness9Pass", role="user", email="readiness-user@example.invalid",
    )
    user_headers = {
        **(await native_headers(db, regular, "portfolio.read")),
        "X-Alcor-Expected-Account": regular,
    }
    denied = await client.get(READINESS, headers=user_headers)
    assert denied.status_code == 403

    # Mismatched expected account denied (403).
    wrong = await client.get(READINESS, headers={"X-Alcor-Expected-Account": regular})
    assert wrong.status_code == 403

    # Admin preflight before sealing checkpoint: reports unsealed blocker and no host path/secret leaks.
    admin_headers = {"X-Alcor-Expected-Account": admin}
    before_res = await client.get(READINESS, headers=admin_headers)
    assert before_res.status_code == 200, before_res.text
    raw_text = before_res.text
    assert str(tmp_path) not in raw_text
    assert "synthetic-key-placeholder" not in raw_text

    before = before_res.json()
    assert before["ready"] is False
    assert before["checkpoints"]["totalTargets"] == 1
    assert before["checkpoints"]["sealedTargets"] == 0
    assert before["checkpoints"]["allSealed"] is False
    assert before["checkpoints"]["diskMigrationArchiveNeeded"] is True
    assert before["redis"]["statelessCacheOnly"] is True
    assert before["redis"]["migrationRequired"] is False
    assert before["redis"]["aclKeyPrefix"] == f"alcor:{before['database']['instanceId']}:read-budget:*"
    assert before["database"]["latestMigration"].startswith("0176_")
    dirs = {d["key"]: d for d in before["directories"]}
    assert dirs["backupSecretDir"]["exists"] is True and dirs["backupSecretDir"]["modeOctal"] == "0700"
    assert dirs["backupSecretDir"]["fileCount"] == 1
    assert dirs["fileRoot"]["totalBytes"] == 10

    # Seal checkpoint -> readiness immediately turns ready=True!
    sealed = await client.post(
        CHECKPOINT,
        headers=admin_headers,
        json={"requestId": str(uuid4()), "note": "迁移前固化"},
    )
    assert sealed.status_code == 200, sealed.text

    after = (await client.get(READINESS, headers=admin_headers)).json()
    assert after["ready"] is True
    assert after["blockers"] == []
    assert after["checkpoints"]["allSealed"] is True
    assert after["checkpoints"]["diskMigrationArchiveNeeded"] is False
    assert after["database"]["counts"]["checkpointOwners"] == 1
    assert after["database"]["counts"]["ledgerEvents"] >= 1
