"""Pure projections do not unseal credentials or execute a provider/scheduler."""

from types import SimpleNamespace
from uuid import uuid4

import pytest
from alcor_api.site_private_projection import fx_schedule_metadata, mail_metadata
from fastapi import HTTPException


def runtime(**patch):
    return SimpleNamespace(
        mail_host="",
        mail_port=587,
        mail_tls="starttls",
        mail_sender="",
        mail_password=None,
        mail_username=None,
        public_origin="https://public.example.invalid",
        **patch,
    )


@pytest.mark.parametrize("origin", ["https://public.example.invalid", "HTTPS://Public.Example.Invalid:443"])
def test_mail_link_binding_is_actual_runtime_and_does_not_follow_brand_domain(origin):
    config = runtime()
    config.public_origin = origin
    fields, source = mail_metadata(config, False)
    assert fields == {"emailLinkOrigin": config.public_origin}
    assert source["state"] == "unconfigured" and source["linkOriginState"] == "runtime_binding"
    assert config.public_origin == origin


@pytest.mark.parametrize(
    "origin",
    [
        "http://127.0.0.1",
        "https://127.0.0.1",
        "https://local.internal",
        "https://user:secret@public.example.invalid",
        "https://public.example.invalid/private",
        "https://public.example.invalid?token=private",
        "public.example.invalid",
        " https://public.example.invalid",
    ],
)
def test_private_runtime_link_origins_are_omitted_not_replaced_by_fake_public_values(origin):
    config = runtime()
    config.public_origin = origin
    fields, source = mail_metadata(config, False)
    assert fields == {} and source["linkOriginState"] == "not_public_omitted"
    assert config.public_origin == origin


def test_saved_fx_schedule_projects_declared_pattern_and_timezone_without_credentials():
    row = {
        "revision": 9,
        "enabled": False,
        "provider_revision": uuid4(),
        "config": {
            "url": "https://private.example.invalid/[redacted]",
            "secret": "SyntheticNeverExpose9",
            "schedule": {"pattern": "09:00|23:00", "timezone": "UTC", "slots": ["09:00", "23:00"]},
        },
    }
    fields, source = fx_schedule_metadata(row)
    assert fields == {"currencyRefreshPattern": "09:00|23:00"}
    assert source["timezone"] == "UTC" and source["revision"] == 9 and source["enabled"] is False
    assert source["providerRevision"] == str(row["provider_revision"])
    assert source["executionHealth"] == "not_checked"
    assert "SyntheticNeverExpose9" not in str((fields, source)) and "private.example.invalid" not in str(
        source
    )


def test_builtin_or_unscheduled_fx_does_not_invent_legacy_schedule():
    row = {"revision": 1, "enabled": False, "provider_revision": None, "config": None}
    assert fx_schedule_metadata(row)[0] == {}
    assert fx_schedule_metadata(row)[1]["state"] == "builtin_no_legacy_pattern"
    row.update(provider_revision=uuid4(), config={})
    assert fx_schedule_metadata(row)[0] == {}
    assert fx_schedule_metadata(row)[1]["state"] == "custom_no_schedule"


@pytest.mark.parametrize(
    "config",
    [
        None,
        {"schedule": "bad"},
        {"schedule": {"pattern": "09:00", "timezone": "Nonexistent/Zone"}},
        {"schedule": {"pattern": True, "timezone": "UTC"}},
    ],
)
def test_corrupt_current_fx_metadata_fails_closed_without_fabricated_defaults(config):
    with pytest.raises(HTTPException) as error:
        fx_schedule_metadata({"revision": 1, "enabled": True, "provider_revision": uuid4(), "config": config})
    assert error.value.status_code == 503


def test_full_source_authority_matrix_does_not_alias_personal_or_sealed_authorities():
    import json
    from pathlib import Path

    mapping = json.loads((Path(__file__).parents[1] / "fixtures/site-settings-fields.json").read_text())
    fields = {field["field"]: field for field in mapping["fields"]}
    assert len(fields) == 137
    assert all(
        item["authority_review"]["decision"] and item["authority_review"]["remaining"]
        for item in fields.values()
    )
    assert (
        fields["currencyRefreshPattern"]["authority_review"]["decision"]
        == "project_stored_pattern_with_explicit_timezone"
    )
    assert fields["currencyApiUrl"]["authority_review"]["decision"] == "omit"
    assert fields["smtpFromName"]["authority_review"]["decision"] == "omit_unknown"
    assert fields["smtpUser"]["authority_review"]["decision"] == "presence_only"
    assert (
        fields["emailLinkOrigin"]["authority_review"]["decision"] == "read_exact_binding_only_if_public_https"
    )
    assert all(
        item["authority_review"]["decision"] == "not_equivalent"
        for item in fields.values()
        if item["scope"] == "private-social-channels"
    )
    assert all(
        item["status"] == "pending_not_exposed"
        for item in fields.values()
        if item["scope"] in {"private-model-services", "worker-schedule"}
    )


@pytest.mark.parametrize("role", ["admin", "user"])
async def test_aggregate_wires_only_reviewed_global_metadata_and_never_reads_private_for_member(
    role, monkeypatch, tmp_path
):
    from contextlib import asynccontextmanager

    from alcor_api import legacy_site_settings

    calls = []
    provider = uuid4()
    owner = uuid4()
    public_groups = [{"id": "synthetic-public-group", "name": "公开券商目录"}]

    class Result:
        def __init__(self, value):
            self.value = value

        async def fetchone(self):
            return self.value

    class Connection:
        async def execute(self, query, params=None):
            assert query.startswith("SELECT "), "read aggregation must not execute a mutator"
            calls.append(query)
            if "FROM site_settings" in query:
                return Result({"revision": 4, "settings": {"appDisplayName": "Synthetic Public Display"}})
            if "FROM shared_broker_directory" in query:
                return Result({"groups": public_groups})
            if "FROM business_notification_provider_revisions" in query:
                from alcor_api.legacy_notification_settings import CREDENTIALS

                assert role == "admin" and params[0] == owner and params[1] in CREDENTIALS
                assert "WHERE owner_id=%s AND channel=%s" in query
                return Result(None)
            assert "FROM fx_config" in query and role == "admin"
            assert "secret_cipher" not in query
            return Result(
                {
                    "revision": 8,
                    "enabled": False,
                    "provider_revision": provider,
                    "config": {
                        "schedule": {"pattern": "09:00", "timezone": "UTC", "slots": ["09:00"]},
                        "privateFutureField": "SyntheticPrivate9",
                    },
                }
            )

        @asynccontextmanager
        async def transaction(self):
            yield self

    from alcor_api.config import Settings
    actual_settings = Settings(_env_file=None, public_origin="https://public.example.invalid", connection_secret_dir=tmp_path / "sealed")

    class Database:
        settings = actual_settings

        @asynccontextmanager
        async def connection(self):
            yield Connection()

    class Connections:
        async def row(self, conn, kind):
            assert kind == "postgresql" and role == "admin"
            calls.append("postgresql-metadata")

    async def lock(conn, who, require_admin):
        assert require_admin is (role == "admin")
        calls.append("identity-lock")

    async def installed(conn):
        return True

    async def public(conn, row, configured):
        assert calls[0] == "identity-lock"
        return {"title": "Synthetic Public"}

    monkeypatch.setattr(legacy_site_settings, "lock_mutation_identity", lock)
    monkeypatch.setattr(legacy_site_settings, "installed", installed)
    monkeypatch.setattr(legacy_site_settings, "public_projection", public)
    from alcor_api.private_runtime_settings import PrivateRuntimeSettings

    async def private_read(self, who):
        assert self.db.settings is actual_settings and who.role == "admin"
        calls.append("private-runtime-redacted-projection")
        return {"revision": 0, "groups": {"smtp": {"values": {"emailLinkOrigin": actual_settings.public_origin}, "state": "installation", "secretState": {}}}}

    monkeypatch.setattr(PrivateRuntimeSettings, "read_admin", private_read)
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(db=Database(), connections=Connections()))
    )
    service = SimpleNamespace(mail=SimpleNamespace(settings=runtime(), configured=False))
    value = await legacy_site_settings.aggregate(request, SimpleNamespace(role=role, id=owner), service)
    if role == "admin":
        assert value["settings"]["currencyRefreshPattern"] == "09:00"
        assert value["settings"]["emailLinkOrigin"] == runtime().public_origin
        assert value["migration"]["sources"]["fxSchedule"]["providerRevision"] == str(provider)
    else:
        from alcor_api.site_settings_layout import DEFAULTS as layout_defaults

        assert value["settings"] == {"title": "Synthetic Public", **layout_defaults,
                                     "appDisplayName": "Synthetic Public Display", "appDisplayIcon": "",
                                     "groups": public_groups}
        assert value["migration"]["sources"]["private"] == {"state": "redacted"}
        assert len(calls) == 3
        assert not any("business_notification_provider" in query or "fx_config" in query for query in calls)
    assert value["migration"]["status"] == "partial"
    assert "SyntheticPrivate9" not in str(value)


def test_smtp_metadata_only_reads_secret_presence_without_materializing_credentials():
    class Secret:
        def __bool__(self):
            return True

        def get_secret_value(self):
            raise AssertionError("metadata projection must never materialize a credential")

        def __str__(self):
            raise AssertionError("metadata projection must never stringify a credential")

    config = runtime()
    config.mail_host = "smtp.example.invalid"
    config.mail_sender = "sender@example.invalid"
    config.mail_username = config.mail_password = Secret()
    fields, source = mail_metadata(config, False)
    assert fields == {
        "smtpHost": "smtp.example.invalid",
        "smtpPort": "587",
        "smtpSecure": False,
        "smtpFromEmail": "sender@example.invalid",
        "smtpPasswordConfigured": True,
        "emailLinkOrigin": "https://public.example.invalid",
    }
    assert source["state"] == "disabled" and source["usernameState"] == "sealed_present"
    assert source["deliveryHealth"] == "not_checked"
    assert "smtpUser" not in fields and "smtpPassword" not in fields and "smtpFromName" not in fields
