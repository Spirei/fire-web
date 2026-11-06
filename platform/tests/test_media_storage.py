import hashlib
import os

import pytest
from alcor_api.backups import BackupFailure, media_entries, private_read
from alcor_api.media_storage import valid_asset_name

P = "/api/media/assets/"


def assets(settings, tmp_path):
    settings.asset_root = tmp_path / "assets"
    settings.asset_root.mkdir(mode=0o700)
    path = settings.asset_root / "logo.svg"
    path.write_bytes(b"<svg>synthetic</svg>")
    path.chmod(0o600)
    return path


async def test_assets_are_admin_only_attachments_without_public_static_access(
    client, admin, settings, tmp_path
):
    path = assets(settings, tmp_path)
    result = await client.get(P + path.name)
    assert result.status_code == 200 and result.content == path.read_bytes()
    assert result.headers["content-type"] == "application/octet-stream"
    assert result.headers["content-disposition"] == 'attachment; filename="logo.svg"'
    assert result.headers["cache-control"] == "no-store"
    client.cookies.clear()
    assert (await client.get(P + path.name)).status_code == 401
    registered = await client.post(
        "/api/session/register", json={"username": "MediaMember", "password": "SyntheticMediaPass9"}
    )
    assert registered.status_code == 201
    assert (await client.get(P + path.name)).status_code == 403


async def test_assets_reject_symlinks_missing_paths_and_unsafe_names(client, admin, settings, tmp_path):
    assets(settings, tmp_path)
    outside = tmp_path / "private.key"
    outside.write_bytes(b"SyntheticPrivateOnly")
    outside.chmod(0o600)
    (settings.asset_root / "leak.key").symlink_to(outside)
    assert (await client.get(P + "leak.key")).status_code == 404
    assert (await client.get(P + "missing.png")).status_code == 404
    for name in ["../secret", ".env", "x/y", "x\\y", "logo..png"]:
        assert not valid_asset_name(name)
    assert (await client.get("/media/assets/logo.svg")).status_code == 404


def test_assets_and_existing_immutable_files_share_a_bounded_backup(settings, tmp_path):
    asset = assets(settings, tmp_path)
    settings.file_root = tmp_path / "files"
    settings.file_root.mkdir(mode=0o700)
    body = b"Synthetic immutable file"
    digest = hashlib.sha256(body).hexdigest()
    file = settings.file_root / digest
    file.write_bytes(body)
    file.chmod(0o600)
    entries = media_entries(settings)
    assert entries == {"files/" + digest: body, "assets/logo.svg": asset.read_bytes()}
    settings.backup_max_bytes = 10
    with pytest.raises(BackupFailure):
        media_entries(settings)


def test_nonregular_asset_files_cannot_block_reading(settings, tmp_path):
    assets(settings, tmp_path)
    fifo = settings.asset_root / "pipe"
    os.mkfifo(fifo, 0o600)
    with pytest.raises(BackupFailure):
        private_read(fifo, 1024)


def test_changing_files_are_not_reported_as_consistent_backups(settings, tmp_path, monkeypatch):
    from types import SimpleNamespace

    path = assets(settings, tmp_path)
    original = os.fstat
    calls = 0

    def changing(fd):
        nonlocal calls
        info = original(fd)
        calls += 1
        if calls == 1:
            return info
        return SimpleNamespace(
            st_size=info.st_size, st_mtime_ns=info.st_mtime_ns + 1, st_ctime_ns=info.st_ctime_ns
        )

    monkeypatch.setattr(os, "fstat", changing)
    with pytest.raises(BackupFailure, match="变化"):
        private_read(path, 1024)
