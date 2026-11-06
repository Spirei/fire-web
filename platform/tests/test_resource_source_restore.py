from uuid import UUID

import httpx
import test_backups as backup_tests
from alcor_api.main import create_app
from resource_import_fixtures import (
    DELETE_ID,
    DELETED,
    RAW,
    READY,
    UPLOAD_ID,
    authorize,
    segment,
    snapshot,
)

configured = backup_tests.configured
backup_app = backup_tests.backup_app
bc = backup_tests.bc
import resource_import_fixtures as source_fixtures

source = source_fixtures.source
settings = source_fixtures.settings
app = source_fixtures.app
client = source_fixtures.client
admin = source_fixtures.admin

P = "/api/resource-import"
R = "/api/resource-library"


async def test_real_encrypted_pg_dump_restore_preserves_import_raw_uuid_tombstone_bytes_and_disables_old_source_access(
    bc, backup_app, configured, source
):
    async with backup_app.state.db.connection() as conn:
        owner = (await (await conn.execute("SELECT id FROM users WHERE username='BackupQA'")).fetchone())[
            "id"
        ]
    consent = await authorize(bc, owner, source)
    manifest, _capture_id = await snapshot(bc, consent)
    result, command = await segment(bc, manifest)
    assert result["targetImportCompleted"]
    before = (await bc.get(P + "/manifests/" + manifest)).json()
    original_upload = (await bc.get(R + "/operations/" + UPLOAD_ID)).json()
    original_delete = (await bc.get(R + "/operations/" + DELETE_ID)).json()
    backup_id, _ = await backup_tests.create_capsule(bc, backup_app, configured)
    encrypted = (configured.backup_dir / (backup_id + ".enc")).read_bytes()
    assert b"PGDMP" not in encrypted[:10] and RAW not in encrypted
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
    restored = configured.model_copy(
        update={
            "database_url": target.database_url,
            "instance_id": target.instance_id,
            "environment": "test",
            "redis_url": None,
            "file_root": target.recovery_directory / "files",
            "connection_secret_dir": target.recovery_directory / "connection-secrets",
            "restore_targets": [],
            "legacy_source_registry_path": None,
            "resource_import_registry_path": None,
        }
    )
    source.root.rename(source.root.with_name("source-not-available-after-restore"))
    app = create_app(restored)
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client,
    ):
        client.cookies.update(bc.cookies)
        assert (await client.get(P + "/manifests/" + manifest)).status_code == 401
        login = await client.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert login.status_code == 200, login.text
        client.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await client.get(P + "/manifests/" + manifest)).json() == before
        assert (await client.get(P + "/operations/" + command["requestId"])).json() == result
        assert (await client.get(R + "/operations/" + UPLOAD_ID)).json() == original_upload
        assert (await client.get(R + "/operations/" + DELETE_ID)).json() == original_delete
        assert original_delete["result"]["usedBytes"] == 4321
        assert (await client.get(R + "/files/" + READY + "/content")).content == RAW
        assert (await client.get(R + "/files/" + DELETED)).status_code == 404
        assert not (await client.get(P + "/authorizations")).json()["items"][0]["effective"]
        assert (
            await client.post(P + "/manifests/" + manifest + "/preview", json={"revision": 2})
        ).status_code == 409
        async with app.state.db.connection() as conn:
            rows = await (
                await conn.execute(
                    "SELECT id,sha256,object_sha256,deleted_at FROM resource_files ORDER BY id"
                )
            ).fetchall()
            assert len(rows) == 2 and rows[1]["object_sha256"] is None and rows[1]["deleted_at"]
            assert (await (await conn.execute("SELECT count(*) n FROM resource_media_objects")).fetchone())[
                "n"
            ] == 1
            assert (
                await (await conn.execute("SELECT count(*) n FROM legacy_source_owner_claims")).fetchone()
            )["n"] == 1
        first = before["items"][0]
        assert (await client.get(P + "/manifests/" + manifest + "/records/" + str(first["seq"]))).json()[
            "sha256"
        ] == first["raw_sha256"]
