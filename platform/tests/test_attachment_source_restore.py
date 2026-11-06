from uuid import UUID, uuid4

import httpx
import test_backups as helpers
from alcor_api.main import create_app
from test_attachment_source_import import ATT, BASE, capture, registry, segment

configured = helpers.configured
backup_app = helpers.backup_app
bc = helpers.bc


async def test_real_encrypted_restore_keeps_partial_source_raw_bytes_progress_links_and_original_receipts(
    bc, backup_app, configured, tmp_path
):
    root = tmp_path / "isolated-legacy" / "data" / "attachments"
    root.mkdir(parents=True)
    (root / "first.txt").write_bytes(b"original first\r\n")
    (root / "second.txt").write_bytes(b"active original\x00")
    (root / "third.txt").write_bytes(b"not yet applied")
    registry(configured, root, tmp_path / "operator-source")
    captured, _ = await capture(bc)
    assert captured.status_code == 200, captured.text
    one = captured.json()
    identifier = one["manifestId"]
    applied, _ = await segment(bc, identifier, max_items=2)
    assert applied.status_code == 200 and not applied.json()["targetImportCompleted"]
    revision = (await bc.get(ATT)).json()["revision"]
    deleted = await bc.request(
        "DELETE",
        ATT,
        params={"path": "first.txt"},
        json={"requestId": str(uuid4()), "expectedRevision": revision},
    )
    assert deleted.status_code == 200, deleted.text
    saved = (await bc.get(BASE + "/snapshots/" + identifier)).json()
    assert saved["pending"] == 1 and saved["applied"] == 2 and saved["targetChangedCount"] == 1
    raw = {
        item["ordinal"]: (
            await bc.get(BASE + "/snapshots/" + identifier + "/items/" + str(item["ordinal"]) + "/original")
        ).content
        for item in saved["items"]
    }
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
    root.rename(root.with_name("offline-source"))
    target = configured.restore_targets[0]
    settings = configured.model_copy(
        update={
            "database_url": target.database_url,
            "instance_id": target.instance_id,
            "file_root": target.recovery_directory / "files",
            "connection_secret_dir": target.recovery_directory / "connection-secrets",
            "redis_url": None,
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
        assert (await client.get(BASE + "/snapshots/" + identifier)).status_code == 401
        login = await client.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert login.status_code == 200
        client.headers["x-csrf-token"] = login.json()["csrf"]
        read = (await client.get(BASE + "/snapshots/" + identifier)).json()
        assert (
            read["pending"] == 1
            and read["applied"] == 2
            and read["targetChangedCount"] == 1
            and read["instanceReenrollmentRequired"]
            and not read["targetImportCompleted"]
        )
        assert (
            await client.post(
                BASE + "/snapshots/" + identifier + "/preview", json={"maxItems": 32, "retryBlocked": False}
            )
        ).status_code == 409
        for result in [one, applied.json()]:
            assert (await client.get(BASE + "/operations/" + result["requestId"])).json() == result
        for ordinal, body in raw.items():
            assert (
                await client.get(BASE + "/snapshots/" + identifier + "/items/" + str(ordinal) + "/original")
            ).content == body
        assert (
            await client.get(ATT, params={"action": "download", "path": "second.txt"})
        ).content == b"active original\x00"
        assert len((await client.get(ATT)).json()["files"]) == 1
        async with app.state.db.connection() as conn:
            for table in ["resource_media_objects", "resource_files", "legacy_source_heads"]:
                assert (await (await conn.execute("SELECT count(*) n FROM " + table)).fetchone())["n"] == 0
