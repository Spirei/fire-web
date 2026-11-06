"""An original UUID fence is persistent authority across a genuine isolated restore."""

from uuid import UUID, uuid4

import httpx
import test_backups as backup_tests
from alcor_api.main import create_app

configured = backup_tests.configured
backup_app = backup_tests.backup_app
bc = backup_tests.bc
P = "/api/resource-library"


async def test_cancel_tombstone_and_success_receipt_restore_then_fence_late_original(
    bc, backup_app, configured
):
    cancelled_id = str(uuid4())
    original = await bc.post(P + "/operations/" + cancelled_id + "/cancel", json={"expectedKind": "upload"})
    assert original.status_code == 200 and original.json()["cancelled"] is True
    completed_id = str(uuid4())
    uploaded = await bc.post(
        P + "/files",
        data={"requestId": completed_id, "category": "components", "name": "keep.txt"},
        files={"file": ("transport.bin", b"keep committed original", "text/plain")},
    )
    assert uploaded.status_code == 201, uploaded.text
    success = uploaded.json()
    assert (
        await bc.post(P + "/operations/" + completed_id + "/cancel", json={"expectedKind": "upload"})
    ).json() == success
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
    app = create_app(restored_settings)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client,
    ):
        client.cookies.update(bc.cookies)
        assert (await client.get(P + "/operations/" + cancelled_id)).status_code == 401
        login = await client.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert login.status_code == 200, login.text
        client.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await client.get(P + "/operations/" + cancelled_id)).json() == original.json()
        assert (await client.get(P + "/operations/" + completed_id)).json() == success
        late = await client.post(
            P + "/files",
            data={"requestId": cancelled_id, "category": "components", "name": "late.txt"},
            files={"file": ("transport.bin", b"must not commit", "text/plain")},
        )
        assert late.status_code == 409, late.text
        assert (await client.get(success["result"]["downloadPath"])).content == b"keep committed original"
        assert (await client.get(P)).json()["usage"]["fileCount"] == 1
        assert (
            await client.post(P + "/operations/" + cancelled_id + "/cancel", json={"expectedKind": "upload"})
        ).json() == original.json()
        async with app.state.db.connection() as conn:
            assert (
                await (await conn.execute("SELECT count(*) AS n FROM resource_operation_receipts")).fetchone()
            )["n"] == 2
            assert (
                await (await conn.execute("SELECT count(*) AS n FROM resource_media_objects")).fetchone()
            )["n"] == 1
