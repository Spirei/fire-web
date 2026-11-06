from uuid import UUID

import httpx
import test_backups as helpers
from alcor_api.main import create_app
from test_admin_attachments import P, upload

configured = helpers.configured
backup_app = helpers.backup_app
bc = helpers.bc


async def test_actual_encrypted_snapshot_restore_keeps_global_empty_original_versions_tombstone_and_uuid(
    bc, backup_app, configured
):
    zero, _ = await upload(bc, "zero.bin", b"")
    assert zero.status_code == 200, zero.text
    original, _ = await upload(bc, "history.bin", b"original shared")
    assert original.status_code == 200
    replacement, _ = await upload(bc, "history.bin", b"replacement shared", conflict="replace")
    assert replacement.status_code == 200
    removed, _ = await upload(bc, "gone.bin", b"old deleted original")
    assert removed.status_code == 200
    revision = (await bc.get(P)).json()["revision"]
    from uuid import uuid4

    deleted = await bc.request(
        "DELETE",
        P,
        params={"path": "gone.bin"},
        json={"requestId": str(uuid4()), "expectedRevision": revision},
    )
    assert deleted.status_code == 200
    backup, _ = await helpers.create_capsule(bc, backup_app, configured)
    ciphertext = (configured.backup_dir / (backup + ".enc")).read_bytes()
    assert b"original shared" not in ciphertext
    preview = await bc.get("/api/backups/" + backup + "/restore-preview", params={"target_id": "isolated-qa"})
    assert preview.status_code == 200, preview.text
    job, _ = await helpers.submit(
        bc,
        "backup.restore",
        backup_id=backup,
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    await helpers.execute(backup_app, configured, UUID(job["id"]))
    target = configured.restore_targets[0]
    settings = configured.model_copy(
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
    app = create_app(settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client,
    ):
        client.cookies.update(bc.cookies)
        assert (await client.get(P)).status_code == 401
        login = await client.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert login.status_code == 200, login.text
        client.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await client.get(zero.json()["downloadPath"])).content == b""
        assert (await client.get(original.json()["downloadPath"])).content == b"original shared"
        assert (await client.get(replacement.json()["downloadPath"])).content == b"replacement shared"
        assert (await client.get(removed.json()["downloadPath"])).status_code in (400, 404)
        for response in (zero, original, replacement, removed, deleted):
            assert (
                await client.get(P + "/operations/" + response.json()["requestId"])
            ).json() == response.json()
        async with app.state.db.connection() as conn:
            assert (await (await conn.execute("SELECT count(*) n FROM admin_attachment_objects")).fetchone())[
                "n"
            ] == 4
            assert (
                await (
                    await conn.execute(
                        "SELECT count(*) n FROM admin_attachment_entries WHERE deleted_at IS NOT NULL"
                    )
                ).fetchone()
            )["n"] == 1
            assert (await (await conn.execute("SELECT count(*) n FROM resource_media_objects")).fetchone())[
                "n"
            ] == 0
