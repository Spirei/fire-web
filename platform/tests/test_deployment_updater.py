"""Core identity checks shared with the independent Watchtower bridge.

Notification transport, commit-before-wire and original-UUID replay coverage is
in test_deployment_watchtower_bridge.py; the retired executor has no wake API.
"""

from types import SimpleNamespace

import pytest
from alcor_api import __version__, deployments
from alcor_api.config import Settings


def runtime(tmp_path):
    (tmp_path / "0001_synthetic.sql").write_text("SELECT 1;\n")
    settings = SimpleNamespace(
        migration_dir=tmp_path,
        deployment_image="ghcr.io/synthetic/alcor-api",
        deployment_running_image="",
        source_revision="b" * 40,
    )
    release = deployments.Release(
        version=__version__,
        image=settings.deployment_image + "@sha256:" + "a" * 64,
        revision=settings.source_revision,
        schema_hash=deployments.schema_hash(settings.migration_dir),
    )
    return settings, release


def test_image_baked_identity_requires_a_commit_even_with_an_old_pinned_digest(tmp_path):
    settings, release = runtime(tmp_path)
    assert deployments.already_running(settings, release)
    settings.source_revision = ""
    assert not deployments.already_running(settings, release)
    settings.deployment_running_image = release.image
    assert not deployments.already_running(settings, release)
    assert not deployments.already_running(settings, None)


def test_stale_environment_digest_cannot_override_baked_commit(tmp_path):
    settings, release = runtime(tmp_path)
    settings.deployment_running_image = release.image
    settings.source_revision = "c" * 40
    assert not deployments.already_running(settings, release)
    settings.source_revision = release.revision
    settings.deployment_running_image = settings.deployment_image + "@sha256:" + "d" * 64
    assert deployments.already_running(settings, release)


@pytest.mark.parametrize("change", [
    {"version": "0.0.0"},
    {"schema_hash": "c" * 64},
    {"image": "ghcr.io/synthetic/other@sha256:" + "a" * 64},
])
def test_current_commit_alone_cannot_prove_another_release_is_running(tmp_path, change):
    settings, release = runtime(tmp_path)
    assert not deployments.already_running(settings, release.model_copy(update=change))


@pytest.mark.parametrize("url", [
    "http://outside.invalid/v1/update",
    "http://watchtower:8080/other",
    "http://user@watchtower:8080/v1/update",
    "http://watchtower:8080/v1/update?target=other",
])
def test_watchtower_configuration_rejects_external_services_and_browser_commands(url):
    with pytest.raises(ValueError):
        Settings(deployment_updater_url=url)
