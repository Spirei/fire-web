"""Real v2 pg_dump/pg_restore with 5000 synthetic private originals, no live DB."""

import asyncio
import hashlib
import json
import os
import random
from pathlib import Path
from uuid import UUID, uuid4

import httpx
import pytest
import test_backups as old
from alcor_api import backups
from alcor_api.backup_stream_codec import MAGIC
from alcor_api.backup_stream_storage import LoadedBackup
from alcor_api.main import create_app
from alcor_api.resource_library import file_value
from alcor_api.resource_media import ResourceMedia
from alcor_api.worker import claim, finish
from psycopg.types.json import Jsonb

configured = old.configured
backup_app = old.backup_app
bc = old.bc


async def test_real_5000_files_over_legacy_budget_restore_original_uuid_and_all_hashes(
    bc, backup_app, configured
):
    settings = configured
    db = backup_app.state.db
    settings.backup_stream_max_bytes = 128 * 1024**2
    settings.backup_stream_max_objects = 6000
    settings.backup_stream_disk_reserve_bytes = 16 * 1024**2
    async with db.connection() as conn:
        owner = (await (await conn.execute("SELECT id FROM users WHERE username='BackupQA'")).fetchone())[
            "id"
        ]
    count = 5000
    size = 16384
    media = ResourceMedia(settings)
    sample = []
    hashes = set()
    # Synthetic fixture bypasses HTTP rate budgets, not schema or storage rules:
    # actual fsync media service, composite FKs, quotas, triggers and receipts.
    for start in range(0, count, 100):
        async with db.connection() as conn, conn.transaction():
            for n in range(start, min(count, start + 100)):
                raw = random.Random(n).randbytes(size)
                sha = await media.stage(conn, owner, raw)
                hashes.add(sha)
                identifier = "rlf_" + uuid4().hex
                rid = uuid4()
                row = await (
                    await conn.execute(
                        """INSERT INTO resource_files(id,owner_id,category,name,kind,mime,size_bytes,sha256)
                    VALUES(%s,%s,'components',%s,'other','application/octet-stream',%s,%s) RETURNING *""",
                        (identifier, owner, f"synthetic-{n}.dat", size, sha),
                    )
                ).fetchone()
                result = {
                    "requestId": str(rid),
                    "kind": "upload",
                    "state": "completed",
                    "fileId": identifier,
                    "result": file_value(row, "/api/resource-library"),
                    "code": 0,
                    "message": "ok",
                }
                await conn.execute(
                    "INSERT INTO resource_operation_receipts(owner_id,request_id,kind,result) VALUES(%s,%s,'upload',%s)",
                    (owner, rid, Jsonb(result)),
                )
                if n in (0, count - 1):
                    sample.append((str(rid), result, raw))
    assert len(hashes) == count and count * size > settings.backup_max_bytes
    backup_id, _ = await old.create_capsule(bc, backup_app, settings)
    row = await backups.row_for(db, UUID(backup_id))
    path = settings.backup_dir / (backup_id + ".enc")

    def prefix():
        with open(path, "rb") as source:
            return source.read(len(MAGIC))

    assert await asyncio.to_thread(prefix) == MAGIC
    manifest, entries = backups.unpack(settings, row)
    assert isinstance(entries, LoadedBackup) and manifest["format"] == 2
    assert sum(n.startswith("resource-media/") for n in entries) == count
    assert len(manifest["files"]) == count + 3
    # Preview authenticates without creating a recovery file or re-enabling a client.
    preview = await bc.get(
        "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert preview.status_code == 200, preview.text
    target = settings.restore_targets[0]
    assert not target.recovery_directory.exists()
    job, _ = await old.submit(
        bc,
        "backup.restore",
        backup_id=backup_id,
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    result = await old.execute(backup_app, settings, UUID(job["id"]))
    assert result["files_verified"] == count + 1
    restored_files = target.recovery_directory / "files/resource-media"
    assert {p.name for p in restored_files.iterdir()} == hashes
    for path in restored_files.iterdir():
        assert path.stat().st_size == size and hashlib.sha256(path.read_bytes()).hexdigest() == path.name
    recovered = settings.model_copy(
        update={
            "database_url": target.database_url,
            "instance_id": target.instance_id,
            "environment": "test",
            "file_root": target.recovery_directory / "files",
            "connection_secret_dir": target.recovery_directory / "connection-secrets",
            "restore_targets": [],
        }
    )
    app = create_app(recovered)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client,
    ):
        client.cookies.update(bc.cookies)
        assert (await client.get("/api/resource-library")).status_code == 401
        login = await client.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert login.status_code == 200, login.text
        for rid, expected, raw in sample:
            receipt = await client.get("/api/resource-library/uploads/" + rid)
            assert receipt.status_code == 200 and receipt.json() == expected
            assert (await client.get(expected["result"]["downloadPath"])).content == raw
        async with app.state.db.connection() as conn:
            assert (await (await conn.execute("SELECT count(*) AS n FROM resource_files")).fetchone())[
                "n"
            ] == count
            assert (
                await (await conn.execute("SELECT count(*) AS n FROM resource_operation_receipts")).fetchone()
            )["n"] == count
    # Record only this owned, reusable pytest tree so post-session housekeeping
    # can reclaim its synthetic files after every app/PG fixture has closed.
    marker = settings.file_root.parent / ".owned-stream-scale.json"
    marker.write_text(
        json.dumps({"instance": str(settings.instance_id), "objects": count, "bytes": count * size})
    )
    evidence_path = os.environ.get("ALCOR_SCALE_EVIDENCE")
    if evidence_path:
        evidence = Path(evidence_path)
        evidence.parent.mkdir(parents=True, exist_ok=True)
        evidence.write_text(
            json.dumps(
                {"path": str(marker.parent), "marker": marker.name, "instance": str(settings.instance_id)}
            )
        )


async def test_actual_v1_capsule_stays_readable_and_restorable(bc, backup_app, configured):
    job, _ = await old.submit(bc)
    task = await claim(backup_app.state.db, uuid4())
    assert str(task["id"]) == job["id"]
    result = await backups.create_legacy_backup(configured, backup_app.state.db, task)
    assert await finish(backup_app.state.db, task, result)
    row = await backups.row_for(backup_app.state.db, UUID(job["id"]))
    manifest, entries = backups.unpack(configured, row)
    assert manifest["format"] == 1 and isinstance(entries, dict)
    preview = await bc.get(
        "/api/backups/" + job["id"] + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert preview.status_code == 200, preview.text
    restore, _ = await old.submit(
        bc,
        "backup.restore",
        backup_id=job["id"],
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    assert (await old.execute(backup_app, configured, UUID(restore["id"])))["files_verified"] == 1
    configured.backup_secret_dir = configured.backup_secret_dir.parent / "missing-v1-key"
    with pytest.raises(backups.BackupFailure, match="密钥"):
        backups.unpack(configured, row)
    assert not configured.backup_secret_dir.exists()


async def test_v2_budget_and_missing_key_never_create_a_false_complete_or_new_secret(
    bc, backup_app, configured
):
    configured.backup_stream_max_bytes = 1024**2
    original = configured.file_root / ("a" * 64)
    original.write_bytes(b"x" * (2 * 1024**2))
    original.chmod(0o600)
    _job, _ = await old.submit(bc)
    task = await claim(backup_app.state.db, uuid4())
    with pytest.raises(backups.BackupFailure):
        await backups.run_job(configured, backup_app.state.db, task)
    assert not list(configured.backup_dir.glob("*.enc"))
    original.unlink()
    configured.backup_stream_max_bytes = 128 * 1024**2
    await finish(backup_app.state.db, task, error_code="synthetic_budget_failure")
    backup_id, _ = await old.create_capsule(bc, backup_app, configured)
    configured.backup_secret_dir = configured.backup_secret_dir.parent / "missing-stream-key"
    assert not configured.backup_secret_dir.exists()
    response = await bc.get(
        "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert response.status_code == 422
    assert not configured.backup_secret_dir.exists()
    assert not configured.restore_targets[0].recovery_directory.exists() or not list(
        configured.restore_targets[0].recovery_directory.iterdir()
    )


async def test_stream_deadline_stops_worker_before_publication_and_releases_ownership(
    bc, backup_app, configured
):
    import threading

    from alcor_api.backup_stream_jobs import checked_work

    job, _ = await old.submit(bc)
    task = await claim(backup_app.state.db, uuid4())
    assert str(task["id"]) == job["id"]
    stopped = threading.Event()

    def slow(cancel):
        cancel.wait(5)
        assert cancel.is_set()
        stopped.set()

    backup_app.state.db.settings.backup_stream_seconds = 0.01
    with pytest.raises(backups.BackupFailure, match="执行预算"):
        await checked_work(backup_app.state.db, task, slow)
    assert stopped.is_set() and not list(configured.backup_dir.glob("*.enc"))
    assert await finish(backup_app.state.db, task, error_code="synthetic_deadline")


async def test_slow_source_inventory_keeps_owned_lease_and_reports_phase(bc,backup_app,configured,monkeypatch):
    from alcor_api import backup_stream_jobs as jobs
    configured.lease_seconds=2
    started=asyncio.Event();proceed=asyncio.Event()
    original=jobs.collect_sources
    async def slow(*args,**kwargs):
        started.set();await proceed.wait()
        return await original(*args,**kwargs)
    monkeypatch.setattr(jobs,'collect_sources',slow)
    job,_=await old.submit(bc)
    work=asyncio.create_task(old.execute(backup_app,configured,UUID(job['id'])))
    try:
        await asyncio.wait_for(started.wait(),10)
        await asyncio.sleep(3)
        async with backup_app.state.db.connection() as conn:
            row=await(await conn.execute('SELECT status,lease_until>clock_timestamp() AS owned,result FROM tasks WHERE id=%s',(UUID(job['id']),))).fetchone()
        assert row['status']=='running' and row['owned']
        assert row['result']['progress']['phase']=='backup_sources'
    finally:
        proceed.set()
        result=await work
    assert result['message']=='备份已完成'
    assert await backups.row_for(backup_app.state.db,UUID(job['id']))
