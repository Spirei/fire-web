import json
from uuid import UUID, uuid4

import httpx
import test_backups as support
from alcor_api.asset_lookup_contract import image_key
from alcor_api.main import create_app
from test_asset_lookup_catalog import P, capture, entry
from test_system_assets import SVG, upload

configured = support.configured
backup_app = support.backup_app
bc = support.bc


async def test_encrypted_restore_preserves_confirmed_metadata_alias_original_and_uuid(
    bc, backup_app, configured
):
    image, _ = await upload(bc, raw=SVG, name="synthetic.svg", folder="stock", market="US", code="DEMO")
    assert image.status_code == 200, image.text
    saved, _, _ = await capture(
        bc, [entry(imageVersion=image.json()["version"], aliases=["/uploads/asset/stock/US/old.svg"])]
    )
    assert saved.status_code == 200, saved.text
    result = saved.json()
    closed = str(uuid4())
    assert (await bc.post(P + "/operations/" + closed + "/close", json={})).json()["state"] == "closed"
    path = "/api/asset-image/" + image_key(entry()["id"])
    raw = (await bc.get(path)).content
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
        assert (await client.get(P + "/operations/" + result["requestId"])).status_code == 401
        assert (await client.get(path)).content == raw
        alias = (
            await client.get("/api/asset-catalog/alias", params={"url": "/uploads/asset/stock/US/old.svg"})
        ).json()
        assert alias["imageUrl"] == path
        keys = json.dumps([{"type": "stock", "market": "US", "code": "DEMO.OQ"}])
        lookup = (await client.get("/api/v1/assets/lookup", params={"keys": keys})).json()["data"]
        assert len(lookup) == 1 and lookup[0]["price"] is None
        logged = await client.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert logged.status_code == 200, logged.text
        client.headers["x-csrf-token"] = logged.json()["csrf"]
        assert (await client.get(P + "/operations/" + result["requestId"])).json() == result
        assert (await client.get(P + "/operations/" + closed)).json()["state"] == "closed"


async def test_management_tombstone_original_uuid_and_events_survive_real_encrypted_restore(
    bc, backup_app, configured
):
    from test_asset_catalog_management import PATH, command

    material, _ = await upload(bc, raw=SVG, name="managed.svg", folder="stock", market="US", code="DEMO")
    assert material.status_code == 200
    data = command(imageVersion=material.json()["version"])
    first = await bc.post(PATH, json=data)
    assert first.status_code == 200, first.text
    original = first.json()
    other_data = command(1, code="OTHER", name="Synthetic Other", imageVersion=material.json()["version"])
    other = (await bc.post(PATH, json=other_data)).json()
    removed_id = str(uuid4())
    assert (
        await bc.delete(
            PATH + "/" + other["asset"]["id"] + "?requestId=" + removed_id + "&expectedRevision=2"
        )
    ).status_code == 200
    capsule, _ = await support.create_capsule(bc, backup_app, configured)
    preview = await bc.get(
        "/api/backups/" + capsule + "/restore-preview", params={"target_id": "isolated-qa"}
    )
    assert preview.status_code == 200, preview.text
    job, _ = await support.submit(
        bc,
        "backup.restore",
        backup_id=capsule,
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
        logged = await client.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert logged.status_code == 200
        client.headers["x-csrf-token"] = logged.json()["csrf"]
        assert (await client.post(PATH, json=data)).json() == original
        assert (await client.get(PATH)).json()["assets"][0]["id"] == original["asset"]["id"]
        deleted = (await client.get(PATH + "?deleted=1")).json()
        assert [row["id"] for row in deleted["assets"]] == [other["asset"]["id"]]
        assert (await client.get(P + "/operations/" + removed_id)).json()["deleted"] is True
        assert (await client.get(original["asset"]["imageUrl"])).status_code == 200
        assert (await client.get(other["asset"]["imageUrl"])).status_code == 404
        async with app.state.db.connection() as conn:
            assert (
                await (
                    await conn.execute("SELECT count(*) n FROM asset_catalog_management_events")
                ).fetchone()
            )["n"] == 3
            assert (
                await (await conn.execute("SELECT restored_at FROM asset_catalog_tombstones")).fetchone()
            )["restored_at"] is None
        restored = await client.post(
            PATH, json={**other_data, "requestId": str(uuid4()), "expectedRevision": 3, "restore": True}
        )
        assert restored.status_code == 200, restored.text
        assert (await client.get(other["asset"]["imageUrl"])).status_code == 200
