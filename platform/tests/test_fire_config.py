from pathlib import Path

import pytest
from alcor_api.fire_config import load_fire_settings
from pydantic import ValidationError


@pytest.fixture
def fire_env(monkeypatch):
    import os

    for key in list(os.environ):
        if key.startswith(("FIRE_", "ALCOR_")) or key == "GHCR_IMAGE":
            monkeypatch.delenv(key, raising=False)
    values = {
        "FIRE_DATABASE_URL": "postgresql://synthetic:SyntheticDbSecret9@database.example.invalid/owned",
        "FIRE_INSTANCE_ID": "00000000-0000-0000-0000-000000000123",
        "FIRE_ENVIRONMENT": "staging",
        "FIRE_PUBLIC_ORIGIN": "https://fire.example.invalid",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    return values


def test_current_fire_configuration_does_not_inherit_independent_api(fire_env, monkeypatch, tmp_path):
    monkeypatch.setenv("ALCOR_DATABASE_URL", "postgresql://wrong@other.invalid/other")
    monkeypatch.setenv("ALCOR_POOL_SIZE", "19")
    monkeypatch.setenv("ALCOR_PG_TOOLS_DIR", "/wrong-independent-api-tools")
    monkeypatch.setenv("FIRE_PG_TOOLS_DIR", str(tmp_path))
    monkeypatch.setenv("FIRE_POOL_SIZE", "7")
    monkeypatch.setenv("FIRE_LEASE_SECONDS", "45")
    monkeypatch.setenv("FIRE_MAIL_PASSWORD", "")
    settings = load_fire_settings()
    assert settings.connections_from_environment is True
    from alcor_api.config import ROOT
    assert settings.public_upload_root == ROOT.parent / "public" / "uploads"
    assert settings.deployment_checks_workflow == "docker-publish.yml"
    assert settings.pool_size == 7 and settings.lease_seconds == 45
    assert settings.pg_tools_dir == tmp_path
    assert settings.database_url.get_secret_value() == fire_env["FIRE_DATABASE_URL"]
    assert settings.mail_password is None


def test_current_fire_upload_root_can_use_explicit_operator_directory(fire_env, monkeypatch, tmp_path):
    monkeypatch.setenv("FIRE_PUBLIC_UPLOAD_ROOT", str(tmp_path))
    assert load_fire_settings().public_upload_root == tmp_path


def test_uuid_required_zero_rejected_and_secret_values_hidden(fire_env, monkeypatch):
    monkeypatch.delenv("FIRE_INSTANCE_ID")
    with pytest.raises(ValueError, match="FIRE_INSTANCE_ID"):
        load_fire_settings()
    monkeypatch.setenv("FIRE_INSTANCE_ID", "00000000-0000-0000-0000-000000000000")
    with pytest.raises(ValidationError) as error:
        load_fire_settings()
    assert "SyntheticDbSecret9" not in str(error.value)


def test_production_setup_token_uses_fire_env_and_never_independent_api(fire_env, monkeypatch):
    monkeypatch.setenv("ALCOR_REGISTRATION_SETUP_TOKEN", "IndependentApiOnlySecret")
    assert load_fire_settings().registration_setup_token is None
    monkeypatch.setenv("FIRE_SETUP_TOKEN", "")
    assert load_fire_settings().registration_setup_token is None
    monkeypatch.setenv("FIRE_ENVIRONMENT", "production")
    monkeypatch.setenv("FIRE_SETUP_TOKEN", "SyntheticProductionInstallSecret123")
    settings = load_fire_settings()
    assert settings.environment == "production"
    assert settings.registration_setup_token.get_secret_value() == "SyntheticProductionInstallSecret123"
    monkeypatch.setenv("FIRE_REGISTRATION_SETUP_TOKEN", "")
    assert load_fire_settings().registration_setup_token.get_secret_value() == "SyntheticProductionInstallSecret123"
    monkeypatch.setenv("FIRE_REGISTRATION_SETUP_TOKEN", "SyntheticProductionInstallSecret123")
    assert load_fire_settings().registration_setup_token.get_secret_value() == "SyntheticProductionInstallSecret123"
    monkeypatch.setenv("FIRE_REGISTRATION_SETUP_TOKEN", "ConflictingInstallSecret123")
    with pytest.raises(ValueError, match="配置重复") as error:
        load_fire_settings()
    assert "SyntheticProductionInstallSecret123" not in str(error.value)
    assert "ConflictingInstallSecret123" not in str(error.value)


def test_compose_updater_and_image_use_fire_configuration(fire_env, monkeypatch):
    monkeypatch.setenv("GHCR_IMAGE", "ghcr.io/example/fire-web")
    monkeypatch.setenv("FIRE_DEPLOYMENT_UPDATER_URL", "http://fire-updater:8080/v1/update")
    monkeypatch.setenv("FIRE_DEPLOYMENT_RUNNER_TOKEN", "SyntheticUpdaterTokenForOnlyTests9")
    settings = load_fire_settings()
    assert settings.deployment_repository == "example/fire-web"
    assert settings.deployment_image == "ghcr.io/example/fire-web"
    assert settings.deployment_updater_url == "http://fire-updater:8080/v1/update"


@pytest.mark.parametrize(
    "dsn",
    [
        "postgresql:///owned",
        "postgresql://database.example.invalid/owned",
        "service=ambient",
        "postgresql://user:HiddenPassword@database.example.invalid",
    ],
)
def test_implicit_database_target_is_rejected_without_echoing_credentials(fire_env, monkeypatch, dsn):
    monkeypatch.setenv("FIRE_DATABASE_URL", dsn)
    with pytest.raises(ValueError) as error:
        load_fire_settings()
    assert "HiddenPassword" not in str(error.value)


def test_template_keys_are_supported_and_instance_identity_is_explicit():
    import yaml
    from alcor_api.config import Settings

    root = Path(__file__).parents[2]
    env = {
        line.split("=", 1)[0]
        for line in (root / ".env.example").read_text().splitlines()
        if line and not line.startswith("#")
    }
    runtime = {"FIRE_PYTHON", "FIRE_WORKER", "FIRE_NETWORK", "FIRE_PRIVATE_DIR", "FIRE_SETUP_TOKEN"}
    assert {key for key in env if key.startswith("FIRE_")} <= runtime | {
        "FIRE_" + key.upper() for key in Settings.model_fields
    }
    compose = yaml.safe_load((root / "docker-compose.ghcr.yml").read_text())
    conf = compose["services"]["fire"]["environment"]
    assert conf["FIRE_INSTANCE_ID"].startswith("${FIRE_INSTANCE_ID:?")
    for key in ["FIRE_FILE_ROOT", "FIRE_BACKUP_DIR", "FIRE_BACKUP_SECRET_DIR", "FIRE_CONNECTION_SECRET_DIR"]:
        assert conf[key].startswith("/private/")
    assert conf["FIRE_PYTHON"] == "/platform/.venv/bin/python"


def test_copied_template_loads_after_filling_actual_required_values(fire_env, monkeypatch):
    from dotenv import dotenv_values

    root = Path(__file__).parents[2]
    for key, value in dotenv_values(root / ".env.example").items():
        monkeypatch.setenv(key, value or "")
    for key, value in fire_env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("FIRE_CONNECTIONS_FROM_ENVIRONMENT", "false")
    settings = load_fire_settings()
    assert settings.connections_from_environment is True
    assert not settings.mail_enabled and settings.redis_url is None
    assert settings.deployment_image == "ghcr.io/replace-owner/fire-web"
