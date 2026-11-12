"""Partial private settings aggregate: real isolated authorities, no provider access."""

from uuid import uuid4
import asyncio

import httpx
import pytest_asyncio
from alcor_api.backups import tables_and_hashes as full_tables_and_hashes
from alcor_api.cli import create_user
from alcor_api.connection_models import PostgresConfig
from alcor_api.connections import Vault
from psycopg.types.json import Jsonb

P = "/api/settings"


async def tables_and_hashes(conn):
    # Request counters are deliberately written by the asynchronous observer.
    # Keep the backup's complete fingerprint unchanged; this read-only assertion
    # covers every configuration/business table, excluding only that telemetry.
    snapshot = await full_tables_and_hashes(conn)
    telemetry = {
        'request_observations', 'request_rollup_state', 'request_observation_producers',
        'account_request_activity', 'account_request_activity_batches', 'account_request_activity_state',
    }
    return {name:value for name,value in snapshot.items() if name not in telemetry}


async def test_first_run_registration_then_site_save_uses_current_revision_and_admin_proof(client):
    password = "Synthetic9Pass"
    created = await client.post("/api/auth/register", json={"username": "SetupOwner", "password": password})
    assert created.status_code == 201, created.text
    assert created.json()["user"]["role"] == "admin"
    initial = (await client.get(P)).json()
    patch = {"title": "Alcor", "allowRegister": False}
    assert (await client.put(P, json=patch)).status_code == 422
    payload = {**patch, "requestId": str(uuid4()), "revision": initial["revision"], "currentPassword": password}
    saved = await client.put(P, json=payload)
    assert saved.status_code == 200, saved.text
    assert saved.json()["settings"]["title"] == "Alcor"
    assert saved.json()["settings"]["allowRegister"] is False
    receipt = await client.get(P + "/operations/" + payload["requestId"])
    assert receipt.json() == saved.json()["operation"]
    assert receipt.json()["state"] == "completed"
    assert (await client.put(P, json=payload)).json()["operation"] == receipt.json()


async def test_opend_settings_install_own_fixed_source_without_manual_env(legacy, app, monkeypatch):
    from alcor_api.market_transport import Transport
    calls = []
    async def diagnostic(self, policy, action):
        calls.append((policy,action))
        return {'responded':True,'qotLogined':True}
    monkeypatch.setattr(Transport, 'diagnostic', diagnostic)
    current = (await legacy.get(P)).json()
    fields = {'futuHost':'192.0.2.41','futuPort':'11111','quoteSource':'auto','futuApproved':True}
    def command(state, **extra):
        return {**fields,'requestId':str(uuid4()),'revision':state['revision'],'privateRevision':state['privateRevision'],'currentPassword':'Synthetic9Pass',**extra}
    refused = await legacy.put(P,json=command(current,currentPassword='incorrect'))
    assert refused.status_code == 403, refused.text
    assert not calls
    saved = await legacy.put(P,json=command(current))
    assert saved.status_code == 200, saved.text
    read = (await legacy.get(P)).json()
    assert read['settings']['futuHost'] == fields['futuHost']
    assert read['settings']['futuPort'] == '11111'
    assert (await legacy.put(P,json=command(read))).status_code == 200
    tested = await legacy.post('/api/futu/test',json={'host':fields['futuHost'],'port':'11111','requestId':str(uuid4())})
    assert tested.status_code == 200, tested.text
    assert tested.json()['ok'] is True
    assert len(calls) == 1 and calls[0][1] == 'futu.test'
    retained = await legacy.get('/api/futu/test')
    assert retained.status_code == 200, retained.text
    assert retained.json()['lastTest']['requestId'] == tested.json()['requestId']
    assert retained.json()['lastTest']['observedAt'] == tested.json()['observedAt']
    assert len(calls) == 1, 'reopening settings must not probe OpenD again'
    denied = await legacy.post('/api/futu/test',json={'host':'192.0.2.42','port':'11111'})
    assert denied.status_code == 403 and len(calls) == 1


async def test_web_fx_refresh_and_original_receipt_share_the_legacy_web_identity(legacy):
    identifier = str(uuid4())
    refreshed = await legacy.post('/api/rates/refresh', json={'requestId':identifier})
    assert refreshed.status_code == 202, refreshed.text
    receipt = await legacy.get('/api/rates/operations/'+identifier)
    assert receipt.status_code == 200, receipt.text
    assert receipt.json()['id'] == refreshed.json()['id']
    replay = await legacy.post('/api/rates/refresh', json={'requestId':identifier})
    assert replay.json()['id'] == receipt.json()['id']


async def test_parallel_catalog_readers_keep_identity_protection_without_exclusive_owner_lock(legacy, app, db):
    import asyncio
    from alcor_api.legacy_identity import web_identity
    from starlette.requests import Request
    cookie = '; '.join(f'{name}={value}' for name,value in legacy.cookies.items())
    request = Request({'type':'http','method':'GET','path':'/api/assets/catalog',
                       'headers':[(b'cookie',cookie.encode())]})
    who, _, _ = await web_identity(request, db)
    catalog = app.state.asset_catalog_management.catalog
    async with catalog.context(who):
        response = await asyncio.wait_for(legacy.get('/api/assets/catalog?type=stock'), timeout=3)
        assert response.status_code == 200, response.text


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


async def test_explicit_fx_url_save_seals_credentials_and_registers_current_provider(legacy, db, monkeypatch, app):
    from alcor_api import fx_provider_transport
    calls=[]
    async def resolve(host,port):
        calls.append((host,port))
        return ['8.8.8.8']
    monkeypatch.setattr(fx_provider_transport,'resolve',resolve)
    metadata=await legacy.get('/api/rates/provider')
    assert metadata.status_code==200,metadata.text
    assert metadata.json()['revision']==1
    current=(await legacy.get(P)).json()
    payload={'requestId':str(uuid4()),'revision':current['revision'],'privateRevision':current['privateRevision'],
             'currentPassword':'Synthetic9Pass','currencyApiUrl':'https://rates.example.invalid/latest?app_id=synthetic-key',
             'currencyApproved':True,'currencyRevision':1}
    denied=await legacy.put(P,json={**payload,'currentPassword':'incorrect'})
    assert denied.status_code==403 and not calls
    saved=await legacy.put(P,json=payload)
    assert saved.status_code==200,saved.text
    assert 'synthetic-key' not in saved.text
    repeated=await legacy.put(P,json=payload)
    assert repeated.status_code==200,repeated.text
    assert repeated.json()==saved.json()
    assert len(calls)==1,'same UUID reuses the original configuration, without another DNS read'
    async with db.connection() as conn:
        current=await(await conn.execute('SELECT * FROM fx_config WHERE singleton')).fetchone()
        assert current['enabled'] and current['provider_revision']
        provider=await(await conn.execute('SELECT * FROM fx_provider_revisions WHERE id=%s',(current['provider_revision'],))).fetchone()
        assert provider['config']['url']=='https://rates.example.invalid/[redacted]'
        assert 'synthetic-key' not in str(provider['config']) and 'synthetic-key' not in provider['secret_cipher']
        assert not await(await conn.execute('SELECT 1 FROM fx_refresh_tasks')).fetchone(),'saving does not fetch or start an automatic job'
    read=await legacy.get(P)
    assert 'synthetic-key' not in read.text
    state=read.json()
    stale=await legacy.put(P,json={**payload,'requestId':str(uuid4()),'revision':state['revision'],
        'privateRevision':state['privateRevision'],'currencyRevision':1})
    assert stale.status_code==409,stale.text
    async with db.connection() as conn:
        assert (await(await conn.execute('SELECT count(*) n FROM fx_provider_revisions')).fetchone())['n']==1
    metadata=await legacy.get('/api/rates/provider')
    assert metadata.status_code==200 and metadata.json()['revision']==2
    assert 'synthetic-key' not in metadata.text
    # Only the explicit, verified administrator view may read the full URL.
    shown=await legacy.get('/api/rates/provider?includeUrl=1')
    assert shown.status_code==200 and shown.json()['custom']['url']==payload['currencyApiUrl'],shown.text
    assert shown.json()['urlRestricted'] is False
    async with db.connection() as conn:
        await conn.execute("UPDATE sessions SET auth_method='password',created_at=clock_timestamp()-interval '20 minutes' WHERE user_id=(SELECT id FROM users WHERE username='AdminOne')")
        await conn.execute("DELETE FROM identity_challenges WHERE purpose='reference-reauth'")
    restricted=await legacy.get('/api/rates/provider?includeUrl=1')
    assert restricted.status_code==200 and restricted.json()['urlRestricted'] is True
    assert 'synthetic-key' not in restricted.text
    unlock=await legacy.post('/api/rates/provider/reauthenticate',json={'password':'Synthetic9Pass'})
    assert unlock.status_code==204,unlock.text
    shown=await legacy.get('/api/rates/provider?includeUrl=1')
    assert shown.status_code==200 and shown.json()['custom']['url']==payload['currencyApiUrl']
    async with db.connection() as conn:
        assert (await (await conn.execute('SELECT count(*) n FROM fx_provider_revisions')).fetchone())['n']==1
        assert not await (await conn.execute('SELECT 1 FROM fx_refresh_tasks')).fetchone(),'viewing the URL never collects rates or configures another provider'
    fetches=[]
    async def requester(url,approval,headers):
        fetches.append(url)
        return b'{"base":"USD","rates":{"HKD":7.8,"CNY":7.2}}'
    worker=app.state.reference_rates
    worker.custom_requester=requester
    request_id=str(uuid4())
    queued=await legacy.post('/api/rates/refresh',json={'requestId':request_id})
    assert queued.status_code==202,queued.text
    assert queued.json()['requestId']==request_id
    task=queued.json()['id']
    assert await worker.once()=='completed'
    receipt=await legacy.get('/api/rates/operations/'+request_id)
    assert receipt.status_code==200,receipt.text
    assert receipt.json()['state']=='completed' and receipt.json()['id']==task and receipt.json()['observation_id']
    repeat=await legacy.post('/api/rates/refresh',json={'requestId':request_id})
    assert repeat.json()['id']==task and repeat.json()['state']=='completed'
    assert len(fetches)==1
    snapshot=await legacy.get('/api/rates')
    assert snapshot.status_code==200 and snapshot.json()['rates']['CNY']==7.2
    for path in ('/api/rates/provider','/api/rates/operations/'+request_id):
        assert (await legacy.get(path,headers={'sec-fetch-site':'cross-site'})).status_code==403
        assert (await legacy.get(path,headers={'authorization':'Bearer invalid'})).status_code==403
    denied=await legacy.post('/api/rates/refresh',json={'requestId':str(uuid4())},headers={'origin':'https://other.example.invalid'})
    assert denied.status_code==403 and len(fetches)==1
    async with db.connection() as conn:
        await conn.execute('UPDATE users SET session_version=session_version+1 WHERE username=%s',('AdminOne',))
    assert (await legacy.get('/api/rates/provider')).status_code==401
    assert (await legacy.get('/api/rates/operations/'+request_id)).status_code==401


async def test_fx_url_save_rejects_private_dns_without_changing_provider(legacy,db,monkeypatch):
    from alcor_api import fx_provider_transport
    async def resolve(host,port):return ['127.0.0.1']
    monkeypatch.setattr(fx_provider_transport,'resolve',resolve)
    current=(await legacy.get(P)).json()
    result=await legacy.put(P,json={'requestId':str(uuid4()),'revision':current['revision'],
        'privateRevision':current['privateRevision'],'currentPassword':'Synthetic9Pass',
        'currencyApiUrl':'https://rates.example.invalid/latest','currencyApproved':True,'currencyRevision':1})
    assert result.status_code==422,result.text
    async with db.connection() as conn:
        assert not (await(await conn.execute('SELECT enabled FROM fx_config WHERE singleton')).fetchone())['enabled']
        assert not await(await conn.execute('SELECT 1 FROM fx_provider_revisions')).fetchone()


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


async def test_source_probe_reuses_the_same_fixed_targets(monkeypatch):
    from types import SimpleNamespace
    from alcor_api.market_source_tests import probe_markets
    from alcor_api.market_transport import Transport
    monkeypatch.setattr('alcor_api.market_source_tests.requested_session',lambda:'REGULAR')
    target=SimpleNamespace(id='fixed')
    owned=[]
    async def diagnostic(self,policy, action):
        owned.append(self)
        assert self.reuse_latest is True
        return {'responded':True,'qotLogined':True,'quotePermissionVerified':True,'quote':{'code':'US.AAPL','price':210.25}}
    async def read(self,policy,query,cursor):
        assert self.targets=={'fixed':target} and self.target_provider is None
        assert self.reuse_latest is True
        assert owned==[self],'connection and quotation checks must share the probe-owned SDK import'
        return b'{"records":[{"code":"HK.00700","last_price":409.6,"update_time":"2026-01-02 15:59:00"}]}','sdk_json_representation_not_wire_bytes'
    monkeypatch.setattr(Transport,'read',read)
    monkeypatch.setattr(Transport,'diagnostic',diagnostic)
    authority=SimpleNamespace(db=object(),validate_query=lambda policy,query:None)
    transport=SimpleNamespace(targets={'fixed':target},target_provider=None,controlled_http={})
    result=await probe_markets(authority,transport,SimpleNamespace(markets=('US','HK'),source='futu',fixture=False))
    assert result['state']=='available' and result['markets']['HK']['price']==409.6


async def test_source_probe_current_night_never_uses_diagnostic_regular_close(monkeypatch):
    import json
    from types import SimpleNamespace
    from alcor_api.market_source_tests import probe_markets
    from alcor_api.market_transport import Transport
    monkeypatch.setattr('alcor_api.market_source_tests.requested_session',lambda:'OVERNIGHT')
    async def diagnostic(self,policy,action):
        return {'responded':True,'qotLogined':True,'quotePermissionVerified':True,'quote':{'code':'US.AAPL','price':355.63}}
    async def read(self,policy,query,cursor):
        assert query.session=='OVERNIGHT'
        return json.dumps({'records':[{'code':'US.AAPL','update_time':'2026-11-11 16:00:00','last_price':'355.63','prev_close_price':'348.51'}],
            'realTimeRecords':[{'code':'US.AAPL','time':'2026-11-11 20:12:00','is_blank':False,'cur_price':'356.20','last_close':'355.63'}]}).encode(),'sdk_json_representation_not_wire_bytes'
    monkeypatch.setattr(Transport,'diagnostic',diagnostic);monkeypatch.setattr(Transport,'read',read)
    authority=SimpleNamespace(db=object(),validate_query=lambda policy,query:None)
    transport=SimpleNamespace(targets={},target_provider=None,controlled_http={})
    result=await probe_markets(authority,transport,SimpleNamespace(markets=('US',),source='futu',fixture=False))
    assert result['state']=='available' and result['price']==356.2 and result['session']=='OVERNIGHT'
    assert result['markets']['US']['sourceTime']=='2026-11-12T01:12:00+00:00'


async def test_source_order_and_explicit_quote_tests_persist_without_automatic_probe(legacy, app, monkeypatch):
    import json
    from alcor_api.market_transport import Transport
    monkeypatch.setattr('alcor_api.market_source_tests.requested_session',lambda:'REGULAR')
    calls=[]
    reads=[]
    async def diagnostic(self,policy,action):
        calls.append(action)
        return {'responded':True,'qotLogined':True,'quotePermissionVerified':True,'quote':{'code':'US.AAPL','price':210.25}}
    monkeypatch.setattr(Transport,'diagnostic',diagnostic)
    async def quote_read(self,policy,query,cursor):
        reads.append(query.market)
        if query.market=='CN': raise ValueError('synthetic_market_permission_refused')
        return json.dumps({'records':[{'code':'HK.00700','last_price':409.6,'update_time':'2026-01-02 15:59:00'}]}).encode(),'sdk_json_representation_not_wire_bytes'
    monkeypatch.setattr(Transport,'read',quote_read)
    state=(await legacy.get(P)).json()
    order=['yahoo','futu','tencent','eastmoney']
    command={'requestId':str(uuid4()),'revision':state['revision'],'privateRevision':state['privateRevision'],'currentPassword':'Synthetic9Pass',
             'futuHost':'192.0.2.41','futuPort':'11111','futuApproved':True,'quoteSource':'auto','quoteSourceOrder':order}
    response=await legacy.put(P,json=command);assert response.status_code==200,response.text
    assert (await legacy.get(P)).json()['settings']['quoteSourceOrder']==order
    assert app.state.db.settings._legacy_quote_order==order
    url='/api/fire/market-sources/tests'
    first=await legacy.get(url);assert first.status_code==200,first.text
    assert first.json()['results']['futu']['state']=='untested' and not calls
    request={'provider':'futu','requestId':str(uuid4())}
    tested=await legacy.post(url,json=request);assert tested.status_code==200,tested.text
    assert tested.json()['state']=='partial' and tested.json()['price']==210.25
    assert reads==['HK','CN']
    assert tested.json()['markets']['HK']['price']==409.6
    assert tested.json()['markets']['CN']['state']=='unavailable'
    assert all(value.get('observedAt') for value in tested.json()['markets'].values())
    assert (await legacy.post(url,json=request)).json()==tested.json() and len(calls)==1
    retained_futu=(await legacy.get('/api/futu/test')).json()['lastTest']
    assert retained_futu['ok'] is True and retained_futu['quote']['price']==210.25
    # Older retained source tests had one flat AAPL price, without a market map.
    flat={key:value for key,value in tested.json().items() if key not in ('markets','connectionState')}
    flat['state']='available'
    async with app.state.db.connection() as conn,conn.transaction():
        await conn.execute('UPDATE market_source_tests SET result=%s WHERE request_id=%s',(Jsonb(flat),request['requestId']))
    assert (await legacy.get('/api/futu/test')).json()['lastTest']['quote']['price']==210.25
    async with app.state.db.connection() as conn,conn.transaction():
        await conn.execute('UPDATE market_source_tests SET result=%s WHERE request_id=%s',(Jsonb(tested.json()),request['requestId']))
    assert (await legacy.post(url,json={**request,'provider':'tencent'})).status_code==409
    assert (await legacy.get(url)).json()['results']['futu']==tested.json() and len(calls)==1
    # A newer connection-only probe preserves independently checked markets.
    checked=await legacy.post('/api/futu/test',json={'host':'192.0.2.41','port':'11111','requestId':str(uuid4())})
    assert checked.status_code==200,checked.text
    merged=(await legacy.get(url)).json()['results']['futu']
    assert merged['state']=='partial' and merged['markets']['HK']==tested.json()['markets']['HK']
    assert merged['markets']['CN']==tested.json()['markets']['CN'] and reads==['HK','CN']
    missing=await legacy.post(url,json={'provider':'eastmoney','requestId':str(uuid4())})
    assert missing.status_code==200 and missing.json()['state']=='unconfigured' and len(calls)==2
    entered=asyncio.Event()
    async def interrupted(self,policy,action):
        calls.append(action);entered.set();await asyncio.Event().wait()
    monkeypatch.setattr(Transport,'diagnostic',interrupted)
    pending={'provider':'futu','requestId':str(uuid4())}
    task=asyncio.create_task(legacy.post(url,json=pending))
    await asyncio.wait_for(entered.wait(),3)
    task.cancel()
    try:await task
    except asyncio.CancelledError:pass
    unknown=await legacy.post(url,json=pending)
    assert unknown.status_code==200 and unknown.json()['state']=='unknown' and len(calls)==3
    assert (await legacy.get(url)).json()['results']['futu']['state']=='unknown'
    state=(await legacy.get(P)).json()
    rejected=await legacy.put(P,json={'requestId':str(uuid4()),'revision':state['revision'],'privateRevision':state['privateRevision'],'currentPassword':'Synthetic9Pass','quoteSourceOrder':['futu']*4})
    assert rejected.status_code==422 and (await legacy.get(P)).json()['settings']['quoteSourceOrder']==order
