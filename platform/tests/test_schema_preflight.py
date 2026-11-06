from alcor_api.schema_preflight import compare


def test_missing_changed_and_newer_database_are_distinct():
    assert compare({"a": "1", "b": "2"}, {"a": "0", "c": "3"}) == {
        "compatible": False, "missing": ["b"], "changed": ["a"], "extra": ["c"]}
    assert compare({"a": "1"}, {"a": "1"})["compatible"]
    assert not compare({}, {})["compatible"]




async def test_preflight_checks_real_isolated_database_without_applying_missing_migration(settings, tmp_path):
    import psycopg
    from alcor_api.schema_preflight import check
    assert (await check(settings))["compatible"]
    migration_dir = tmp_path / "candidate-migrations"
    migration_dir.mkdir()
    for path in settings.migration_dir.glob("[0-9]*.sql"):
        (migration_dir / path.name).write_bytes(path.read_bytes())
    (migration_dir / "9999_synthetic_pending.sql").write_text("CREATE TABLE must_not_exist(id int);")
    candidate = settings.model_copy(update={"migration_dir": migration_dir})
    result = await check(candidate)
    assert result["missing"] == ["9999_synthetic_pending.sql"]
    assert not result["compatible"]
    with psycopg.connect(settings.database_url.get_secret_value()) as conn:
        assert conn.execute("SELECT to_regclass('public.must_not_exist')").fetchone()[0] is None


def test_removed_database_inspection_preserves_connection_configuration_routes():
    from alcor_api.main import create_app
    paths = create_app().openapi()["paths"]
    assert "/api/connections/postgresql/inspect" not in paths
    assert "/api/connections/{kind}" in paths
    assert "/api/connections/{kind}/test" in paths


async def test_preflight_rejects_wrong_instance_before_reporting_compatibility(settings):
    from uuid import uuid4
    import pytest
    from alcor_api.db import TargetMismatch
    from alcor_api.schema_preflight import check
    with pytest.raises(TargetMismatch):
        await check(settings.model_copy(update={"instance_id": uuid4()}))


async def test_platform_profile_read_behind_proxy_preserves_origin_and_session_guards(client, admin):
    result = await client.get("/api/account/personal-profile", headers={"host": "proxy.internal"})
    assert result.status_code == 200, result.text
    rejected = await client.get("/api/account/personal-profile", headers={"origin": "https://foreign.invalid", "sec-fetch-site": "cross-site"})
    assert rejected.status_code == 403
    rejected = await client.patch("/api/account/personal-profile", headers={"origin": "https://foreign.invalid"}, json={})
    assert rejected.status_code == 403


async def test_broker_classification_preserves_asset_identity_and_replays_original_receipt(client, admin):
    from uuid import uuid4
    path = "/api/admin/asset-catalog/entries"
    created = await client.post(path, json={"requestId": str(uuid4()), "expectedRevision": 0, "publicMetadataConfirmed": True, "restore": False, "asset": {"type": "broker", "market": "OTHER", "code": "SYNTH", "name": "Synthetic broker"}})
    assert created.status_code == 200, created.text
    first = created.json()
    aid = first["asset"]["id"]
    payload = {"requestId": str(uuid4()), "expectedRevision": first["revision"], "publicMetadataConfirmed": True, "restore": False, "asset": {"id": aid, "name": "Synthetic broker", "brokerMarkets": ["US", "HK"]}}
    saved = await client.put(path + "/" + aid, json=payload)
    assert saved.status_code == 200, saved.text
    assert saved.json()["asset"]["id"] == aid
    assert saved.json()["asset"]["market"] == "OTHER"
    assert saved.json()["asset"]["brokerMarkets"] == ["US", "HK"]
    replay = await client.put(path + "/" + aid, json=payload)
    assert replay.json() == saved.json()


def test_proxy_origin_exception_requires_exact_web_session_binding():
    from starlette.requests import Request
    from types import SimpleNamespace
    import pytest
    from alcor_api.security import COOKIE, csrf_token
    from alcor_api.legacy_identity import assert_native_origin, LegacyError
    settings = SimpleNamespace(public_origin="https://public.example.invalid", trusted_proxy_ips=[])
    def request(extra):
        headers = [(b"host", b"proxy.internal"), (b"cookie", (COOKIE + "=synthetic-only").encode())] + extra
        return Request({"type":"http", "method":"GET", "scheme":"http", "path":"/api/account/resource-library", "headers":headers, "query_string":b"", "server":("proxy.internal",80)})
    with pytest.raises(LegacyError): assert_native_origin(request([]), settings)
    with pytest.raises(LegacyError): assert_native_origin(request([(b"x-csrf-token",b"wrong")]), settings)
    with pytest.raises(LegacyError): assert_native_origin(request([(b"x-csrf-token",bytes([233]) * 64)]), settings)
    bound=[(b"x-csrf-token", csrf_token("synthetic-only").encode())]
    assert_native_origin(request(bound), settings)
    settings.trusted_proxy_ips = ["192.0.2.10"]
    with pytest.raises(LegacyError): assert_native_origin(request(bound), settings)
    settings.trusted_proxy_ips = []
    with pytest.raises(LegacyError): assert_native_origin(request(bound + [(b"sec-fetch-site",b"cross-site")]), settings)
    with pytest.raises(LegacyError): assert_native_origin(request(bound + [(b"authorization",b"Bearer synthetic")]), settings)


async def test_simple_ledger_web_read_works_behind_proxy_and_cross_site_stays_denied(client, admin):
    response = await client.get("/api/account/simple-ledger", headers={"host": "proxy.internal"})
    assert response.status_code == 200, response.text
    denied = await client.get("/api/account/simple-ledger", headers={"sec-fetch-site": "cross-site", "origin": "https://foreign.invalid"})
    assert denied.status_code == 403


def test_saved_bootstrap_is_read_without_creating_or_rotating_credentials(tmp_path):
    from uuid import uuid4
    from alcor_api.config import Settings
    from alcor_api.connection_models import PostgresConfig
    from alcor_api.connections import Vault, bootstrap_settings
    from psycopg.conninfo import conninfo_to_dict

    tmp_path.chmod(0o700)
    instance = uuid4()
    settings = Settings(_env_file=None, database_url="postgresql://synthetic@db.example.invalid/synthetic",
        instance_id=instance, environment="test", connection_secret_dir=tmp_path)
    vault = Vault(tmp_path)
    config = PostgresConfig(host="db.example.invalid", database="synthetic", username="synthetic")
    vault.write_bootstrap(config, "synthetic-password", "192.0.2.1", uuid4(), instance)
    (tmp_path / "connections.lock").unlink()
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    runtime, revision = bootstrap_settings(settings, read_only=True)
    assert revision is not None
    assert conninfo_to_dict(runtime.database_url.get_secret_value())["password"] == "synthetic-password"
    assert {p.name: p.read_bytes() for p in tmp_path.iterdir()} == before


def test_read_only_vault_does_not_initialize_a_missing_key(tmp_path):
    import pytest
    from alcor_api.connections import Vault
    tmp_path.chmod(0o700)
    with pytest.raises(FileNotFoundError):
        Vault(tmp_path, read_only=True).key()
    assert not list(tmp_path.iterdir())


def test_schema_preflight_cli_preserves_fail_closed_exit_code(monkeypatch, capsys):
    import json
    import pytest
    from alcor_api import cli, schema_preflight
    for compatible in (True, False):
        result = {"compatible": compatible, "missing": [] if compatible else ["9999_pending.sql"], "changed": [], "extra": []}
        async def checked(settings):
            return result
        monkeypatch.setattr(schema_preflight, "check", checked)
        monkeypatch.setattr(cli, "Settings", lambda: None)
        monkeypatch.setattr("sys.argv", ["alcor", "check-schema"])
        if compatible:
            cli.main()
        else:
            with pytest.raises(SystemExit) as stopped:
                cli.main()
            assert stopped.value.code == 2
        assert json.loads(capsys.readouterr().out) == result
