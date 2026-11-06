"""Partial private settings aggregate: real isolated authorities, no provider access."""

from uuid import uuid4

import httpx
import pytest_asyncio
from alcor_api.backups import tables_and_hashes
from alcor_api.cli import create_user
from alcor_api.connection_models import PostgresConfig
from alcor_api.connections import Vault
from psycopg.types.json import Jsonb

P = "/api/settings"


@pytest_asyncio.fixture
async def legacy(app, admin):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as client:
        assert (
            await client.post("/api/auth/login", json={"username": "AdminOne", "password": "Synthetic9Pass"})
        ).status_code == 200
        yield client


async def test_partial_unconfigured_get_does_not_publish_bootstrap_or_fake_secret_defaults(
    legacy, client, db
):
    async with db.connection() as conn, conn.transaction():
        before = await tables_and_hashes(conn)
    result = await legacy.get(P)
    assert result.status_code == 200 and result.headers["x-alcor-settings-coverage"] == "partial", result.text
    value = result.json()
    assert value["migration"]["status"] == "partial"
    assert value["migration"]["sources"]["postgresql"]["state"] == "unconfigured"
    # The typed registry now projects the actual installation baseline, including
    # empty non-secret SMTP fields; it does not claim a provider is configured.
    registry = (await client.get("/api/admin/private-runtime-settings")).json()
    smtp = registry["groups"]["smtp"]
    assert smtp["state"] == value["migration"]["sources"]["smtp"]["state"] == "installation"
    assert value["settings"]["smtpHost"] == smtp["values"]["smtpHost"] == ""
    assert smtp["secretState"]["smtpPassword"] == "unset"
    for field in (
        "pgHost",
        "pgUser",
        "pgPassword",
        "pgPasswordConfigured",
        "smtpUser",
        "smtpPassword",
        "smtpPasswordConfigured",
        "llmApiKey",
        "xueqiuCookie",
        "telegramBotToken",
    ):
        assert field not in value["settings"]
    assert (await client.get(P)).json()["settings"] == value["settings"]
    async with db.connection() as conn, conn.transaction():
        assert await tables_and_hashes(conn) == before


async def test_configured_private_metadata_reads_saved_registry_without_unsealing_postgres_or_probe(
    legacy, client, admin, app, settings, db, monkeypatch
):
    config = PostgresConfig(
        host="database.example.invalid", username="synthetic_db_user", database="synthetic_data"
    )
    ciphertext = Vault(settings.connection_secret_dir).encrypt(
        "SyntheticPgSecret9", "postgresql", settings.instance_id
    )
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO connection_settings(kind,config,password_ciphertext,revision,updated_by) VALUES('postgresql',%s,%s,%s,%s)",
            (Jsonb(config.model_dump()), ciphertext, uuid4(), admin),
        )
    saved = await client.post("/api/admin/private-runtime-settings", json={
        "requestId": str(uuid4()), "expectedRevision": 0, "group": "smtp",
        "patch": {"smtpEnabled": False, "smtpHost": "smtp.example.invalid", "smtpPort": 465,
                  "smtpSecure": True, "smtpFromName": "Synthetic", "smtpFromEmail": "sender@example.invalid"},
        "secretActions": {"smtpUser": {"action": "set", "value": "SyntheticSmtpIdentity9"},
                          "smtpPassword": {"action": "set", "value": "SyntheticSmtpSecret9"}},
        "password": "Synthetic9Pass",
    })
    assert saved.status_code == 200, saved.text
    assert saved.json()["state"] == "completed"
    registry = (await client.get("/api/admin/private-runtime-settings")).json()
    assert registry["groups"]["smtp"]["state"] == "saved"

    def forbidden(*args, **kwargs):
        raise AssertionError("a settings view may neither decrypt secrets nor probe a provider")

    original_decrypt = Vault.decrypt
    def private_only(self, value, kind, instance):
        assert kind.startswith("private-runtime:"), "settings must not decrypt PostgreSQL credentials"
        return original_decrypt(self, value, kind, instance)
    monkeypatch.setattr(Vault, "decrypt", private_only)
    monkeypatch.setattr(app.state.connections, "check", forbidden)
    result = await legacy.get(P)
    assert result.status_code == 200, result.text
    value = result.json()["settings"]
    assert (value["pgHost"], value["pgPort"], value["pgDatabase"], value["pgUser"]) == (
        "database.example.invalid",
        "5432",
        "synthetic_data",
        "synthetic_db_user",
    )
    assert value["pgPasswordConfigured"] is True
    assert (
        value["smtpHost"] == "smtp.example.invalid"
        and value["smtpPort"] == "465"
        and value["smtpSecure"] is True
    )
    assert registry["groups"]["smtp"]["secretState"]["smtpPassword"] == "configured"
    assert result.json()["migration"]["sources"]["smtp"]["state"] == "saved"
    assert (
        "SyntheticPgSecret9" not in result.text
        and "SyntheticSmtpSecret9" not in result.text
        and "SyntheticSmtpIdentity9" not in result.text
    )
    assert "pgPassword" not in value and "smtpPassword" not in value and "smtpUser" not in value
    assert result.json()["migration"]["sources"]["postgresql"]["connectionHealth"] == "not_checked"


async def test_private_aggregate_member_scope_header_priority_and_redaction(legacy, settings, app, db):
    await create_user(settings, "PrivateSettingsMember", "Synthetic9Pass", role="user")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as peer:
        assert (await peer.get(P)).status_code == 401
        assert (
            await peer.post(
                "/api/auth/login", json={"username": "PrivateSettingsMember", "password": "Synthetic9Pass"}
            )
        ).status_code == 200
        token = peer.cookies["fire_session"]
        public = await peer.get(P)
        assert (
            public.status_code == 200
            and public.json()["migration"]["sources"]["private"]["state"] == "redacted"
        )
        assert "smtpHost" not in public.json()["settings"] and "pgHost" not in public.json()["settings"]
        denied = await peer.put(P, json={"title": "Must not apply"})
        assert denied.status_code == 403
    # Explicit ordinary-member bearer may not inherit a lingering administrator cookie.
    result = await legacy.get(P, headers={"authorization": "Bearer " + token})
    assert (
        result.status_code == 200 and result.json()["migration"]["sources"]["private"]["state"] == "redacted"
    )
    assert (await legacy.get(P, headers={"authorization": "Bearer invalid"})).status_code == 401


async def test_guarded_brand_patch_uuid_receipt_and_mixed_private_patch_all_or_nothing(legacy, client, db):
    identifier = str(uuid4())
    command = {
        "request_id": identifier,
        "revision": 0,
        "title": "Partial Legacy Brand",
        "currentPassword": "Synthetic9Pass",
    }
    first = await legacy.put(P, json=command)
    assert first.status_code == 200 and first.json()["settings"]["title"] == "Partial Legacy Brand", (
        first.text
    )
    assert first.json()["migration"]["privateFieldsWritten"] is False
    assert (
        await legacy.put(P, json=command | {"currentPassword": "WrongSynthetic9Pass"})
    ).json() == first.json()
    receipt = await legacy.get(first.json()["receiptUrl"])
    assert receipt.status_code == 200 and receipt.json() == first.json()["operation"]
    mixed = await legacy.put(
        P,
        json={
            "request_id": str(uuid4()),
            "revision": 1,
            "title": "Must not write",
            "smtpHost": "unapproved.example.invalid",
            "smtpPassword": "SyntheticMustNotEcho",
            "currentPassword": "Synthetic9Pass",
        },
    )
    # SMTP is now supported by the same transaction bridge. This deliberately
    # incomplete credential pair is invalid, so the public edit must roll back.
    assert mixed.status_code == 422, mixed.text
    assert "SyntheticMustNotEcho" not in mixed.text
    assert (await legacy.get(P)).json()["settings"]["title"] == "Partial Legacy Brand"
    assert (await client.get("/api/admin/private-runtime-settings")).json()["revision"] == 0
    assert (await legacy.put(P, json={"title": "No proof"})).status_code == 422
    assert (
        await legacy.put(
            P,
            json=command
            | {"request_id": str(uuid4()), "revision": 1, "currentPassword": "WrongSynthetic9Pass"},
        )
    ).status_code == 403
    # A valid explicitly disabled SMTP declaration is stored in the encrypted
    # authority, with no connection test or delivery. Mixed public/private CAS
    # and the original UUID must remain one stable receipt.
    accepted_command = {
        "request_id": str(uuid4()), "revision": 1, "privateRevision": 0,
        "title": "Verified Mixed Brand", "smtpHost": "smtp.example.invalid",
        "smtpEnabled": False, "smtpPort": 465, "smtpSecure": True,
        "smtpUser": "SyntheticIdentity9", "smtpPassword": "SyntheticSecret9",
        "currentPassword": "Synthetic9Pass",
    }
    accepted = await legacy.put(P, json=accepted_command)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["migration"]["privateFieldsWritten"] is True
    assert accepted.json()["settings"]["title"] == "Verified Mixed Brand"
    assert (await legacy.put(P, json=accepted_command)).json() == accepted.json()
    assert (await legacy.get(accepted.json()["receiptUrl"])).json() == accepted.json()
    registry = (await client.get("/api/admin/private-runtime-settings")).json()
    assert registry["revision"] == accepted.json()["privateRevision"] == 1
    assert registry["groups"]["smtp"]["values"]["smtpHost"] == "smtp.example.invalid"
    assert registry["groups"]["smtp"]["secretState"]["smtpPassword"] == "configured"
    assert "SyntheticSecret9" not in accepted.text and "SyntheticIdentity9" not in accepted.text
    stale = await legacy.put(P, json=accepted_command | {"request_id": str(uuid4())})
    assert stale.status_code == 409
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM site_settings_operations")).fetchone())[
            "n"
        ] == 2
        assert not await (await conn.execute("SELECT 1 FROM connection_settings")).fetchone()


async def test_private_read_rechecks_role_inside_snapshot_and_retires_context(legacy, admin, db, monkeypatch):
    from alcor_api import legacy_site_settings

    original = legacy_site_settings.member

    async def revoked(request, database):
        who = await original(request, database)
        async with db.connection() as conn:
            await conn.execute("UPDATE users SET role='user' WHERE id=%s", (admin,))
        return who

    monkeypatch.setattr(legacy_site_settings, "member", revoked)
    result = await legacy.get(P)
    assert result.status_code == 401
    assert result.headers["x-alcor-retire-context"] == "true"
    assert "no-store" in result.headers["cache-control"]
    assert "settings" not in result.json() and "smtpHost" not in result.text


async def test_saved_global_fx_schedule_reads_real_revision_without_unsealing_or_writes(legacy, settings, db):
    provider = uuid4()
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO fx_provider_revisions(id,config,credential_instance) VALUES(%s,%s,%s)",
            (
                provider,
                Jsonb(
                    {
                        "url": "https://provider.example.invalid/[redacted]",
                        "schedule": {
                            "pattern": "07:15|19:15",
                            "timezone": "UTC",
                            "slots": ["07:15", "19:15"],
                        },
                    }
                ),
                settings.instance_id,
            ),
        )
        row = await (
            await conn.execute(
                "UPDATE fx_config SET provider_revision=%s,enabled=false,revision=revision+1 WHERE singleton RETURNING revision",
                (provider,),
            )
        ).fetchone()
    async with db.connection() as conn, conn.transaction():
        before = await tables_and_hashes(conn)
    result = await legacy.get(P)
    assert result.status_code == 200, result.text
    value = result.json()
    assert value["settings"]["currencyRefreshPattern"] == "07:15|19:15"
    source = value["migration"]["sources"]["fxSchedule"]
    assert source["revision"] == row["revision"] and source["providerRevision"] == str(provider)
    assert source["timezone"] == "UTC" and source["enabled"] is False
    assert source["executionHealth"] == "not_checked"
    assert "currencyApiUrl" not in value["settings"] and "provider.example.invalid" not in result.text
    async with db.connection() as conn, conn.transaction():
        assert await tables_and_hashes(conn) == before
