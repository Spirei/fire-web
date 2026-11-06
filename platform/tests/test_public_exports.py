import json

from alcor_api.cli import main
from alcor_api.connections import Vault
from alcor_api.db import Database


def test_openapi_export_ignores_inherited_runtime_credentials(tmp_path, monkeypatch):
    directory = tmp_path / "runtime-secret"
    directory.mkdir(mode=0o700)
    (directory / "bootstrap-None.enc").write_text("Must never be read by an export")
    monkeypatch.setenv("ALCOR_CONNECTION_SECRET_DIR", str(directory))
    monkeypatch.setenv("ALCOR_DATABASE_URL", "postgresql://unused.invalid/not_a_test_database")
    monkeypatch.setenv("ALCOR_INSTANCE_ID", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
    for key in (
        "ALCOR_ASSET_ROOT", "ALCOR_LEGACY_SOURCE_REGISTRY_PATH",
        "ALCOR_RESOURCE_IMPORT_REGISTRY_PATH", "ALCOR_WATCH_GROUP_IMPORT_REGISTRY_PATH",
        "ALCOR_ATTACHMENT_IMPORT_REGISTRY_PATH",
    ):
        monkeypatch.setenv(key, str(directory / "must-not-read"))

    def forbidden(*args, **kwargs):
        raise AssertionError("Public export accessed runtime storage")

    from alcor_api.config import Settings
    original = Settings
    def export_settings(**kwargs):
        value = original(**kwargs)
        assert value.asset_root is None
        assert value.legacy_source_registry_path is None
        assert value.resource_import_registry_path is None
        assert value.watch_group_import_registry_path is None
        assert value.attachment_import_registry_path is None
        return value
    monkeypatch.setattr("alcor_api.cli.Settings", export_settings)
    monkeypatch.setattr(Vault, "key", forbidden)
    monkeypatch.setattr(Database, "open", forbidden)
    output = tmp_path / "schema.json"
    monkeypatch.setattr("sys.argv", ["alcor", "export-openapi", "--output", str(output)])
    main()
    assert "/api/account/password" in json.loads(output.read_text())["paths"]
