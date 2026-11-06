from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

from alcor_api import deployment_config as config
from alcor_api.connections import Vault
from pydantic import SecretStr

P = "/api/deployment"


async def save(
    client,
    revision=None,
    token="SyntheticGithubCredential9",
    repository="synthetic/alcor-api",
    request_id=None,
):
    return await client.put(
        P + "/config",
        json={
            "request_id": request_id or str(uuid4()),
            "revision": revision,
            "repository": repository,
            "token": token,
        },
    )


async def test_private_config_cas_blank_keeps_token_and_original_receipt(client, admin, app):
    request_id = str(uuid4())
    first = await save(client, request_id=request_id)
    assert first.status_code == 200, first.text
    assert first.json()["hasToken"] and first.json()["repository"] == "synthetic/alcor-api"
    assert "SyntheticGithubCredential9" not in first.text
    repeated = await save(client, request_id=request_id)
    assert repeated.json() == first.json()
    assert (await save(client, request_id=request_id, token="DifferentSyntheticToken")).status_code == 409
    assert (await save(client)).status_code == 409
    second = await save(client, first.json()["revision"], token="")
    assert second.status_code == 200 and second.json()["hasToken"]
    async with app.state.db.connection() as conn:
        row = await (await conn.execute("SELECT * FROM deployment_configuration")).fetchone()
        assert "SyntheticGithubCredential9" not in str(row)
        assert (
            Vault(app.state.settings.connection_secret_dir).decrypt(
                row["token_ciphertext"], "deployment", app.state.settings.instance_id
            )
            == "SyntheticGithubCredential9"
        )
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM audit_events WHERE action=%s", ("deployment.config_saved",)
                )
            ).fetchone()
        )["n"] == 2
    receipt = await client.get(P + "/config/receipts/" + request_id)
    assert receipt.json() == first.json()
    read = await client.get(P + "/config")
    assert (
        read.json()["revision"] == second.json()["revision"] and "SyntheticGithubCredential9" not in read.text
    )
    client.headers["x-csrf-token"] = "invalid"
    assert (await save(client, second.json()["revision"])).status_code == 403


async def test_effective_read_uses_saved_credentials_without_mutating_global_settings(client, admin, app):
    response = await save(client)
    assert response.status_code == 200

    class Request:
        pass

    request = Request()
    request.app = app
    settings = await config.effective(request)
    assert settings.deployment_repository == "synthetic/alcor-api"
    assert settings.deployment_image == "ghcr.io/synthetic/alcor-api"
    assert settings.deployment_github_token.get_secret_value() == "SyntheticGithubCredential9"
    assert app.state.settings.deployment_repository == ""


async def oauth_setup(client, app):
    await save(client)
    app.state.settings.public_origin = "https://testserver"
    app.state.settings.deployment_github_client_id = "SyntheticClientId"
    app.state.settings.deployment_github_client_secret = SecretStr("SyntheticClientSecret")
    client.base_url = "https://testserver"
    client.headers["origin"] = "https://testserver"
    start = await client.get(P + "/github/start")
    assert start.status_code == 303, start.text
    assert "HttpOnly" in start.headers["set-cookie"] and "Secure" in start.headers["set-cookie"]
    params = parse_qs(urlsplit(start.headers["location"]).query)
    assert params["redirect_uri"] == ["https://testserver" + config.CALLBACK]
    assert params["scope"] == ["repo workflow"]
    return params["state"][0]


async def test_oauth_session_state_is_single_use_and_token_is_encrypted(client, admin, app, monkeypatch):
    state = await oauth_setup(client, app)
    calls = []

    def exchange(url, body=None, token=None):
        calls.append(url)
        if "access_token" in url:
            return {"access_token": "SyntheticOAuthCredential9"}
        assert token == "SyntheticOAuthCredential9"
        return {"login": "SyntheticOwner"}

    monkeypatch.setattr(config, "oauth_json", exchange)
    result = await client.get(P + "/github/callback", params={"state": state, "code": "SyntheticCode"})
    assert result.status_code == 303 and "connected" in result.headers["location"]
    assert len(calls) == 2
    replay = await client.get(P + "/github/callback", params={"state": state, "code": "SyntheticCode"})
    assert "github_error" in replay.headers["location"] and len(calls) == 2
    read = await client.get(P + "/config")
    assert read.json()["githubAccount"] == "SyntheticOwner" and "SyntheticOAuthCredential9" not in read.text
    async with app.state.db.connection() as conn:
        row = await (await conn.execute("SELECT * FROM deployment_configuration")).fetchone()
        assert "SyntheticOAuthCredential9" not in str(row)
    disconnected = await client.request("DELETE", P + "/config", json={"revision": read.json()["revision"]})
    assert disconnected.status_code == 200 and not disconnected.json()["githubAccount"]
    assert disconnected.json()["hasToken"]  # manual fallback is retained


async def test_oauth_denies_revoked_owner_without_exchanging_code(client, admin, app, monkeypatch):
    state = await oauth_setup(client, app)
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE users SET active=false WHERE id=%s", (admin,))

    def forbidden(*args):
        raise AssertionError("revoked owner must not exchange a code")

    monkeypatch.setattr(config, "oauth_json", forbidden)
    response = await client.get(P + "/github/callback", params={"state": state, "code": "SyntheticCode"})
    assert response.status_code == 303 and "github_error" in response.headers["location"]


async def test_oauth_missing_cookie_is_rejected(client, admin, app, monkeypatch):
    state = await oauth_setup(client, app)
    client.cookies.clear()

    def forbidden(*args):
        raise AssertionError("missing cookie must not exchange code")

    monkeypatch.setattr(config, "oauth_json", forbidden)
    response = await client.get(P + "/github/callback", params={"state": state, "code": "SyntheticCode"})
    assert "github_error" in response.headers["location"]


async def test_oauth_missing_provider_and_https_are_actual_errors(client, admin, app):
    assert (await client.get(P + "/github/start")).status_code == 503
    app.state.settings.deployment_github_client_id = "SyntheticClient"
    app.state.settings.deployment_github_client_secret = SecretStr("SyntheticClientSecret")
    assert (await client.get(P + "/github/start")).status_code == 409


async def test_config_saving_to_wrong_fixed_image_target_is_rejected(client, admin, app):
    app.state.settings.deployment_image = "ghcr.io/fixed/alcor-api"
    assert (await save(client)).status_code == 409


async def test_oauth_changed_configuration_cannot_overwrite_newer_save(client, admin, app, monkeypatch):
    state = await oauth_setup(client, app)
    current = (await client.get(P + "/config")).json()
    assert (await save(client, current["revision"], token="NewerSyntheticManualToken")).status_code == 200

    def exchange(url, body=None, token=None):
        return (
            {"access_token": "SyntheticStaleOAuthToken"} if "access_token" in url else {"login": "StaleOwner"}
        )

    monkeypatch.setattr(config, "oauth_json", exchange)
    result = await client.get(P + "/github/callback", params={"state": state, "code": "SyntheticCode"})
    assert "github_error" in result.headers["location"]
    assert not (await client.get(P + "/config")).json()["githubAccount"]


async def test_pre_clear_token_receipt_fingerprint_still_replays(client, admin, app):
    """Adding an optional clear-token field must not invalidate accepted older UUIDs."""
    from alcor_api.security import digest
    from psycopg.types.json import Jsonb

    identifier = str(uuid4())
    prior = {
        "repository": "synthetic/alcor-api",
        "revision": str(uuid4()),
        "hasToken": True,
        "githubAccount": "",
        "oauthAvailable": False,
    }
    old_serialized = '{"revision":null,"repository":"synthetic/alcor-api","token":"**********"}'
    old_fingerprint = digest(old_serialized.replace("**********", digest("SyntheticGithubCredential9")))
    async with app.state.db.connection() as conn:
        await conn.execute(
            "INSERT INTO deployment_config_actions VALUES(%s,%s,%s,%s)",
            (admin, identifier, old_fingerprint, Jsonb(prior)),
        )
    result = await save(client, request_id=identifier)
    assert result.status_code == 200 and result.json() == prior, result.text
    async with app.state.db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM deployment_configuration")).fetchone()


async def test_oauth_callback_rejects_later_session_even_same_admin(client, admin, app, monkeypatch):
    state = await oauth_setup(client, app)
    nonce = client.cookies[config.COOKIE]
    assert (
        await client.post("/api/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"})
    ).status_code == 200
    client.cookies.set(config.COOKIE, nonce, domain="testserver.local", path=config.CALLBACK)
    calls = []
    monkeypatch.setattr(config, "oauth_json", lambda *args: calls.append(args))
    result = await client.get(P + "/github/callback", params={"state": state, "code": "SyntheticCode"})
    assert result.status_code == 303 and "github_error" in result.headers["location"] and not calls
    async with app.state.db.connection() as conn:
        assert (
            await (await conn.execute("SELECT oauth_ciphertext FROM deployment_configuration")).fetchone()
        )["oauth_ciphertext"] is None


async def test_oauth_callback_other_admin_does_not_exchange_or_change_global_configuration(
    client, admin, app, settings, monkeypatch
):
    from alcor_api.cli import create_user

    state = await oauth_setup(client, app)
    nonce = client.cookies[config.COOKIE]
    async with app.state.db.connection() as conn:
        prior = await (await conn.execute("SELECT * FROM deployment_configuration")).fetchone()
    await create_user(settings, "OtherOAuthAdmin", "Synthetic9Pass", role="admin")
    assert (
        await client.post(
            "/api/session/login", json={"login": "OtherOAuthAdmin", "password": "Synthetic9Pass"}
        )
    ).status_code == 200
    client.cookies.set(config.COOKIE, nonce, domain="testserver.local", path=config.CALLBACK)
    calls = []
    monkeypatch.setattr(config, "oauth_json", lambda *args: calls.append(args))
    result = await client.get(P + "/github/callback", params={"state": state, "code": "SyntheticCode"})
    assert result.status_code == 303 and "github_error" in result.headers["location"] and not calls
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT * FROM deployment_configuration")).fetchone()) == prior
        assert (await (await conn.execute("SELECT consumed_at FROM deployment_oauth_states")).fetchone())[
            "consumed_at"
        ] is None
