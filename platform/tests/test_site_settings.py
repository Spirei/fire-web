"""Public branding and registration policy use only identity-verified isolated PG."""

import asyncio
from uuid import uuid4

import httpx
import pytest
from alcor_api.backups import tables_and_hashes
from alcor_api.cli import create_user
from alcor_api.site_settings_api import V1_KEYS

P = "/api/admin/site-settings"


async def save(client, revision=0, patch=None, **extra):
    return await client.put(
        P,
        json={
            "requestId": str(uuid4()),
            "expectedRevision": revision,
            "patch": patch or {"title": "Synthetic Site"},
            "password": "Synthetic9Pass",
            **extra,
        },
    )


async def test_public_contract_fields_no_secrets_no_writes_v2_boundary(client, app, db):
    async with db.connection() as conn, conn.transaction():
        before = await tables_and_hashes(conn)
    web = await client.get("/api/settings/public")
    assert web.status_code == 200, web.text
    value = web.json()["settings"]
    assert set(value) == set(V1_KEYS) | {
        "loginSideImage",
        "emailRegistration",
        "marketBadges",
        "marketBadgesVisible",
        "mobileNavigationOrder",
    }
    assert value["allowRegister"] is True and value["emailRegistration"] is False and value["domain"] == ""
    assert value["title"] == "Alcor" and value["homeNav"] == []
    assert value["mobileNavigationOrder"] == []
    v1 = await client.get(
        "/api/v1/settings/public", headers={"authorization": "invalid", "origin": "https://other.invalid"}
    )
    assert v1.status_code == 200 and set(v1.json()["data"]) == set(V1_KEYS)
    v2 = await client.get("/api/v2/settings/public")
    assert v2.status_code == 200 and v2.headers["x-alcor-api-version"] == "2"
    assert (
        await client.get("/api/v2/settings/public", headers={"authorization": "Bearer invalid"})
    ).status_code == 401
    assert (
        await client.get("/api/v2/settings/public", headers={"origin": "https://other.invalid"})
    ).status_code == 403
    assert not any(
        key in value for key in ("smtpPassword", "pgPassword", "llmApiKey", "xueqiuCookie", "smtpHost")
    )
    async with db.connection() as conn, conn.transaction():
        assert await tables_and_hashes(conn) == before


async def test_admin_cas_original_uuid_close_and_config_does_not_change_origin(client, admin, app, db):
    before_origin = app.state.settings.public_origin
    identifier = str(uuid4())
    body = {
        "requestId": identifier,
        "expectedRevision": 0,
        "patch": {"title": "Synthetic Public", "domain": "public.example.invalid", "allowRegister": False},
        "password": "Synthetic9Pass",
    }
    results = await asyncio.gather(*(client.put(P, json=body) for _ in range(3)))
    assert all(result.status_code == 200 for result in results), [result.text for result in results]
    assert all(result.json() == results[0].json() for result in results)
    assert (await client.get(P + "/operations/" + identifier)).json() == results[0].json()
    assert (await client.put(P, json=body | {"patch": {"title": "Different"}})).status_code == 409
    assert (await save(client, revision=0)).status_code == 409
    value = (await client.get("/api/settings/public")).json()["settings"]
    assert value["domain"] == "https://public.example.invalid" and not value["allowRegister"]
    assert app.state.settings.public_origin == before_origin
    closed = str(uuid4())
    assert (
        await client.post(P + "/operations/" + closed + "/close", json={"expectedKind": "site-settings"})
    ).json()["state"] == "closed"
    assert (await save(client, revision=1, requestId=closed)).status_code == 409
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM audit_events WHERE action='site.settings.updated'"
                )
            ).fetchone()
        )["n"] == 1


async def test_registration_gate_applies_to_new_legacy_existing_email_challenge_and_cli_is_explicit(
    client, admin, app, db, settings
):
    from test_identity_email_flows import code, deliver, enable

    captured = enable(app, settings)
    stage = await client.post(
        "/api/auth/register/email/request", json={"email": "staged-before-close@example.invalid"}
    )
    assert stage.status_code == 200, stage.text
    await deliver(app)
    confirmation = {
        "email": "staged-before-close@example.invalid",
        "challenge": stage.json()["challenge"],
        "code": code(captured),
        "password": "Synthetic9Pass",
    }
    assert (await save(client, patch={"allowRegister": False})).status_code == 200
    for path, body in (
        ("/api/session/register", {"username": "BlockedNative", "password": "Synthetic9Pass"}),
        ("/api/auth/register", {"username": "BlockedLegacy", "password": "Synthetic9Pass"}),
    ):
        result = await client.post(path, json=body)
        assert result.status_code == 403 and "注册暂未开放" in result.text, result.text
    # Even a challenge created while the site was open cannot bypass today's PG policy.
    blocked_existing = await client.post("/api/auth/register/email/confirm", json=confirmation)
    assert blocked_existing.status_code == 403 and "注册暂未开放" in blocked_existing.text
    async with db.connection() as conn:
        original = await (
            await conn.execute("SELECT attempts FROM identity_challenges WHERE purpose='email-registration'")
        ).fetchone()
        assert original["attempts"] == 0
    service = app.state.identity_email
    service.mail.settings.mail_enabled = True
    service.mail.settings.mail_host = "smtp.example.invalid"
    service.mail.settings.mail_sender = "no-reply@example.invalid"
    assert (
        await client.post("/api/auth/register/email/request", json={"email": "blocked@example.invalid"})
    ).status_code == 403
    result = await client.post(
        "/api/auth/register/email/confirm",
        json={
            "email": "blocked@example.invalid",
            "challenge": "S" * 43,
            "code": "123456",
            "password": "Synthetic9Pass",
        },
    )
    assert result.status_code == 403 and "注册暂未开放" in result.text
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM users WHERE username IN ('BlockedNative','BlockedLegacy')")
        ).fetchone()
    explicit = await create_user(settings, "ExplicitOperator", "Synthetic9Pass", role="user")
    assert explicit
    assert (await save(client, revision=1, patch={"allowRegister": True})).status_code == 200
    resumed = await client.post("/api/auth/register/email/confirm", json=confirmation)
    assert resumed.status_code == 201 and resumed.json()["user"]["role"] == "user", resumed.text
    repeated = await client.post("/api/auth/register/email/confirm", json=confirmation)
    assert repeated.status_code == 400  # A consumed challenge never creates a second account.
    result = await client.post(
        "/api/auth/register", json={"username": "AllowedAgain", "password": "Synthetic9Pass"}
    )
    assert result.status_code == 201 and result.json()["user"]["role"] == "user"


async def test_public_email_supported_tracks_runtime_and_restore_quarantine(client, app, db):
    mail = app.state.identity_email.mail
    mail.settings.mail_enabled = True
    mail.settings.mail_host = "smtp.example.invalid"
    mail.settings.mail_sender = "no-reply@example.invalid"
    assert (await client.get("/api/settings/public")).json()["settings"]["emailRegistration"] is True
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO restore_quarantine(category,payload) VALUES('external_delivery_disabled','{}'::jsonb)"
        )
    assert (await client.get("/api/settings/public")).json()["settings"]["emailRegistration"] is False


@pytest.mark.parametrize(
    "patch",
    [
        {"smtpPassword": "SyntheticMustNotPublish"},
        {"ico": "https://secret.example.invalid/image.png"},
        {"domain": "https://user:secret@example.invalid"},
        {"domain": "https://0177.0.0.1"},
        {"domain": "https://0x7f.0x0.0x0.0x1"},
        {"homeNav": [{"key": "bad", "label": "Bad", "href": "javascript:alert(1)", "enabled": True}]},
        {"allowRegister": "false"},
    ],
)
async def test_private_unknown_fields_unregistered_assets_and_unsafe_links_never_commit(
    client, admin, db, patch
):
    result = await save(client, patch=patch)
    assert result.status_code == 400, result.text
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT revision FROM site_settings")).fetchone())["revision"] == 0
        assert not await (await conn.execute("SELECT 1 FROM site_settings_operations")).fetchone()


async def test_nonadmin_scope_and_wrong_proof_cannot_read_write_or_query_other_owner(
    client, admin, app, settings, db
):
    assert (await save(client, password="Incorrect9Pass")).status_code == 403
    result = await save(client)
    identifier = result.json()["requestId"]
    await create_user(settings, "SiteOrdinary", "Synthetic9Pass", role="user")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as peer:
        assert (await peer.get(P)).status_code == 401
        logged = await peer.post(
            "/api/session/login", json={"login": "SiteOrdinary", "password": "Synthetic9Pass"}
        )
        peer.headers["x-csrf-token"] = logged.json()["csrf"]
        assert (await peer.get(P)).status_code == 403
        assert (await peer.get(P + "/operations/" + identifier)).status_code == 403
        assert (await save(peer)).status_code == 403
    denied = await client.put(
        P,
        json={
            "requestId": str(uuid4()),
            "expectedRevision": 1,
            "patch": {"title": "Must not change"},
            "password": "Synthetic9Pass",
        },
        headers={"x-csrf-token": "wrong"},
    )
    assert denied.status_code == 403


@pytest.mark.parametrize("legacy", [False, True])
async def test_registration_race_with_close_has_one_transactional_policy_order(client, admin, db, legacy):
    path = "/api/auth/register" if legacy else "/api/session/register"
    result, closed = await asyncio.wait_for(
        asyncio.gather(
            client.post(path, json={"username": "RacingRegistration", "password": "Synthetic9Pass"}),
            save(client, patch={"allowRegister": False}),
        ),
        timeout=10,
    )
    assert closed.status_code == 200, closed.text
    assert result.status_code in (201, 403), result.text
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT allow_register FROM site_settings")).fetchone())[
            "allow_register"
        ] is False
        count = (
            await (
                await conn.execute("SELECT count(*) AS n FROM users WHERE username='RacingRegistration'")
            ).fetchone()
        )["n"]
        assert count == (1 if result.status_code == 201 else 0)
    blocked = await client.post(path, json={"username": "AfterClosedUser", "password": "Synthetic9Pass"})
    assert blocked.status_code == 403


async def test_registered_asset_version_pins_bytes_and_rejects_wrong_kind(
    client, admin, settings, tmp_path, app, db
):
    from test_system_assets import PNG, upload

    settings.file_root = tmp_path / "brand-files"
    first, _ = await upload(client, "logo", PNG, "brand.png")
    assert first.status_code == 200, first.text
    version = first.json()["version"]
    selected = await save(client, patch={"siteLogo": version})
    assert selected.status_code == 200, selected.text
    public = (await client.get("/api/settings/public")).json()["settings"]["siteLogo"]
    assert "sha256=" in public and (await client.get(public)).content == PNG
    second, _ = await upload(client, "logo", PNG + b"OTHER", "brand.png")
    assert second.status_code == 200, second.text
    assert (await client.get("/api/settings/public")).json()["settings"]["siteLogo"] == public
    assert (await client.get(public)).content == PNG
    # A bounded picker must retain the selected immutable original even when
    # more than its normal page of newer artwork has been registered.
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO system_asset_versions(id,public_path,kind,folder,market,original_sha256,served_sha256,original_size,served_size,media_type,created_by) "
            "SELECT gen_random_uuid(),public_path,kind,folder,market,original_sha256,served_sha256,original_size,served_size,media_type,created_by "
            "FROM system_asset_versions CROSS JOIN generate_series(1,201) WHERE id=%s",
            (version,),
        )
    picker = await client.get(P + "/assets")
    assert picker.status_code == 200, picker.text
    assert len(picker.json()["items"]) == 200
    assert version in {item["id"] for item in picker.json()["items"]}
    assert (await client.get("/api/settings/public")).json()["settings"]["siteLogo"] == public
    assert (await client.get(public)).content == PNG
    wrong = await save(client, revision=1, patch={"ico": version})
    assert wrong.status_code == 400
    missing = await save(client, revision=1, patch={"siteLogo": str(uuid4())})
    assert missing.status_code == 400


async def test_corrupt_current_site_table_is_not_treated_as_an_old_default(client, db):
    async with db.connection() as conn:
        await conn.execute("DROP TABLE site_settings")
    result = await client.get("/api/settings/public")
    assert result.status_code == 503


def test_complete_legacy_field_map_keeps_private_settings_out_of_public_projection():
    import json
    import re
    from pathlib import Path

    root = Path(__file__).parent / "fixtures"
    mapping = json.loads((root / "site-settings-fields.json").read_text())
    interface = (root / "site-settings-interface.ts").read_text()
    names = re.findall(r"^  ([A-Za-z][A-Za-z0-9]*)\??:", interface, re.MULTILINE)
    assert len(names) == mapping["declared_fields"] == 137
    assert {item["field"] for item in mapping["fields"]} == set(names)
    assert all(item["status"] and item["scope"] for item in mapping["fields"])
    implemented = {
        item["field"] for item in mapping["fields"] if item["status"] == "implemented_platform_only"
    }
    assert implemented == set(V1_KEYS) | {"loginSideImage", "marketBadges", "marketBadgesVisible"}
    assert {
        "pgPassword",
        "smtpPassword",
        "llmApiKey",
        "modelServices",
        "telegramBotToken",
        "xueqiuCookie",
    }.isdisjoint(implemented)
    writes = mapping["legacy_private_write"]
    assert writes["status"] == "partial" and len(writes["body_fields"]) == writes["body_field_count"] == 121
    assert set(writes["body_fields"]) <= set(names) | {"clearXueqiuCookie"}
    assert mapping["legacy_private_read"]["status"] == "partial"


async def test_current_missing_singleton_fails_closed_in_public_and_registration(client, db):
    async with db.connection() as conn:
        await conn.execute("DELETE FROM site_settings")
    assert (await client.get("/api/settings/public")).status_code == 503
    result = await client.post(
        "/api/auth/register", json={"username": "NoPolicyFallback", "password": "Synthetic9Pass"}
    )
    assert result.status_code == 503
    async with db.connection() as conn:
        assert not await (
            await conn.execute("SELECT 1 FROM users WHERE username='NoPolicyFallback'")
        ).fetchone()


async def test_old_schema_gate_and_public_defaults_upgrade_without_touching_real_data(settings, pg, tmp_path):
    import shutil

    import psycopg
    from alcor_api.config import ROOT
    from alcor_api.db import Database
    from alcor_api.identity_mail import IdentityMail
    from alcor_api.migrate import migrate
    from alcor_api.site_registration import registration_open
    from alcor_api.site_settings import SiteSettings
    from psycopg import sql

    older = tmp_path / "pre85"
    older.mkdir()
    for path in (ROOT / "migrations").glob("*.sql"):
        if path.name < "0085":
            shutil.copyfile(path, older / path.name)
    name = "alcor_test_site_upgrade_" + uuid4().hex
    with psycopg.connect(pg.get_uri(), autocommit=True) as connection:
        connection.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    prior = settings.model_copy(update={"database_url": pg.get_uri(database=name), "migration_dir": older})
    # model_copy keeps SecretStr fields verbatim, so wrap the isolated URI explicitly.
    from pydantic import SecretStr

    prior.database_url = SecretStr(pg.get_uri(database=name))
    try:
        await migrate(prior, name, initialize_empty=True)
        database = Database(prior)
        await database.open()
        try:
            async with database.connection() as conn, conn.transaction():
                assert await registration_open(conn) is True
            value = await SiteSettings(database, IdentityMail(prior, database)).public()
            assert value["allowRegister"] is True and value["domain"] == ""
        finally:
            await database.close()
        prior.migration_dir = ROOT / "migrations"
        await migrate(prior, name)
        database = Database(prior)
        await database.open()
        try:
            async with database.connection() as conn:
                row = await (
                    await conn.execute("SELECT allow_register,revision FROM site_settings")
                ).fetchone()
                assert row == {"allow_register": True, "revision": 0}
        finally:
            await database.close()
    finally:
        with psycopg.connect(pg.get_uri(), autocommit=True) as connection:
            connection.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


async def test_atomic_failure_restores_registration_policy_factor_and_original_uuid(
    client, admin, app, settings, db, monkeypatch
):
    from alcor_api.connections import Vault
    from psycopg import AsyncConnection
    from psycopg.types.json import Jsonb

    codes, key, hashes = app.state.identity_management.codes()
    vault = Vault(settings.connection_secret_dir)
    async with db.connection() as conn:
        await conn.execute(
            "INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext,backup_codes,backup_key_ciphertext) VALUES(%s,true,%s,%s,%s)",
            (
                admin,
                vault.encrypt("JBSWY3DPEHPK3PXP", "totp:" + admin, settings.instance_id),
                Jsonb(hashes),
                vault.encrypt(key.hex(), "backup-key:" + admin, settings.instance_id),
            ),
        )
    identifier = str(uuid4())
    command = {
        "requestId": identifier,
        "expectedRevision": 0,
        "patch": {"allowRegister": False},
        "password": "Synthetic9Pass",
        "code": codes[0],
    }
    execute = AsyncConnection.execute

    async def interrupted(conn, query, *args, **kwargs):
        if isinstance(query, str) and "INSERT INTO site_settings_operations" in query:
            raise RuntimeError("Synthetic failure after policy update")
        return await execute(conn, query, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(AsyncConnection, "execute", interrupted)
        result = await client.put(P, json=command)
        assert result.status_code == 503
    async with db.connection() as conn:
        assert (
            await (await conn.execute("SELECT revision,allow_register FROM site_settings")).fetchone()
        ) == {"revision": 0, "allow_register": True}
        assert (
            len(
                (
                    await (
                        await conn.execute(
                            "SELECT backup_codes FROM identity_security WHERE user_id=%s", (admin,)
                        )
                    ).fetchone()
                )["backup_codes"]
            )
            == 8
        )
        assert not await (
            await conn.execute("SELECT 1 FROM site_settings_operations WHERE request_id=%s", (identifier,))
        ).fetchone()
    accepted = await client.put(P, json=command)
    assert accepted.status_code == 200, accepted.text
    assert (
        await client.put(P, json=command | {"password": "WrongSynthetic9Pass", "code": ""})
    ).json() == accepted.json()
    async with db.connection() as conn:
        assert (
            len(
                (
                    await (
                        await conn.execute(
                            "SELECT backup_codes FROM identity_security WHERE user_id=%s", (admin,)
                        )
                    ).fetchone()
                )["backup_codes"]
            )
            == 7
        )


async def test_closed_and_inflight_site_uuid_never_double_apply(client, admin, db):
    identifier = str(uuid4())
    command = {
        "requestId": identifier,
        "expectedRevision": 0,
        "patch": {"title": "Single Applied"},
        "password": "Synthetic9Pass",
    }
    changed, closed = await asyncio.wait_for(
        asyncio.gather(
            client.put(P, json=command),
            client.post(P + "/operations/" + identifier + "/close", json={"expectedKind": "site-settings"}),
        ),
        timeout=10,
    )
    assert closed.status_code == 200
    if changed.status_code == 200:
        assert closed.json() == changed.json()
    else:
        assert changed.status_code == 409 and closed.json()["state"] == "closed"
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT revision FROM site_settings")).fetchone())["revision"] == (
            1 if changed.status_code == 200 else 0
        )
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM site_settings_operations WHERE request_id=%s", (identifier,)
                )
            ).fetchone()
        )["n"] == 1


@pytest.mark.parametrize(
    "body",
    [
        lambda identifier: (
            '{"requestId":"'
            + identifier
            + '","requestId":"'
            + str(uuid4())
            + '","expectedRevision":0,"patch":{"title":"Must not save"},"password":"Synthetic9Pass"}'
        ),
        lambda identifier: (
            '{"requestId":"'
            + identifier
            + '","expectedRevision":0,"patch":{"allowRegister":true,"allowRegister":false},"password":"Synthetic9Pass"}'
        ),
        lambda identifier: (
            '{"requestId":"'
            + identifier
            + '","expectedRevision":0,"patch":{"title":NaN},"password":"Synthetic9Pass"}'
        ),
    ],
)
async def test_ambiguous_uuid_duplicate_policy_and_nonfinite_json_never_execute(client, admin, db, body):
    result = await client.put(P, content=body(str(uuid4())), headers={"content-type": "application/json"})
    assert result.status_code == 422, result.text
    async with db.connection() as conn:
        assert (
            await (await conn.execute("SELECT revision,allow_register FROM site_settings")).fetchone()
        ) == {"revision": 0, "allow_register": True}
        assert not await (await conn.execute("SELECT 1 FROM site_settings_operations")).fetchone()
