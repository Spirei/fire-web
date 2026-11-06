import hashlib
import json

import pytest_asyncio
from font_fixtures import font_bytes
from legacy_source.conftest import admin, app, client, old_pg
from legacy_source.conftest import settings as base_settings

__all__ = ["admin", "app", "base_settings", "client", "old_pg"]


@pytest_asyncio.fixture
async def settings(base_settings, old_pg, tmp_path):
    doc = json.loads(base_settings.legacy_source_registry_path.read_bytes())
    doc["sources"][0]["expectedFileIdentity"] = old_pg.expected_file_identity
    doc["sources"][0]["expectedDataDirectory"] = (
        str(old_pg.expected_data_directory) if old_pg.expected_data_directory else None
    )
    base_settings.legacy_source_registry_path.write_text(json.dumps(doc))
    base_settings.file_root = tmp_path / "platform-files"
    root = tmp_path / "synthetic-old-fonts"
    root.mkdir(mode=0o700)
    raw = font_bytes()
    identifier = "custom-783-" + hashlib.sha256(raw).hexdigest() + ".ttf"
    (root / identifier).write_bytes(raw)
    (root / identifier).chmod(0o444)
    (root / (identifier + ".json")).write_text(json.dumps({"name": "Legacy Explicit Name"}))
    directory = tmp_path / "font-registry"
    directory.mkdir(mode=0o700)
    file = directory / "fonts.json"
    file.write_text(
        json.dumps(
            {
                "version": 1,
                "platformInstance": str(base_settings.instance_id),
                "roots": [
                    {
                        "sourceAlias": old_pg.alias,
                        "root": str(root),
                        "rootIdentity": [root.stat().st_dev, root.stat().st_ino],
                        "layout": "fire-web-custom-fonts-v1",
                        "ownerEvidencePolicy": "admin-and-owner-attested",
                    }
                ],
            }
        )
    )
    file.chmod(0o600)
    base_settings.font_import_registry_path = file
    yield base_settings


@pytest_asyncio.fixture
async def source_file(settings):
    root = __import__("pathlib").Path(
        json.loads(settings.font_import_registry_path.read_bytes())["roots"][0]["root"]
    )
    path = next(p for p in root.iterdir() if p.suffix == ".ttf")
    return root, path, path.read_bytes()
