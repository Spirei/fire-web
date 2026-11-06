from uuid import UUID

import httpx
import test_backups as helpers
from alcor_api.main import create_app
from personal_font_source_candidate.test_source_fonts import P, preview, ready

configured = helpers.configured
backup_app = helpers.backup_app
bc = helpers.bc


async def test_real_encrypted_snapshot_restore_keeps_source_original_alias_and_original_receipts(
    bc, backup_app, configured, old_pg, source_file
):
    async with backup_app.state.db.connection() as conn:
        owner = (await (await conn.execute("SELECT id FROM users WHERE username='BackupQA'")).fetchone())[
            "id"
        ]
    p, cap, captured = await ready(bc, owner, old_pg, source_file)
    command = await preview(bc, cap)
    response = await bc.post(P + "/operations", json=command)
    assert response.status_code == 200, response.text
    value = response.json()
    backup, _ = await helpers.create_capsule(bc, backup_app, configured)
    proof = await bc.get("/api/backups/" + backup + "/restore-preview", params={"target_id": "isolated-qa"})
    assert proof.status_code == 200, proof.text
    job, _ = await helpers.submit(
        bc,
        "backup.restore",
        backup_id=backup,
        target_id="isolated-qa",
        restore_ticket=proof.json()["restore_ticket"],
    )
    await helpers.execute(backup_app, configured, UUID(job["id"]))
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
            "legacy_source_registry_path": None,
            "font_import_registry_path": None,
        }
    )
    source_file[0].rename(source_file[0].with_name("offline-after-archive"))
    restored_app = create_app(restored_settings)
    async with (
        restored_app.router.lifespan_context(restored_app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=restored_app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client,
    ):
        client.cookies.update(bc.cookies)
        assert (await client.get(cap["originalPath"])).status_code == 401
        session = await client.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert session.status_code == 200, session.text
        client.headers["x-csrf-token"] = session.json()["csrf"]
        assert (await client.get(cap["originalPath"])).content == source_file[2]
        assert (await client.get(value["font"]["originalPath"])).content == source_file[2]
        assert (await client.get("/uploads/fonts/" + p["originalId"])).content == source_file[2]
        assert (await client.get(P + "/operations/" + command["requestId"])).json() == value
        assert (await client.get(P + "/operations/" + captured["requestId"])).json()["capture"] == cap
        assert len((await client.get(P + "/permissions")).json()["captures"]) == 1
        # Archive reads survive recovery; a different platform instance receives
        # no implicit authority to import or read the old source again.
        denied = await client.post(P + "/preview", json={"captureId": cap["id"]})
        assert denied.status_code == 409
