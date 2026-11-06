import json

import pytest
from alcor_api.operational_source_registry import load_operational_sources
from alcor_api.source_snapshot import SourceMismatch
from source_window_fixture import active_window


@pytest.fixture
async def enrollment(settings, tmp_path):
    private = (tmp_path / "private").resolve()
    private.mkdir(mode=0o700)
    root = (tmp_path / "old-project").resolve()
    root.mkdir(mode=0o700)
    ledger = root / "ledger.identity"
    ledger.write_bytes(b"Synthetic non-business identity fixture")
    log = root / "request-logs.retired"
    log.write_bytes(b"Synthetic operational identity fixture")
    legacy = {
        "version": 2,
        "platformInstance": str(settings.instance_id),
        "sources": [
            {
                "alias": "synthetic-ops",
                "instance": "synthetic-old-instance",
                "kind": "postgres",
                "owners": ["explicit-global-operator"],
                "timezone": "Asia/Shanghai",
                "schemaHash": "a" * 64,
                "locator": "postgresql://readonly@source.example.invalid/ledger",
                "expectedDatabase": "ledger",
                "expectedDataDirectory": str(root / "pg"),
                "expectedRole": "readonly",
                "expectedFileIdentity": None,
                "expectedDatasetIdentity": None,
                "migrationWindow": active_window().document(),
            }
        ],
    }
    original = private / "legacy.json"
    original.write_text(json.dumps(legacy))
    original.chmod(0o600)
    settings.legacy_source_registry_path = original
    item = {
        "sourceAlias": "synthetic-ops",
        "sourceOwner": "explicit-global-operator",
        "scopes": ["global-api-documents", "global-request-history"],
        "root": str(root),
        "rootIdentity": [root.stat().st_dev, root.stat().st_ino],
        "logIdentity": [log.stat().st_dev, log.stat().st_ino],
        "globalReadConfirmed": True,
    }
    config = {"version": 1, "platformInstance": str(settings.instance_id), "sources": [item]}
    registration = private / "operational.json"
    registration.write_text(json.dumps(config))
    registration.chmod(0o600)
    settings.operational_source_registry_path = registration
    return registration, config, original, legacy


async def test_operator_global_scope_is_explicit_not_extended_from_owner_financial_registry(
    settings, enrollment
):
    registration, config, _, _ = enrollment
    source = load_operational_sources(settings)["synthetic-ops"]
    source.require_access("global-api-documents")
    source.require_access("global-api-documents")
    assert source.root.is_absolute() and len(source.binding) == 64 and len(source.physical) == 64
    config["sources"][0]["globalReadConfirmed"] = False
    registration.write_text(json.dumps(config))
    with pytest.raises(SourceMismatch):
        load_operational_sources(settings)
    # Captured old object cannot continue reading after operator revocation.
    with pytest.raises(SourceMismatch):
        source.require_access("global-api-documents")


async def test_scope_and_window_revocation_live_root_identity_and_no_locators_in_error(settings, enrollment):
    registration, config, original, legacy = enrollment
    config["sources"][0]["scopes"] = ["global-api-documents"]
    config["sources"][0]["logIdentity"] = None
    registration.write_text(json.dumps(config))
    source = load_operational_sources(settings)["synthetic-ops"]
    with pytest.raises(SourceMismatch):
        source.require_access("global-request-history")
    source.require_access("global-api-documents")
    legacy["sources"][0]["migrationWindow"]["state"] = "revoked"
    original.write_text(json.dumps(legacy))
    with pytest.raises(SourceMismatch) as failure:
        source.require_access("global-api-documents")
    assert str(source.root) not in str(failure.value)
    assert "synthetic-ops" not in str(failure.value)


async def test_private_registry_and_source_symlink_replacements_are_rejected(settings, enrollment, tmp_path):
    registration, _config, _, _ = enrollment
    registration.chmod(0o644)
    with pytest.raises(SourceMismatch):
        load_operational_sources(settings)
    registration.chmod(0o600)
    source = load_operational_sources(settings)["synthetic-ops"]
    prior = source.root
    moved = prior.with_name("moved-project")
    prior.rename(moved)
    prior.mkdir(mode=0o700)
    with pytest.raises(SourceMismatch):
        source.require_access("global-api-documents")
    prior.rmdir()
    prior.symlink_to(moved, target_is_directory=True)
    with pytest.raises(SourceMismatch):
        source.require_access("global-api-documents")
