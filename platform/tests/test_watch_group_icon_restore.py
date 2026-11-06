from uuid import UUID, uuid4

import httpx
import test_backups as helpers
from alcor_api.main import create_app
from test_watch_group_icons import BASE, SVG, group, upload

configured = helpers.configured
backup_app = helpers.backup_app
bc = helpers.bc


async def test_real_encrypted_pg_restore_preserves_personal_original_safe_derivative_deleted_group_and_UUID(
    bc, backup_app, configured
):
    gid = await group(bc, "Restore personal")
    first, _ = await upload(bc, gid, SVG, "original.svg")
    second, _ = await upload(bc, gid, SVG.replace(b"M0 0", b"M1 1"), "original.svg")
    assert first.status_code == 200 and second.status_code == 200
    one = first.json()
    media = one["icon"]
    served = (await bc.get(media["url"])).content
    revision = (await bc.get(BASE)).json()["revision"]
    deleted = await bc.post(
        BASE + "/operations",
        json={
            "requestId": str(uuid4()),
            "expectedRevision": revision,
            "action": "delete",
            "data": {"id": gid},
        },
    )
    assert deleted.status_code == 200
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
        assert (await client.get(media["url"])).status_code == 401
        login = await client.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert login.status_code == 200
        client.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await client.get(media["originalPath"])).content == SVG
        assert (await client.get(media["url"])).content == served
        for response in [first, second]:
            assert (
                await client.get(BASE + "/operations/" + response.json()["requestId"])
            ).json() == response.json()
        assert all(g["id"] != gid for g in (await client.get(BASE)).json()["groups"])
        assert (await client.get(BASE + "/" + gid + "/icon")).status_code == 404
        async with app.state.db.connection() as conn:
            assert (
                await (await conn.execute("SELECT count(*) n FROM watch_group_icon_versions")).fetchone()
            )["n"] == 2
            assert (await (await conn.execute("SELECT count(*) n FROM resource_media_objects")).fetchone())[
                "n"
            ] == 4
            assert (await (await conn.execute("SELECT count(*) n FROM admin_attachment_objects")).fetchone())[
                "n"
            ] == 0
