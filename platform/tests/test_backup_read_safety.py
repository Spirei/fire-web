from uuid import uuid4

import pytest
import test_backups as old

configured = old.configured
backup_app = old.backup_app
bc = old.bc


@pytest.mark.parametrize("kind", ["backup.verify", "backup.restore"])
async def test_missing_read_key_never_creates_a_new_key_or_queues_work(bc, backup_app, configured, kind):
    backup_id, _ = await old.create_capsule(bc, backup_app, configured)
    payload = {"kind": kind, "request_id": str(uuid4()), "backup_id": backup_id}
    if kind == "backup.restore":
        preview = await bc.get(
            "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
        )
        assert preview.status_code == 200, preview.text
        payload.update(target_id="isolated-qa", restore_ticket=preview.json()["restore_ticket"])
    async with backup_app.state.db.connection() as conn:
        before = (await (await conn.execute("SELECT count(*) n FROM tasks")).fetchone())["n"]
    configured.backup_secret_dir = configured.backup_secret_dir.parent / "missing-read-key"
    assert not configured.backup_secret_dir.exists()
    response = await bc.post("/api/tasks", json=payload)
    assert response.status_code == 422, response.text
    assert not configured.backup_secret_dir.exists()
    async with backup_app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM tasks")).fetchone())["n"] == before


async def test_restore_preview_does_not_initialize_a_missing_recovery_directory(bc, backup_app, configured):
    backup_id, _ = await old.create_capsule(bc, backup_app, configured)
    directory = configured.restore_targets[0].recovery_directory
    assert not directory.exists()
    response = await bc.get(
        "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert response.status_code == 200, response.text
    assert not directory.exists()


@pytest.mark.parametrize("unsafe", ["unconfigured", "permissions"])
async def test_unsafe_read_key_is_a_clear_rejection_without_mutation(bc, backup_app, configured, unsafe):
    backup_id, _ = await old.create_capsule(bc, backup_app, configured)
    root = configured.backup_secret_dir
    original = (root / "backup.key").read_bytes()
    if unsafe == "unconfigured":
        configured.backup_secret_dir = None
    else:
        root.chmod(0o755)
    try:
        response = await bc.post(
            "/api/tasks", json={"kind": "backup.verify", "request_id": str(uuid4()), "backup_id": backup_id}
        )
        assert response.status_code == 422, response.text
        assert (root / "backup.key").read_bytes() == original
    finally:
        root.chmod(0o700)


async def test_queued_restore_cannot_follow_a_reconfigured_target(bc, backup_app, configured):
    from uuid import UUID
    from alcor_api import backups
    from alcor_api.worker import claim

    backup_id, _ = await old.create_capsule(bc, backup_app, configured)
    preview = await bc.get(
        "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert preview.status_code == 200
    job, _ = await old.submit(
        bc,
        "backup.restore",
        backup_id=backup_id,
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    target = configured.restore_targets[0]
    moved = target.recovery_directory.parent / "changed-after-approval"
    target.recovery_directory = moved
    task = await claim(backup_app.state.db, uuid4())
    assert task["id"] == UUID(job["id"])
    with pytest.raises(backups.BackupFailure, match="预览|目标"):
        await backups.run_job(configured, backup_app.state.db, task)
    assert not moved.exists()


async def test_target_validation_never_creates_a_directory_inside_source_data(configured):
    from alcor_api import backups

    target = configured.restore_targets[0]
    child = configured.file_root / "unsafe-recovery"
    target.recovery_directory = child
    with pytest.raises(backups.BackupFailure, match="隔离"):
        backups.target_for(configured, "isolated-qa")
    assert not child.exists()
