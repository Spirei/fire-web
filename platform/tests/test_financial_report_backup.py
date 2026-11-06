from uuid import UUID, uuid4

import httpx
import test_backups as support
from alcor_api.main import create_app
from test_financial_reports import RAW, upload

configured = support.configured
backup_app = support.backup_app
bc = support.bc


async def test_encrypted_restore_keeps_private_original_metadata_tombstone_and_uuid(
    bc, backup_app, configured
):
    first = await upload(bc)
    assert first.status_code == 201, first.text
    kept = first.json()
    second = (await upload(bc, revision=1, raw=RAW + b"delete this report")).json()
    deleted = str(uuid4())
    assert (
        await bc.delete(
            "/api/financial-reports/"
            + second["report"]["id"]
            + "?requestId="
            + deleted
            + "&expectedRevision=2"
        )
    ).status_code == 200
    closed = str(uuid4())
    assert (await bc.post("/api/financial-reports/operations/" + closed + "/close")).json()[
        "state"
    ] == "closed"
    backup, _ = await support.create_capsule(bc, backup_app, configured)
    preview = await bc.get("/api/backups/" + backup + "/restore-preview", params={"target_id": "isolated-qa"})
    assert preview.status_code == 200, preview.text
    job, _ = await support.submit(
        bc,
        "backup.restore",
        backup_id=backup,
        target_id="isolated-qa",
        restore_ticket=preview.json()["restore_ticket"],
    )
    await support.execute(backup_app, configured, UUID(job["id"]))
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
        assert (await client.get("/api/financial-reports")).status_code == 401
        login = await client.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert login.status_code == 200, login.text
        client.headers["x-csrf-token"] = login.json()["csrf"]
        listing = (await client.get("/api/financial-reports")).json()
        assert listing["reports"] == [kept["report"]] and listing["revision"] == 3
        assert (await client.get(kept["report"]["fileUrl"])).content == RAW
        assert (await client.get(second["report"]["fileUrl"])).status_code == 404
        assert (await client.get("/api/financial-reports/operations/" + kept["requestId"])).json() == kept
        assert (await client.get("/api/financial-reports/operations/" + deleted)).json()["deleted"] is True
        assert (await client.get("/api/financial-reports/operations/" + closed)).json()["state"] == "closed"
        assert (await upload(client, revision=3, request=closed)).status_code == 409
        async with app.state.db.connection() as conn:
            rows = await (
                await conn.execute(
                    "SELECT source_snapshot,deleted_at FROM financial_report_files ORDER BY created_at"
                )
            ).fetchall()
            assert rows[0]["source_snapshot"]["originInstance"] == str(configured.instance_id)
            assert rows[0]["source_snapshot"]["sourceVerified"] is False and rows[1]["deleted_at"] is not None
