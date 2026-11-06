from uuid import UUID

import httpx
import test_backups as helpers
from alcor_api.main import create_app
from test_system_assets import PNG, SVG, P, upload

configured = helpers.configured
backup_app = helpers.backup_app
bc = helpers.bc


async def test_real_encrypted_pg_restore_keeps_system_raw_svg_public_derivative_historic_url_and_uuid(
    bc, backup_app, configured
):
    original, _ = await upload(bc, "asset", SVG, "icon.svg", folder="icon", code="RESTORE")
    replacement, _ = await upload(
        bc, "asset", SVG.replace(b"M0 0", b"M1 1"), "icon.svg", folder="icon", code="RESTORE"
    )
    raster, _ = await upload(bc, "login", PNG)
    assert all(r.status_code == 200 for r in (original, replacement, raster))
    first = original.json()
    raw = await bc.get(P + "/versions/" + first["version"] + "/original")
    assert raw.content == SVG
    public = await bc.get(first["url"])
    assert public.status_code == 200
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
        ) as client,
    ):
        client.cookies.update(bc.cookies)
        assert (await client.get(P + "/versions/" + first["version"] + "/original")).status_code == 401
        assert (await client.get(first["url"])).content == public.content
        login = await client.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert login.status_code == 200
        client.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await client.get(P + "/versions/" + first["version"] + "/original")).content == SVG
        assert (await client.get(replacement.json()["legacyUrl"])).content == (
            await client.get(replacement.json()["url"])
        ).content
        for response in (original, replacement, raster):
            assert (
                await client.get(P + "/operations/" + response.json()["requestId"])
            ).json() == response.json()
        async with app.state.db.connection() as conn:
            assert (await (await conn.execute("SELECT count(*) n FROM system_asset_versions")).fetchone())[
                "n"
            ] == 3
            assert (await (await conn.execute("SELECT count(*) n FROM resource_media_objects")).fetchone())[
                "n"
            ] == 0
