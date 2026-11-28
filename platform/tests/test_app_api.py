"""The stable App entrance exercises the same contracts and real PG records."""

import asyncio
import base64
import hashlib
import re
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from alcor_api import __version__
from alcor_api.app_api import APP_PREFIX, FIXED_TARGETS, VERSIONED_PREFIX, app_route_patterns, native_family
from alcor_api.cli import create_user
from test_legacy_trade_corrections import native_headers
from test_native_ledger import LEDGER, SCOPES, TRANSACTIONS, data, order, trade
from test_trading import setup


def paths(value):
    if isinstance(value, dict):
        for item in value.values():
            yield from paths(item)
    elif isinstance(value, list):
        for item in value:
            yield from paths(item)
    elif isinstance(value, str) and value.startswith("/api/"):
        yield value


async def test_discovery_is_one_app_entrance_with_original_v1_v2_contracts(client, app):
    old, modern, stable = await asyncio.gather(
        client.get("/api/v1/auth/config"),
        client.get("/api/v2/auth/config"),
        client.get(APP_PREFIX + "/auth/config"),
    )
    assert [response.status_code for response in (old, modern, stable)] == [200, 200, 200]
    old, modern, stable = [response.json()["data"] for response in (old, modern, stable)]
    assert old["version"] == 1 and old["app_api_base_path"] == VERSIONED_PREFIX
    assert "canonical_app_path" not in old
    assert modern["version"] == stable["version"] == 2
    assert modern["token_path"] == "/api/v2/auth/token"
    assert modern["app_api_base_path"] == VERSIONED_PREFIX
    assert modern["canonical_app_path"] == stable["app_api_base_path"] == APP_PREFIX
    assert stable["authorization_path"] == "/app/authorize"
    assert stable["redirect_uri"] == old["redirect_uri"] == modern["redirect_uri"]
    assert stable["client_id"] == old["client_id"] == modern["client_id"]
    assert stable["security"]["email_verification_delivery"] == modern["security"]["email_verification_delivery"]
    assert stable["authorization_submit_path"] == APP_PREFIX + "/auth/authorize"
    assert stable["native_login"]["email_registration"]["request_path"] == APP_PREFIX + "/auth/register/email/request"
    patterns = app_route_patterns(app.routes)
    for value in paths(stable):
        assert value == APP_PREFIX or value.startswith(APP_PREFIX + "/"), value
        if value == APP_PREFIX:
            continue
        suffix = value.removeprefix(APP_PREFIX)
        concrete = re.sub(r"\{[^}]+\}", "qa-id", suffix)
        concrete = {
            "/auth/password-reset": "/auth/password-reset/request",
            "/investment-files": "/investment-files/records",
        }.get(concrete, concrete)
        assert concrete in FIXED_TARGETS or any(
            pattern.fullmatch(VERSIONED_PREFIX + concrete)
            for pattern in patterns.get(native_family(concrete), ())
        ), value
    for method, path, status, code in (
        ("POST", "/auth/config", 405, 40501),
        ("GET", "/auth/config/", 404, 40401),
        ("GET", "/auth/mail-templates", 404, 40401),
        ("GET", "/users", 404, 40401),
        ("GET", "/fire-settings", 404, 40401),
        ("POST", "/market/sources", 404, 40401),
        ("GET", "/v1/auth/config", 404, 40401),
        ("GET", "/records", 401, None),
    ):
        response = await client.request(method, APP_PREFIX + path, follow_redirects=False)
        assert response.status_code == status, response.text
        assert "location" not in response.headers
        assert isinstance(response.json()["code"], int)
        if code is not None:
            assert response.json()["code"] == code


async def test_discovery_does_not_wait_for_registration_writer(client, db):
    initial = await client.get(APP_PREFIX + "/auth/config")
    assert initial.json()["data"]["native_login"]["email_registration"]["readiness"]["registrationOpen"]
    async with db.connection() as conn, conn.transaction():
        await conn.execute("UPDATE site_settings SET allow_register=false WHERE singleton")
        concurrent = await asyncio.wait_for(client.get(APP_PREFIX + "/auth/config"), timeout=1)
        assert concurrent.status_code == 200, concurrent.text
        assert concurrent.json()["data"]["native_login"]["email_registration"]["readiness"]["registrationOpen"]
    latest = await client.get(APP_PREFIX + "/auth/config")
    assert not latest.json()["data"]["native_login"]["email_registration"]["readiness"]["registrationOpen"]


async def test_legacy_login_and_native_grant_stay_distinct(client, admin):
    payload = {"username": "AdminOne", "password": "Synthetic9Pass"}
    old = await data(client.post("/api/v1/auth/login", json=payload))
    old_token = {"Authorization": "Bearer " + old["token"]}
    assert (await data(client.get("/api/v1/auth/me", headers=old_token)))["id"] == admin
    assert (await client.get(APP_PREFIX + "/auth/me", headers=old_token)).status_code == 401
    # The fixture also has a valid Web cookie. It cannot select an App owner.
    assert (await client.get(APP_PREFIX + "/records")).status_code == 401
    opened = await client.post(APP_PREFIX + "/auth/login", json={**payload, "client_id": "fire-ios"})
    assert opened.status_code == 200 and "set-cookie" not in opened.headers, opened.text
    pair = opened.json()["data"]
    headers = {"Authorization": "Bearer " + pair["access_token"]}
    assert (await data(client.get(APP_PREFIX + "/auth/me", headers=headers)))["id"] == admin
    assert (await data(client.get("/api/v2/auth/me", headers=headers)))["id"] == admin
    client.cookies.clear()
    for path in ("/market/sources", "/market/history?market=US&code=AAPL", "/portfolio/series"):
        legacy = await client.get("/api" + path, headers=headers)
        stable = await client.get(APP_PREFIX + path, headers=headers)
        assert stable.status_code == legacy.status_code, path
        if stable.is_success:
            stable_value, legacy_value = stable.json(), legacy.json()
            if path == "/portfolio/series":
                assert stable_value.pop("asOf") and legacy_value.pop("asOf")
            assert stable_value == legacy_value, path
        else:
            assert stable.json()["error"] == legacy.json()["error"], path
    assert (await client.get(APP_PREFIX + "/records", headers={**headers, "X-Alcor-Expected-Account": "different"})).status_code == 403
    refresh_input = {
        "grant_type": "refresh_token", "client_id": "fire-ios", "refresh_token": pair["refresh_token"],
    }
    refreshed = await data(client.post(APP_PREFIX + "/auth/token", data=refresh_input))
    assert refreshed["grant_id"] == pair["grant_id"]
    assert refreshed["scope"] == pair["scope"]
    renewed = {"Authorization": "Bearer " + refreshed["access_token"]}
    assert (await data(client.get("/api/v2/auth/me", headers=renewed)))["id"] == admin
    replay = await client.post("/api/v2/auth/token", data=refresh_input)
    assert replay.status_code == 401
    assert (await client.get(APP_PREFIX + "/auth/me", headers=renewed)).status_code == 401


async def test_stable_app_trade_and_old_route_return_original_pg_receipt(client, admin, db, app, settings):
    app.state.native_ledger_enabled = True
    app.state.db.settings.native_ledger_enabled = True
    broker, record = await setup(client, amount="0", qty="18", cost=None)
    owner = await native_headers(db, admin, SCOPES)
    second_id = await create_user(settings, "OtherNative", "Synthetic9Other")
    other = await native_headers(db, second_id, SCOPES)
    stable_ledger = LEDGER.replace(VERSIONED_PREFIX, APP_PREFIX, 1)
    stable_transactions = stable_ledger + "/transactions"
    assert (await data(client.get(APP_PREFIX + "/auth/config")))["native_ledger"]["transactions_path"] == stable_transactions
    base = await data(client.get(stable_ledger, headers=owner))
    await data(client.post(stable_transactions, headers=owner, json={
        "requestId": str(uuid4()), "kind": "adopt", "baseRevision": 0, "legacyRevision": base["legacyRevision"],
    }))
    fill = order(record["id"], broker, at="2026-10-28T22:50:00+08:00")
    body = trade(1, fill, "18", "33", "0", "-4501.05")
    body["cash"][0].pop("brokerAccountId")
    receipt = await data(client.post(stable_transactions, headers=owner, json=body))
    assert receipt["sourceRevision"] == 2
    assert await data(client.post(TRANSACTIONS, headers=owner, json=body)) == receipt
    assert await data(client.get(TRANSACTIONS + "/" + body["requestId"], headers=owner)) == receipt
    assert await data(client.get(stable_transactions + "/" + body["requestId"], headers=owner)) == receipt
    hidden = await client.get(stable_transactions + "/" + body["requestId"], headers=other)
    assert (hidden.status_code, hidden.json()["code"]) == (404, 40401)
    stale = await client.post(stable_transactions, headers=owner, json={**body, "requestId": str(uuid4())})
    assert stale.status_code == 409
    state = await data(client.get(stable_ledger, headers=owner))
    assert state["sourceRevision"] == 2
    assert state["positions"][0]["quantity"] == "33"
    assert [row["balance"] for row in state["cash"] if row["brokerAccountId"] is None] == ["-4501.05"]


async def test_browser_pkce_can_submit_to_stable_app_api_and_exchange_once(client, admin):
    verifier = "a" * 48
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    state = "b" * 48
    consent = {
        "client_id": "fire-ios", "redirect_uri": "com.fire.app:/oauth/callback",
        "response_type": "code", "scope": "portfolio.read", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256", "decision": "allow",
    }
    authorized = await data(client.post(APP_PREFIX + "/auth/authorize", json=consent))
    callback = parse_qs(urlsplit(authorized["callback"]).query)
    assert callback["state"] == [state]
    swap = {
        "client_id": "fire-ios", "grant_type": "authorization_code",
        "redirect_uri": consent["redirect_uri"], "code": callback["code"][0], "code_verifier": verifier,
    }
    pair = await data(client.post(APP_PREFIX + "/auth/token", data=swap))
    assert pair["scope"] == "portfolio.read"
    headers = {"Authorization": "Bearer " + pair["access_token"]}
    assert (await data(client.get(APP_PREFIX + "/auth/me", headers=headers)))["id"] == admin
    assert (await client.post("/api/v2/auth/token", data=swap)).status_code == 401


async def test_discovery_keeps_mail_and_alert_quarantine_semantics(client, app, db):
    app.state.price_alerts.reader = SimpleNamespace(fingerprint="synthetic-alert-reader")
    async with db.connection() as conn:
        await conn.execute(
            """
            INSERT INTO price_alert_worker_heartbeats(worker_id, origin_instance, release_version, source_fingerprint)
            VALUES (%s, %s, %s, %s)
            """,
            (uuid4(), app.state.db.settings.instance_id, __version__, "synthetic-alert-reader"),
        )
    path = APP_PREFIX + "/auth/config"
    initial = await data(client.get(path))
    assert initial["price_alerts"]["monitoring_available"]
    assert initial["security"]["email_verification_delivery"]["deliveryAllowed"]

    async with db.connection() as conn:
        await conn.execute("""
            INSERT INTO restore_quarantine(category, payload)
            VALUES ('external_delivery_disabled', '{"disabled":false}'::jsonb)
        """)
    mail_blocked = await data(client.get(path))
    assert mail_blocked["price_alerts"]["monitoring_available"]
    assert not mail_blocked["security"]["email_verification_delivery"]["deliveryAllowed"]

    async with db.connection() as conn:
        await conn.execute("""
            UPDATE restore_quarantine SET payload='{"disabled":true}'::jsonb
            WHERE category='external_delivery_disabled'
        """)
    all_blocked = await data(client.get(path))
    assert not all_blocked["price_alerts"]["monitoring_available"]
    assert not all_blocked["security"]["email_verification_delivery"]["deliveryAllowed"]


async def test_username_registration_keeps_original_receipt_and_origin_checks(client, admin):
    path = APP_PREFIX + "/auth/register"
    payload = {"username": "SyntheticAppUser", "password": "Synthetic9Pass"}
    denied = await client.post(path, json=payload, headers={"origin": "https://other.example.invalid"})
    assert denied.status_code == 403
    registered = await client.post(path, json=payload)
    assert registered.status_code == 201, registered.text
    assert registered.json()["user"]["username"] == payload["username"]
    assert registered.json()["user"]["role"] == "user"
    logged_in = await data(client.post(APP_PREFIX + "/auth/login", json={**payload, "client_id": "fire-ios"}))
    assert logged_in["user"]["id"] == registered.json()["user"]["id"]
