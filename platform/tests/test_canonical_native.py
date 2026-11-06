"""Canonical and legacy identity adapters share operations against private PG."""

import base64
import hashlib
from urllib.parse import parse_qs, urlsplit

import test_legacy_identity as old
from alcor_api.native_app_auth import CLIENT, REDIRECT

# The original contract tests must pass with the extracted shared operations.
test_legacy_native_rotation = old.test_native_v2_login_has_no_cookie_coupling_and_tokens_rotate_without_replay
test_legacy_ticket_protocol = old.test_legacy_v1_ticket_and_bearer_shape_do_not_become_v2_cookie_fallback


async def test_canonical_login_strict_client_origin_and_cookie_independent_grant(client, admin, app):
    paths = app.openapi()["paths"]
    for path in (
        "config",
        "login",
        "login/totp",
        "me",
        "token",
        "revoke",
        "permissions",
        "consent",
        "authorize",
    ):
        assert "/api/client/" + path in paths
    config = await client.get("/api/client/config")
    assert config.status_code == 200, config.text
    assert config.json()["native_login"]["login_path"] == "/api/client/login"
    assert (await client.get("/api/client/me")).status_code == 401
    data = {"client_id": CLIENT, "username": "AdminOne", "password": "Synthetic9Pass"}
    assert (await client.post("/api/client/login", json=data | {"client_id": "wrong"})).status_code == 400
    assert (
        await client.post("/api/client/login", json=data, headers={"origin": "https://other.example.invalid"})
    ).status_code == 403
    result = await client.post("/api/client/login", json=data)
    assert result.status_code == 200, result.text
    assert "set-cookie" not in result.headers
    pair = result.json()
    assert pair["user"]["role"] == "user"
    headers = {"authorization": "Bearer " + pair["access_token"]}
    assert (await client.get("/api/client/me", headers=headers)).status_code == 200
    rotated = await client.post(
        "/api/client/token",
        json={"client_id": CLIENT, "grant_type": "refresh_token", "refresh_token": pair["refresh_token"]},
    )
    assert rotated.status_code == 200, rotated.text
    assert rotated.json()["grant_id"] == pair["grant_id"]
    assert (
        await client.post(
            "/api/client/token",
            json={"client_id": CLIENT, "grant_type": "refresh_token", "refresh_token": pair["refresh_token"]},
        )
    ).status_code == 401
    assert (
        await client.get(
            "/api/client/me", headers={"authorization": "Bearer " + rotated.json()["access_token"]}
        )
    ).status_code == 401


async def test_canonical_pkce_and_consent_share_legacy_grants_without_cookie_fallback(client, admin):
    verifier = "x" * 43
    data = {
        "client_id": CLIENT,
        "redirect_uri": REDIRECT,
        "response_type": "code",
        "scope": "portfolio.read security.read",
        "state": "s" * 32,
        "code_challenge": base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
        .decode()
        .rstrip("="),
        "code_challenge_method": "S256",
        "decision": "allow",
    }
    authorized = await client.post("/api/client/authorize", json=data)
    assert authorized.status_code == 200, authorized.text
    code = parse_qs(urlsplit(authorized.json()["callback"]).query)["code"][0]
    payload = {
        "grant_type": "authorization_code",
        "client_id": CLIENT,
        "redirect_uri": REDIRECT,
        "code": code,
        "code_verifier": verifier,
    }
    assert (
        await client.post("/api/client/token", json=payload | {"code_verifier": "z" * 43})
    ).status_code == 401
    pair = (await client.post("/api/client/token", json=payload)).json()
    assert (await client.post("/api/client/token", json=payload)).status_code == 401
    headers = {"authorization": "Bearer " + pair["access_token"]}
    assert (await client.post("/api/client/authorize", json=data, headers=headers)).status_code == 403
    descriptor = (await client.get("/api/client/consent", headers=headers)).json()
    assert (
        await client.post(
            "/api/client/consent", json={"client_id": CLIENT, "revision": "stale"}, headers=headers
        )
    ).status_code == 409
    result = await client.post(
        "/api/client/consent", json={"client_id": CLIENT, "revision": descriptor["revision"]}, headers=headers
    )
    assert result.json()["status"] == "unchanged"
    upgraded = await client.post(
        "/api/client/permissions", json={"client_id": CLIENT, "scope": "security.write"}, headers=headers
    )
    assert upgraded.status_code == 200, upgraded.text
    assert upgraded.json()["replaces_grant_id"] == pair["grant_id"]
    assert (await client.get("/api/client/me", headers=headers)).json()["scope"] == pair["scope"]
    assert (await client.get("/api/client/consent")).status_code == 401
    assert (
        await client.post("/api/client/revoke", json={"client_id": CLIENT, "token": pair["access_token"]})
    ).json() == {"revoked": True}
    assert (await client.get("/api/client/me", headers=headers)).status_code == 401


async def test_canonical_factor_login_preserves_one_use_challenge(db, settings, client):
    await old.prepare(db, settings)
    response = await client.post(
        "/api/client/login",
        json={"client_id": CLIENT, "username": "SourceAdmin", "password": "SyntheticSource9"},
    )
    assert response.status_code == 200, response.text
    token = response.json()["challenge_token"]
    payload = {"client_id": CLIENT, "challenge_token": token, "code": "ABCD-1234-5678-90EF"}
    result = await client.post("/api/client/login/totp", json=payload)
    assert result.status_code == 200, result.text
    assert result.json()["status"] == "authenticated"
    assert not client.cookies
    assert (await client.post("/api/client/login/totp", json=payload)).status_code == 403


async def test_canonical_and_legacy_login_share_account_throttle(client):
    for index in range(21):
        path = "/api/client/login" if index % 2 else "/api/v2/auth/login"
        response = await client.post(
            path,
            json={"client_id": CLIENT, "username": "SyntheticUnknownLogin", "password": "Synthetic9Pass"},
        )
        assert response.status_code == (403 if index < 20 else 429)


async def test_canonical_discovery_only_advertises_implemented_paths_and_keeps_legacy(client, app):
    legacy = (await client.get("/api/v2/auth/config")).json()["data"]
    assert legacy["app_api_base_path"] == "/api/v2"
    canonical = (await client.get("/api/client/config")).json()
    assert canonical["app_api_base_path"] == "/api/client"
    assert canonical["passkey_registration"]["supported"] is False
    assert canonical["upload_path"] == "/api/client/profile/avatar"
    assert "feed_path" not in canonical
    paths = app.openapi()["paths"]

    def links(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if (key.endswith("_path") or key == "path") and key != "app_api_base_path":
                    yield item
                else:
                    yield from links(item)
        elif isinstance(value, list):
            for item in value:
                yield from links(item)

    for path in links(canonical):
        # Recovery advertises the historical action base; clients append one of
        # these three concrete protocol actions. Other paths are concrete URLs.
        concrete = [path + "/" + action for action in ("request", "verify", "confirm")] if path == "/api/client/auth/password-reset" else [path]
        for target in concrete:
            assert not target.startswith("/api/v"), target
            assert any(
                getattr(route, "methods", None)
                and route.path_regex.fullmatch(target)
                and route.path in paths
                for route in app.routes
            ), target


async def test_canonical_calendar_uses_real_unversioned_routes(client, app):
    from alcor_api.market_calendar import Calendars

    await Calendars(app.state.db).ensure_builtin()
    legacy = (await client.get("/api/v2/auth/config")).json()["data"]["market_calendar"]
    canonical = (await client.get("/api/client/config")).json()["market_calendar"]
    assert legacy["path"] == "/api/v2/market-calendar"
    assert canonical["path"] == "/api/reference/calendar"
    assert canonical["batch_path"] == "/api/reference/calendar/batch"
    assert "api_version" not in canonical
    assert canonical["markets"] == legacy["markets"]
    for key in ("path", "batch_path"):
        assert canonical[key] in app.openapi()["paths"]
