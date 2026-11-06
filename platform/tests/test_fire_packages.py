import hashlib
from urllib.parse import quote
from uuid import UUID, uuid4

import httpx
import pytest
import pytest_asyncio
from alcor_api import backups
from alcor_api.cli import create_user
from alcor_api.main import create_app
from alcor_api.worker import claim, finish
from pgserver.postgres_server import POSTGRES_BIN_PATH
from test_fire_web import fire_login

RAW = b"PK\x03\x04synthetic APK container, not an installable signed package"


@pytest_asyncio.fixture
async def package_app(settings, tmp_path):
    settings.file_root = tmp_path / "originals"
    settings.file_root.mkdir(mode=0o700)
    settings.backup_dir = tmp_path / "backups"
    settings.backup_secret_dir = tmp_path / "backup-key"
    settings.pg_tools_dir = POSTGRES_BIN_PATH
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        yield app


@pytest_asyncio.fixture
async def package_client(package_app, settings):
    await create_user(settings, "FirePackages", "Synthetic9Pass")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=package_app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as client:
        await fire_login(client, "FirePackages")
        yield client


async def upload(client, raw=RAW, **headers):
    return await client.post(
        "/api/app-packages",
        content=raw,
        headers={
            "content-type": "application/octet-stream",
            "x-file-name": quote("测试版本.apk"),
            "x-alcor-request-id": str(uuid4()),
            **headers,
        },
    )


async def test_packages_pg_receipt_private_bytes_and_duplicate_uuid(package_client, package_app, settings):
    request_id = str(uuid4())
    a = await upload(package_client, **{"x-alcor-request-id": request_id})
    assert a.status_code == 201, a.text
    b = await upload(package_client, **{"x-alcor-request-id": request_id})
    assert a.json() == b.json()
    changed = await upload(package_client, raw=RAW + b"changed", **{"x-alcor-request-id": request_id})
    assert changed.status_code == 409
    rows = (await package_client.get("/api/app-packages")).json()["packages"]
    assert len(rows) == 1
    item = rows[0]
    assert item["sha256"] == hashlib.sha256(RAW).hexdigest()
    original = settings.file_root / item["sha256"]
    assert (
        original.read_bytes() == RAW
        and original.stat().st_mode & 0o777 == 0o600
        and original.stat().st_nlink == 1
    )
    reply = await package_client.get("/api/app-packages/download/" + item["id"])
    assert reply.content == RAW and reply.status_code == 200
    assert "no-store" in reply.headers["cache-control"]
    assert reply.headers["x-alcor-content-sha256"] == item["sha256"]
    async with package_app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM fire_app_packages")).fetchone())[
            "n"
        ] == 1
    assert not list((settings.file_root / "app-packages").iterdir())


async def test_packages_web_only_admin_csrf_and_origin(package_client, settings):
    client = package_client
    assert (
        await client.get("/api/app-packages", headers={"authorization": "Bearer fake"})
    ).status_code == 403
    csrf = client.headers.pop("x-csrf-token")
    assert (await upload(client)).status_code == 403
    client.headers["x-csrf-token"] = csrf
    assert (await upload(client, origin="https://untrusted.invalid")).status_code == 403
    await create_user(settings, "PackageMember", "Synthetic9Pass", role="user")
    await fire_login(client, "PackageMember")
    assert (await client.get("/api/app-packages")).status_code == 403
    assert (await upload(client)).status_code == 403
    client.cookies.clear()
    assert (await client.get("/api/app-packages")).status_code == 401


@pytest.mark.parametrize("name", ["../escape.apk", "bad%XX.apk", "%FF.apk", "%0Aevil.apk", "wrong.txt"])
async def test_packages_reject_unsafe_names(package_client, name):
    assert (await upload(package_client, **{"x-file-name": name})).status_code == 400


async def test_packages_stream_limits_magic_and_revocation(package_client, package_app, settings):
    assert (await upload(package_client, raw=b"not zip")).status_code == 400
    assert (await upload(package_client, **{"content-length": "4"})).status_code == 413
    assert (await upload(package_client, **{"content-length": str(len(RAW) + 1)})).status_code == 400

    async def revoked():
        yield RAW[:4]
        async with package_app.state.db.connection() as conn:
            await conn.execute("UPDATE users SET active=false WHERE username='FirePackages'")
        yield RAW[4:]

    response = await package_client.post(
        "/api/app-packages",
        content=revoked(),
        headers={
            "content-type": "application/octet-stream",
            "content-length": str(len(RAW)),
            "x-file-name": "test.apk",
            "x-alcor-request-id": str(uuid4()),
        },
    )
    assert response.status_code == 401, response.text
    assert not [p for p in settings.file_root.iterdir() if p.is_file()]
    assert not list((settings.file_root / "app-packages").iterdir())


async def test_packages_missing_or_tampered_original_never_downloads_or_backs_up(
    package_client, package_app, settings
):
    result = await upload(package_client)
    assert result.status_code == 201, result.text
    item = result.json()
    path = settings.file_root / item["sha256"]
    path.write_bytes(b"changed")
    assert (await package_client.get("/api/app-packages/download/" + item["id"])).status_code == 422
    from alcor_api.backup_stream_codec import StreamFailure
    from alcor_api.backup_stream_jobs import collect_sources

    async with package_app.state.db.connection() as conn, conn.transaction():
        with pytest.raises(StreamFailure):
            await collect_sources(conn, settings)


async def test_fire_backup_uses_same_authority_includes_packages_and_original_uuid(
    package_client, package_app, settings
):
    result = await upload(package_client)
    assert result.status_code == 201, result.text
    before = await package_client.get("/api/fire/backups")
    assert before.status_code == 200, before.text
    assert before.json()["key_fingerprint"] is None
    prepare = await package_client.post("/api/fire/backups/prepare")
    assert prepare.status_code == 200, prepare.text
    fingerprint = prepare.json()["key_fingerprint"]
    assert len(fingerprint) == 64
    assert (await package_client.post("/api/fire/backups/prepare")).json() == prepare.json()
    request_id = str(uuid4())
    body = {"request_id": request_id, "kind": "backup.create"}
    accepted = await package_client.post("/api/fire/tasks", json=body)
    assert accepted.status_code == 202, accepted.text
    assert (await package_client.post("/api/fire/tasks", json=body)).json()["id"] == accepted.json()["id"]
    task = await claim(package_app.state.db, uuid4())
    assert task["payload"]["_session_client"] == "legacy-web"
    summary = await backups.run_job(settings, package_app.state.db, task)
    assert await finish(package_app.state.db, task, summary)
    receipt = await package_client.get("/api/fire/tasks/receipts/" + request_id)
    assert receipt.json()["status"] == "succeeded"
    listing = await package_client.get("/api/fire/backups")
    backup = listing.json()["items"][0]
    assert listing.json()["key_fingerprint"] == fingerprint
    row = await backups.row_for(package_app.state.db, UUID(backup["id"]))
    _manifest, entries = backups.unpack(settings, row)
    assert "files/" + result.json()["sha256"] in entries
    if hasattr(entries, "close"):
        entries.close()
    download = await package_client.get("/api/fire/backups/" + backup["id"] + "/download")
    assert download.status_code == 200, download.text
    assert hashlib.sha256(download.content).hexdigest() == backup["sha256"]
