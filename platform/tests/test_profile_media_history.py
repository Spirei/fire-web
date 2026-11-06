"""Digest-bound background history stays truthful across replacement, clearing and restore."""

import hashlib
import io
from uuid import UUID, uuid4

import httpx
import pytest
import test_backups as backup_tests
from alcor_api.main import create_app
from alcor_api.profile_media import ProfileMedia
from PIL import Image
from profile_test_support import private_profile_files  # noqa: F401 -- pytest autouse fixture
from test_legacy_devices import bearer, grant

configured = backup_tests.configured
backup_app = backup_tests.backup_app
bc = backup_tests.bc

P = "/api/account/personal-profile"


def jpeg(color):
    stream = io.BytesIO()
    Image.new("RGB", (32, 16), color).save(stream, format="JPEG")
    return stream.getvalue()


async def upload(client, revision, color):
    original = str(uuid4())
    response = await client.post(
        P + "/background",
        data={"requestId": original, "revision": str(revision)},
        files={"file": ("background.jpg", jpeg(color), "image/jpeg")},
    )
    assert response.status_code == 200, response.text
    value = response.json()
    reference = value["data"]["background"]
    downloaded = await client.get(reference["path"])
    assert downloaded.status_code == 200, downloaded.text
    assert reference["sha256"] == hashlib.sha256(downloaded.content).hexdigest()
    return original, reference, downloaded.content


async def test_canonical_background_receipt_keeps_its_bytes_after_replacement_and_clear(client, admin, db):
    original, first, old_bytes = await upload(client, 0, "white")
    _later, second, new_bytes = await upload(client, 1, "black")
    assert first["sha256"] != second["sha256"] and old_bytes != new_bytes
    assert first["path"] == P + "/background?sha256=" + first["sha256"]
    latest = await client.get(P + "/background")
    assert latest.content == new_bytes
    receipt = await client.get(P + "/operations/" + original)
    assert receipt.status_code == 200 and receipt.json()["data"]["background"] == first
    reread = await client.get(receipt.json()["data"]["background"]["path"])
    assert reread.content == old_bytes
    removed = await client.patch(
        P, json={"requestId": str(uuid4()), "revision": 2, "changes": {"background": None}}
    )
    assert removed.status_code == 200, removed.text
    assert (await client.get(P + "/background")).status_code == 404
    assert (await client.get(first["path"])).content == old_bytes
    assert (await client.get(second["path"])).content == new_bytes
    native = await grant(db, admin, "portfolio.read")
    canonical = await client.get(
        "/api/client/personal-profile/operations/" + original, headers=bearer(native)
    )
    reference = canonical.json()["data"]["background"]
    assert reference["path"] == "/api/client/personal-profile/background?sha256=" + first["sha256"]
    assert (await client.get(reference["path"], headers=bearer(native))).content == old_bytes


@pytest.mark.parametrize("version", [1, 2])
async def test_legacy_background_paths_stay_exact_bare_discovery_values(client, admin, db, version):
    original, reference, content = await upload(client, 0, "white")
    native = await grant(db, admin, "portfolio.read")
    path = f"/api/v{version}/personal-profile"
    current = await client.get(path, headers=bearer(native))
    old = await client.get(path + "/operations/" + original, headers=bearer(native))
    config = await client.get(f"/api/v{version}/auth/config")
    bare = config.json()["data"]["personal_profile"]["background_path"]
    assert current.json()["data"]["background"]["path"] == bare == path + "/background"
    assert old.json()["data"]["data"]["background"]["path"] == bare
    assert (await client.get(bare, headers=bearer(native))).content == content
    # Additive query support does not change the legacy DTO or require old clients to use it.
    assert (
        await client.get(bare + "?sha256=" + reference["sha256"], headers=bearer(native))
    ).content == content


async def test_digest_query_is_strict_owner_bound_and_never_falls_back_to_latest(client, admin, db, settings):
    _original, first, old_bytes = await upload(client, 0, "white")
    _later, second, new_bytes = await upload(client, 1, "black")
    sha = first["sha256"]
    for suffix in (
        "?sha256=",
        "?sha256=" + sha.upper(),
        "?sha256=" + sha + "&sha256=" + sha,
        "?sha256=" + sha + "&other=1",
        "?other=1",
        "?sha256=../escape",
    ):
        result = await client.get(P + "/background" + suffix)
        assert result.status_code == 400, (suffix, result.text)
    assert (await client.get(P + "?sha256=" + sha)).status_code == 400
    assert (await client.get(P + "/operations/" + str(uuid4()) + "?sha256=" + sha)).status_code == 400
    assert (await client.get(P + "/background?sha256=" + "0" * 64)).status_code == 404
    from alcor_api.cli import create_user

    other = await create_user(settings, "OtherHistory", "Synthetic9Pass", role="user")
    pair = await grant(db, other, "portfolio.read")
    result = await client.get("/api/client/personal-profile/background?sha256=" + sha, headers=bearer(pair))
    assert result.status_code == 404
    async with db.connection() as conn, conn.transaction():
        media_id, gif_sha = await ProfileMedia(settings).stage(
            conn, admin, b"GIF89a" + bytes(32), "image/gif"
        )
    assert (await client.get(P + "/background?sha256=" + gif_sha)).status_code == 404
    async with db.connection() as conn:
        first_object = await (
            await conn.execute(
                "SELECT id FROM profile_media_objects WHERE owner_id=%s AND sha256=%s", (admin, sha)
            )
        ).fetchone()
    (settings.file_root / "profile-media" / str(first_object["id"])).write_bytes(b"synthetic corruption")
    assert (await client.get(first["path"])).status_code == 503
    assert (await client.get(second["path"])).content == new_bytes
    assert (await client.get(P + "/background")).content == new_bytes
    assert old_bytes != new_bytes and media_id


async def test_actual_restore_retains_prior_background_receipts_and_digest_bytes(bc, backup_app, configured):
    original, first, old_bytes = await upload(bc, 0, "white")
    later, second, new_bytes = await upload(bc, 1, "black")
    result = await bc.patch(
        P, json={"requestId": str(uuid4()), "revision": 2, "changes": {"background": None}}
    )
    assert result.status_code == 200, result.text
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
    recovered_settings = configured.model_copy(
        update={
            "database_url": target.database_url,
            "instance_id": target.instance_id,
            "environment": "test",
            "redis_url": None,
            "file_root": target.recovery_directory / "files",
            "connection_secret_dir": target.recovery_directory / "connection-secrets",
        }
    )
    recovered = create_app(recovered_settings)
    async with (
        recovered.router.lifespan_context(recovered),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=recovered, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as client,
    ):
        signed = await client.post(
            "/api/session/login", json={"login": "BackupQA", "password": "Synthetic9Pass"}
        )
        assert signed.status_code == 200, signed.text
        for rid, reference, content in ((original, first, old_bytes), (later, second, new_bytes)):
            receipt = await client.get(P + "/operations/" + rid)
            assert receipt.status_code == 200, receipt.text
            assert receipt.json()["data"]["background"] == reference
            image = await client.get(reference["path"])
            assert image.status_code == 200 and image.content == content
            assert hashlib.sha256(image.content).hexdigest() == reference["sha256"]
        assert (await client.get(P + "/background")).status_code == 404
