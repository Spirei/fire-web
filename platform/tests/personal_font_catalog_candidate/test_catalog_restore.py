from uuid import UUID

import httpx
import test_backups as helpers
from alcor_api.main import create_app
from personal_font_catalog_candidate.test_catalog import C, catalog
from personal_font_source_candidate.test_source_fonts import P, preview, ready

configured = helpers.configured
backup_app = helpers.backup_app
bc = helpers.bc


async def test_real_encrypted_restore_keeps_global_inventory_file_claim_private_original_and_receipts(
    bc, backup_app, configured, old_pg, source_file
):
    inventoried, scan_command = await catalog(bc, old_pg)
    async with backup_app.state.db.connection() as conn:
        owner = (await (await conn.execute("SELECT id FROM users WHERE username='BackupQA'")).fetchone())[
            "id"
        ]
    p, cap, _ = await ready(bc, owner, old_pg, source_file)
    command = await preview(bc, cap)
    applied = await bc.post(P + "/operations", json=command)
    assert applied.status_code == 200, applied.text
    backup, _ = await helpers.create_capsule(bc, backup_app, configured)
    previewed = await bc.get(
        "/api/backups/" + backup + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert previewed.status_code == 200, previewed.text
    job, _ = await helpers.submit(
        bc,
        "backup.restore",
        backup_id=backup,
        target_id="isolated-qa",
        restore_ticket=previewed.json()["restore_ticket"],
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
            "legacy_source_registry_path": None,
            "font_import_registry_path": None,
        }
    )
    source_file[0].rename(source_file[0].with_name("offline-after-backup"))
    restored_app = create_app(settings)
    async with (
        restored_app.router.lifespan_context(restored_app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=restored_app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client,
    ):
        client.cookies.update(bc.cookies)
        assert (await client.get(C + "/" + inventoried["catalogId"])).status_code == 401
        logged = await client.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert logged.status_code == 200, logged.text
        client.headers["x-csrf-token"] = logged.json()["csrf"]
        read = await client.get(C + "/" + inventoried["catalogId"])
        assert read.status_code == 200, read.text
        assert read.json()["counts"]["archived"] == read.json()["counts"]["mapped"] == 1
        assert read.json()["instanceReenrollmentRequired"]
        assert (
            await client.get(P + "/catalog-operations/" + scan_command["requestId"])
        ).json() == inventoried
        assert (await client.get(P + "/operations/" + command["requestId"])).json() == applied.json()
        assert (await client.get(cap["originalPath"])).content == source_file[2]
        assert (await client.get("/uploads/fonts/" + p["originalId"])).content == source_file[2]
        async with restored_app.state.db.connection() as conn:
            row = await (
                await conn.execute(
                    "SELECT owner_id FROM personal_font_source_file_claims WHERE original_id=%s",
                    (p["originalId"],),
                )
            ).fetchone()
            assert row["owner_id"] == owner
