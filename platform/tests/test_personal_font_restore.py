from uuid import UUID

import httpx
import pytest_asyncio
import test_backups as helpers
from alcor_api.main import create_app
from font_fixtures import font_bytes
from test_personal_fonts import P, upload

configured = helpers.configured
backup_app = helpers.backup_app
bc = helpers.bc


@pytest_asyncio.fixture(autouse=True)
async def isolate_font_restore_sources(settings):
    settings.asset_root = None
    settings.legacy_source_registry_path = None
    settings.resource_import_registry_path = None
    settings.attachment_import_registry_path = None
    settings.watch_group_import_registry_path = None
    settings.watch_group_icon_import_registry_path = None


async def test_real_encrypted_restore_keeps_owner_font_original_and_operation_without_old_session(
    bc, backup_app, configured
):
    raw = font_bytes("woff2")
    first, body = await upload(bc, raw, "归档字形.woff2")
    assert first.status_code == 200, first.text
    font = first.json()["font"]
    backup, _ = await helpers.create_capsule(bc, backup_app, configured)
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
        ) as restored,
    ):
        restored.cookies.update(bc.cookies)
        assert (await restored.get(font["contentPath"])).status_code == 401
        login = await restored.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert login.status_code == 200
        restored.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await restored.get(font["originalPath"])).content == raw
        assert (await restored.get(font["contentPath"])).content == raw
        assert (await restored.get("/uploads/fonts/" + font["id"])).content == raw
        assert (await restored.get(P + "/operations/" + body["requestId"])).json() == first.json()
        assert (await restored.get(P)).json()["fonts"] == [font]
