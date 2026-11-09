"""Exercise the actual legacy-Web backup surface with isolated PostgreSQL originals."""
import hashlib
from uuid import UUID, uuid4

import httpx
from test_backups import configured, backup_app, execute
from test_fire_web import fire_login
from alcor_api.cli import create_user
from alcor_api.worker import heartbeat


async def test_fire_prepare_create_download_verify_and_lost_key(backup_app, configured):
    await create_user(configured, "BackupFlow", "Synthetic9Pass")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=backup_app), base_url="http://testserver", headers={"origin":"http://testserver"}) as client:
        await fire_login(client, "BackupFlow")
        before = (await client.get("/api/fire/backups")).json()
        assert before["worker_available"] is False and before["key_error"] is None
        assert not configured.backup_secret_dir.exists()
        await heartbeat(backup_app.state.db, uuid4())
        assert (await client.get("/api/fire/backups")).json()["worker_available"] is True
        prepared = await client.post("/api/fire/backups/prepare")
        assert prepared.status_code == 200, prepared.text
        key = (configured.backup_secret_dir / "backup.key").read_bytes()
        assert prepared.json()["key_fingerprint"] == hashlib.sha256(key).hexdigest()
        assert (await client.post("/api/fire/backups/prepare")).json() == prepared.json()
        for kind in ["backup.create", "backup.verify"]:
            payload = {"request_id":str(uuid4()), "kind":kind}
            if kind == "backup.verify": payload["backup_id"] = backup["id"]
            response = await client.post("/api/fire/tasks", json=payload)
            assert response.status_code == 202, response.text
            assert (await client.post("/api/fire/tasks", json=payload)).json()["id"] == response.json()["id"]
            await execute(backup_app, configured, UUID(response.json()["id"]))
            receipt = await client.get("/api/fire/tasks/receipts/" + payload["request_id"])
            assert receipt.json()["status"] == "succeeded"
            backup = (await client.get("/api/fire/backups")).json()["items"][0]
        assert backup["verified_at"]
        download = await client.get("/api/fire/backups/" + backup["id"] + "/download")
        assert download.status_code == 200
        assert hashlib.sha256(download.content).hexdigest() == backup["sha256"]
        # Losing a key must never turn the preparation button into destructive key replacement.
        (configured.backup_secret_dir / "backup.key").unlink()
        missing = (await client.get("/api/fire/backups")).json()
        assert missing["key_fingerprint"] is None and "找回原" in missing["key_error"]
        blocked = await client.post("/api/fire/backups/prepare")
        assert blocked.status_code == 422 and "找回原" in blocked.text
        assert not (configured.backup_secret_dir / "backup.key").exists()


async def test_fire_corrupt_key_is_reported_without_replacement(backup_app, configured):
    await create_user(configured, "BackupCorrupt", "Synthetic9Pass")
    configured.backup_secret_dir.mkdir(mode=0o700)
    key = configured.backup_secret_dir / "backup.key"
    key.write_bytes(b"invalid-recovery-key")
    key.chmod(0o600)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=backup_app), base_url="http://testserver", headers={"origin":"http://testserver"}) as client:
        await fire_login(client, "BackupCorrupt")
        assert (await client.get("/api/fire/backups")).json()["key_error"]
        assert (await client.post("/api/fire/backups/prepare")).status_code == 422
        assert key.read_bytes() == b"invalid-recovery-key"
