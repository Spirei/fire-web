"""Real encrypted pg_dump/restore and file lifecycle/snapshot interleavings."""

import asyncio
import hashlib
import os
from uuid import UUID, uuid4

import httpx
import psycopg
import pytest
import test_backups as backup_tests
from alcor_api.backups import BackupFailure, media_entries
from alcor_api.main import create_app
from alcor_api.profile_backup import profile_snapshot_media_lock
from alcor_api.resource_media import ResourceMedia, capture_resource_media
from psycopg.rows import dict_row
from resource_test_support import resource_files, setup, upload  # noqa:F401
from test_legacy_devices import bearer

configured = backup_tests.configured
backup_app = backup_tests.backup_app
bc = backup_tests.bc


async def web_upload(client, filename, raw):
    rid = str(uuid4())
    result = await client.post(
        "/api/resource-library/files",
        data={"requestId": rid, "category": "components", "name": filename},
        files={"file": ("transport.bin", raw, "application/octet-stream")},
    )
    assert result.status_code == 201, result.text
    return rid, result.json()["result"]


async def test_actual_encrypted_restore_keeps_original_uuid_folder_tombstone_and_bytes(
    bc, backup_app, configured
):
    first_id, first = await web_upload(bc, 'one "original%22".txt', b"first\r\n")
    second_id, second = await web_upload(bc, "two.txt", b"second\n")
    folder_id = str(uuid4())
    created = await bc.post(
        "/api/resource-library/folders",
        json={"requestId": folder_id, "category": "components", "name": "folder"},
    )
    assert created.status_code == 201, created.text
    folder = created.json()["result"]
    move_id = str(uuid4())
    moved = await bc.patch(
        "/api/resource-library/files/" + second["id"],
        json={
            "requestId": move_id,
            "revision": 1,
            "folderId": folder["id"],
            "folderRevision": 1,
            "name": "renamed.txt",
        },
    )
    assert moved.status_code == 200, moved.text
    delete_id = str(uuid4())
    deleted = await bc.request(
        "DELETE", "/api/resource-library/files/" + first["id"], json={"requestId": delete_id, "revision": 1}
    )
    assert deleted.status_code == 200, deleted.text
    originals = {}
    async with backup_app.state.db.connection() as conn:
        for table in (
            "resource_folders",
            "resource_files",
            "resource_media_objects",
            "resource_operation_receipts",
            "resource_cursor_key",
        ):
            originals[table] = await (
                await conn.execute(
                    "SELECT to_jsonb(x) AS row FROM " + table + " x ORDER BY to_jsonb(x)::text"
                )
            ).fetchall()
    backup_id, _ = await backup_tests.create_capsule(bc, backup_app, configured)
    preview = await bc.get(
        "/api/backups/" + backup_id + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert preview.status_code == 200, preview.text
    job, _ = await backup_tests.submit(
        bc,
        "backup.restore",
        backup_id=backup_id,
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    await backup_tests.execute(backup_app, configured, UUID(job["id"]))
    target = configured.restore_targets[0]
    restored_settings = configured.model_copy(
        update={
            "database_url": target.database_url,
            "instance_id": target.instance_id,
            "environment": "test",
            "redis_url": None,
            "file_root": target.recovery_directory / "files",
            "connection_secret_dir": target.recovery_directory / "connection-secrets",
            "restore_targets": [],
        }
    )
    restored = create_app(restored_settings)
    async with (
        restored.router.lifespan_context(restored),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=restored, raise_app_exceptions=False),
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
        client.headers["x-csrf-token"] = login.json()["csrf"]
        async with restored.state.db.connection() as conn:
            for table, rows in originals.items():
                assert (
                    await (
                        await conn.execute(
                            "SELECT to_jsonb(x) AS row FROM " + table + " x ORDER BY to_jsonb(x)::text"
                        )
                    ).fetchall()
                    == rows
                )
        for rid, file in [(first_id, first), (second_id, second)]:
            receipt = await client.get("/api/resource-library/uploads/" + rid)
            assert receipt.status_code == 200 and receipt.json()["result"] == file
        for rid in [folder_id, move_id, delete_id]:
            assert (await client.get("/api/resource-library/operations/" + rid)).json()[
                "state"
            ] == "completed"
        assert (await client.get(first["downloadPath"])).status_code == 404
        assert (await client.get(second["downloadPath"])).content == b"second\n"
        assert (await client.get("/api/resource-library/files/" + second["id"])).json()[
            "name"
        ] == "renamed.txt"
        # Deleted originals are retained privately for consistent history/backup,
        # never restored as a live file or served through an upload receipt.
        for file, raw in [(first, b"first\r\n"), (second, b"second\n")]:
            path = restored_settings.file_root / "resource-media" / file["sha256"]
            assert (
                path.read_bytes() == raw and hashlib.sha256(path.read_bytes()).hexdigest() == file["sha256"]
            )
        duplicate = await client.request(
            "DELETE",
            "/api/resource-library/files/" + second["id"],
            json={"requestId": delete_id, "revision": 2},
        )
        assert duplicate.status_code == 409
        assert (await client.get(second["downloadPath"])).content == b"second\n"


async def test_snapshot_excludes_uncommitted_and_orphan_bytes_but_captures_committed(client, db, settings):
    uid, pair, _read, base = await setup(client, db)
    response, _ = await upload(client, base, pair)
    committed = response.json()["result"]
    pending = b"uncommitted synthetic original"
    async with db.connection() as writer, writer.transaction():
        sha = await ResourceMedia(settings).stage(writer, uid, pending)
        assert (settings.file_root / "resource-media" / sha).exists()
        entries = media_entries(settings)
        assert not any(n.startswith("resource-media/") for n in entries)
        async with (
            await psycopg.AsyncConnection.connect(
                settings.database_url.get_secret_value(), autocommit=True, row_factory=dict_row
            ) as snapshot,
            profile_snapshot_media_lock(snapshot),
            snapshot.transaction(),
        ):
            await snapshot.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            await snapshot.execute("SELECT pg_export_snapshot()")
            await capture_resource_media(snapshot, settings, entries)
        assert list(entries) == ["resource-media/" + committed["sha256"]]
    entries = {}
    async with db.connection() as conn:
        await capture_resource_media(conn, settings, entries)
    assert entries["resource-media/" + sha] == pending


async def test_backup_session_lock_precedes_snapshot_and_blocks_cleanup_after_account_delete(
    bc, backup_app, configured
):
    from alcor_api.cli import create_user
    from test_legacy_devices import grant

    settings = configured
    db = backup_app.state.db
    uid = await create_user(settings, "RetiredResourceOwner", "Synthetic9Pass", role="user")
    pair = await grant(db, uid, "portfolio.read resources.read resources.write")
    base = "/api/client/resource-library"
    response, _ = await upload(bc, base, pair)
    file = response.json()["result"]
    path = settings.file_root / "resource-media" / file["sha256"]
    os.utime(path, (1, 1))
    async with await psycopg.AsyncConnection.connect(
        settings.database_url.get_secret_value(), autocommit=True, row_factory=dict_row
    ) as snapshot:
        async with profile_snapshot_media_lock(snapshot), snapshot.transaction():
            await snapshot.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            await snapshot.execute("SELECT pg_export_snapshot()")
            listing = await bc.get("/api/users")
            owner = next(row for row in listing.json()["items"] if row["id"] == uid)
            retired = await bc.request(
                "DELETE",
                "/api/users/" + uid,
                json={"request_id": str(uuid4()), "revision": owner["revision"], "current_password": "Synthetic9Pass"},
            )
            assert retired.status_code == 200, retired.text

            async def cleanup():
                async with db.connection() as conn, conn.transaction():
                    return await ResourceMedia(settings).reconcile_orphans(conn)

            task = asyncio.create_task(cleanup())
            await asyncio.sleep(0.05)
            assert not task.done() and path.exists()
            entries = {}
            await capture_resource_media(snapshot, settings, entries)
            assert entries["resource-media/" + file["sha256"]] == b"original\r\n"
        assert await task == 1
        assert not path.exists()


async def test_capture_missing_corrupt_and_budget_fails_explicitly(client, db, settings):
    _uid, pair, read, base = await setup(client, db)
    response, _ = await upload(client, base, pair)
    file = response.json()["result"]
    path = settings.file_root / "resource-media" / file["sha256"]
    path.write_bytes(b"corrupt")
    async with db.connection() as conn:
        with pytest.raises(BackupFailure):
            await capture_resource_media(conn, settings, {})
    assert (await client.get(file["downloadPath"], headers=bearer(read))).status_code == 503
    path.write_bytes(b"original\r\n")
    settings.backup_max_bytes = 1
    async with db.connection() as conn:
        with pytest.raises(BackupFailure, match="预算"):
            await capture_resource_media(conn, settings, {})
    path.unlink()
    async with db.connection() as conn:
        with pytest.raises(BackupFailure):
            await capture_resource_media(conn, settings, {})


async def test_capture_older_schema_without_resource_tables_is_read_only(settings):
    # Genuine separate schema namespace emulates an installed pre-resource version.
    # The function tests public qualification; no CREATE/ALTER is done by capture.
    async with (
        await psycopg.AsyncConnection.connect(
            settings.database_url.get_secret_value(), autocommit=True, row_factory=dict_row
        ) as conn,
        conn.transaction(),
    ):
        await conn.execute("ALTER TABLE resource_media_objects RENAME TO unavailable_candidate_media")
        entries = {}
        await capture_resource_media(conn, settings, entries)
        assert entries == {}
        await conn.execute("ALTER TABLE unavailable_candidate_media RENAME TO resource_media_objects")
