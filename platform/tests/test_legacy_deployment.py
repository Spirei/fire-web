"""Legacy deployment protocols tested only against verified synthetic PG and fake providers."""

import asyncio
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import pytest_asyncio
from alcor_api import deployment_config as configuration
from alcor_api import deployment_watchtower as bridge
from alcor_api import deployments
from alcor_api.cli import create_user
from alcor_api.legacy_deployment import PREFIX as P
from alcor_api.legacy_deployment import mount_legacy_deployment
from alcor_api.security import digest
from pydantic import SecretStr
from request_telemetry_tables import business_table_hashes


async def business_hashes(conn):
    return await business_table_hashes(conn)


@pytest_asyncio.fixture
async def legacy(app, admin, monkeypatch):
    if not any(getattr(route, "path", None) == P for route in app.routes):
        before = len(app.router.routes)
        mount_legacy_deployment(app, app.state.settings, app.state.db)
        new = app.router.routes[before:]
        app.router.routes[:] = new + app.router.routes[:before]

    def offline(*args, **kwargs):
        raise AssertionError("test may not call GitHub, OAuth, or updater")

    monkeypatch.setattr(deployments, "github_json", offline)
    monkeypatch.setattr(bridge, "notify", offline)
    monkeypatch.setattr(configuration, "oauth_json", offline)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as client:
        result = await client.post(
            "/api/auth/login", json={"username": "AdminOne", "password": "Synthetic9Pass"}
        )
        assert result.status_code == 200
        yield client


async def save(client, revision=None, **fields):
    return await client.put(
        P + "/config",
        json={
            "request_id": str(uuid4()),
            "revision": revision,
            "repository": "synthetic/alcor-api",
            **fields,
        },
    )


async def test_legacy_unconfigured_reads_are_unknown_no_write_and_no_probe(legacy, app, db):
    async with db.connection() as conn, conn.transaction():
        before = await business_hashes(conn)
    status = await legacy.get(P)
    assert status.status_code == 200, status.text
    value = status.json()
    assert value["source"] is None and value["runs"] is None and value["heatmap"] is None
    assert value["workflowRunCount"] is None and value["runtime"]["sha"] == "unknown"
    assert value["image"]["matchesMain"] is None
    config = await legacy.get(P + "/config")
    assert config.status_code == 200 and config.json()["revision"] is None and not config.json()["hasToken"]
    runner = await legacy.get(P + "/container-update")
    assert (
        runner.status_code == 200 and runner.json()["observedAt"] is None and not runner.json()["available"]
    )
    async with db.connection() as conn, conn.transaction():
        assert await business_hashes(conn) == before


async def test_legacy_matching_runtime_needs_same_version_fresh_worker(legacy, app, db, monkeypatch):
    from alcor_api import __version__
    from test_deployment_requests import configure

    release, _calls, _headers = configure(app, monkeypatch)
    app.state.settings.source_revision = release.revision
    first = await legacy.get(P)
    assert first.status_code == 200, first.text
    assert first.json()["runtime"]["sha"] == release.revision
    assert first.json()["runtime"]["ready"] is False
    assert first.json()["runtime"]["matchesImage"] is False
    async with db.connection() as conn:
        worker = uuid4()
        await conn.execute("INSERT INTO worker_heartbeats(worker_id,version) VALUES(%s,'0.0.0')", (worker,))
    assert (await legacy.get(P)).json()["runtime"]["matchesImage"] is False
    async with db.connection() as conn:
        await conn.execute("UPDATE worker_heartbeats SET version=%s WHERE worker_id=%s", (__version__, worker))
    ready = (await legacy.get(P)).json()["runtime"]
    assert ready["ready"] is True and ready["matchesImage"] is True
    async with db.connection() as conn:
        await conn.execute("UPDATE worker_heartbeats SET observed_at=clock_timestamp()-interval '1 minute' WHERE worker_id=%s", (worker,))
    assert (await legacy.get(P)).json()["runtime"]["matchesImage"] is False


async def test_config_uuid_cas_clear_manual_token_and_disconnect_receipt(legacy, db):
    first = await save(legacy, token="SyntheticDeploySecret9")
    assert first.status_code == 200, first.text
    assert first.json()["hasToken"] and "SyntheticDeploySecret9" not in first.text
    identifier = str(uuid4())
    command = {
        "request_id": identifier,
        "revision": first.json()["revision"],
        "repository": "synthetic/alcor-api",
        "clearToken": True,
    }
    cleared = await legacy.put(P + "/config", json=command)
    assert cleared.status_code == 200 and not cleared.json()["hasToken"], cleared.text
    assert (await legacy.put(P + "/config", json=command)).json() == cleared.json()
    assert (await legacy.get(P + "/config/receipts/" + identifier)).json() == cleared.json()
    assert (
        await legacy.put(P + "/config", json=command | {"repository": "other/alcor-api"})
    ).status_code == 409
    async with db.connection() as conn:
        assert (
            await (await conn.execute("SELECT token_ciphertext FROM deployment_configuration")).fetchone()
        )["token_ciphertext"] is None
    disconnect = {"request_id": str(uuid4()), "revision": cleared.json()["revision"]}
    removed = await legacy.request("DELETE", P + "/config", json=disconnect)
    assert removed.status_code == 200 and removed.json()["ok"], removed.text
    assert (await legacy.request("DELETE", P + "/config", json=disconnect)).json() == removed.json()
    assert (await legacy.get(removed.json()["receiptUrl"])).json()["revision"] == removed.json()["revision"]
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM audit_events WHERE action='deployment.oauth_disconnected'"
                )
            ).fetchone()
        )["n"] == 1


async def test_writes_without_original_proof_and_nonadmin_cannot_issue_commands(legacy, app, settings, db):
    for method, path, payload in [
        ("PUT", P + "/config", {"repository": "synthetic/alcor-api"}),
        ("DELETE", P + "/config", {}),
        ("POST", P, {}),
        ("POST", P + "/container-update", {}),
    ]:
        assert (await legacy.request(method, path, json=payload)).status_code == 422
    assert (await legacy.get(P, headers={"authorization": "Bearer invalid"})).status_code == 403
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as peer:
        assert (await peer.get(P)).status_code == 403
        await create_user(settings, "DeploymentReader", "Synthetic9Pass", role="user")
        await peer.post(
            "/api/auth/login", json={"username": "DeploymentReader", "password": "Synthetic9Pass"}
        )
        assert (await peer.get(P + "/config")).status_code == 403
        assert (await peer.post(P, json={"request_id": str(uuid4())})).status_code == 403
    assert (await save(legacy, token="SyntheticDeploySecret9")).status_code == 200
    rejected = await save(legacy, token="OtherSecret9")
    assert rejected.status_code == 409
    assert (
        await legacy.put(
            P + "/config",
            json={
                "request_id": str(uuid4()),
                "revision": rejected.json().get("revision"),
                "repository": "synthetic/alcor-api",
            },
            headers={"origin": "https://other.invalid"},
        )
    ).status_code == 403
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM deployment_builds")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM deployment_requests")).fetchone()


async def test_aged_legacy_admin_session_saves_without_extra_password(legacy, app, db):
    token = legacy.cookies["fire_session"]
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE sessions SET created_at=clock_timestamp()-interval '16 minutes' WHERE token_hash=%s",
            (digest(token),),
        )
        before = await (
            await conn.execute(
                "SELECT created_at,expires_at FROM sessions WHERE token_hash=%s", (digest(token),)
            )
        ).fetchone()
    accepted = await save(legacy, token="SyntheticDeploySecret9")
    assert accepted.status_code == 200 and "x-alcor-reauthentication" not in accepted.headers
    async with db.connection() as conn:
        assert (
            await (
                await conn.execute(
                    "SELECT created_at,expires_at FROM sessions WHERE token_hash=%s", (digest(token),)
                )
            ).fetchone()
        ) == before
        assert (
            await (
                await conn.execute(
                    "SELECT count(*) AS n FROM identity_challenges WHERE binding=%s AND purpose='deployment-reauth'",
                    (digest(token),),
                )
            ).fetchone()
        )["n"] == 0


async def test_legacy_oauth_uses_distinct_cookie_callback_original_session_and_one_exchange(
    legacy, app, db, monkeypatch
):
    saved = await save(legacy, token="SyntheticDeploySecret9")
    assert saved.status_code == 200
    app.state.settings.public_origin = "https://testserver"
    app.state.settings.deployment_github_client_id = "SyntheticClient"
    app.state.settings.deployment_github_client_secret = SecretStr("SyntheticClientSecret")
    legacy.base_url = "https://testserver"
    legacy.headers["origin"] = "https://testserver"
    start = await legacy.get(P + "/github/start")
    assert start.status_code == 303, start.text
    params = parse_qs(urlsplit(start.headers["location"]).query)
    assert params["redirect_uri"] == ["https://testserver" + P + "/github/callback"]
    assert "alcor_legacy_deploy_oauth=" in start.headers["set-cookie"]
    assert "HttpOnly" in start.headers["set-cookie"] and "Secure" in start.headers["set-cookie"]
    state = params["state"][0]
    calls = []

    def exchange(url, body=None, token=None):
        calls.append(url)
        return (
            {"access_token": "SyntheticOAuthLegacy9"}
            if "access_token" in url
            else {"login": "SyntheticOwner"}
        )

    monkeypatch.setattr(configuration, "oauth_json", exchange)
    callback = P + "/github/callback"
    # Even the same user must use the original session, not a later login.
    original = legacy.cookies["fire_session"]
    await legacy.post("/api/auth/login", json={"username": "AdminOne", "password": "Synthetic9Pass"})
    rejected = await legacy.get(callback, params={"state": state, "code": "SyntheticCode"})
    assert "github_error" in rejected.headers["location"] and not calls
    legacy.cookies.set("fire_session", original, domain="testserver.local", path="/")
    # A failed attempt clears the nonce cookie; restore this synthetic test nonce.
    nonce = start.cookies["alcor_legacy_deploy_oauth"]
    legacy.cookies.set("alcor_legacy_deploy_oauth", nonce, domain="testserver.local", path=callback)
    result = await legacy.get(callback, params={"state": state, "code": "SyntheticCode"})
    assert result.status_code == 303 and "github=connected" in result.headers["location"], result.headers
    assert len(calls) == 2
    replay = await legacy.get(callback, params={"state": state, "code": "SyntheticCode"})
    assert "github_error" in replay.headers["location"] and len(calls) == 2
    config = await legacy.get(P + "/config")
    assert config.json()["githubAccount"] == "SyntheticOwner" and "SyntheticOAuthLegacy9" not in config.text
    async with db.connection() as conn:
        assert "SyntheticOAuthLegacy9" not in str(
            await (await conn.execute("SELECT * FROM deployment_configuration")).fetchone()
        )


async def test_durable_build_and_update_commands_only_dispatch_fake_targets_once(
    legacy, app, db, monkeypatch
):
    from test_deployment_requests import configure

    release, calls, _ = configure(app, monkeypatch)
    wakes = []
    app.state.settings.deployment_updater_url = "http://alcor-watchtower:8080/v1/update"
    monkeypatch.setattr(bridge, "probe", lambda _settings: {"configured": True, "online": True, "kind": "watchtower", "observed_at": None, "reason": "synthetic port"})
    monkeypatch.setattr(bridge, "notify", lambda settings: wakes.append(settings.deployment_image) or {"status": "running", "message": "notified"})
    identifier = str(uuid4())
    results = await asyncio.gather(*(legacy.post(P, json={"request_id": identifier}) for _ in range(2)))
    assert all(result.status_code == 202 for result in results), [result.text for result in results]
    assert all(result.json()["status"] in {"submitted", "dispatching"} for result in results)
    assert len([item for item in calls if item[0].endswith("/dispatches")]) == 1
    stored = await legacy.get(results[0].json()["receiptUrl"])
    assert stored.status_code == 200 and stored.json()["request_id"] == identifier
    assert stored.json()["status"] == "submitted"
    command = {"request_id": str(uuid4()), "release": release.model_dump()}
    update = await legacy.post(P + "/container-update", json=command)
    assert update.status_code == 202 and update.json()["pending"] is True and update.json()["ok"] is False, (
        update.text
    )
    assert len(wakes) == 1
    receipt = await legacy.get(update.json()["receiptUrl"])
    assert receipt.status_code == 200 and receipt.json()["status"] == "running"
    again = await legacy.post(P + "/container-update", json=command)
    assert again.status_code == 202 and len(wakes) == 1
    changed = await legacy.post(
        P + "/container-update", json=command | {"release": release.model_dump() | {"version": "9.9.9"}}
    )
    assert changed.status_code == 409 and len(wakes) == 1
    # A fresh page can resume the accepted request from its private status read.
    # Another administrator's pending request must never appear in that projection.
    await create_user(app.state.settings, "DeploymentPeer", "Synthetic9Pass", role="admin")
    peer_request = uuid4()
    async with db.connection() as conn:
        peer = await (await conn.execute("SELECT id FROM users WHERE username='DeploymentPeer'")).fetchone()
        await conn.execute(
            "INSERT INTO deployment_requests(id,owner_id,request_id,image,version,revision,schema_hash,status) "
            "VALUES(%s,%s,%s,%s,%s,%s,%s,'unknown')",
            (uuid4(), peer['id'], peer_request, release.image, release.version, release.revision, release.schema_hash),
        )
    observed = await legacy.get(P)
    assert observed.status_code == 200, observed.text
    requests = observed.json()["updateRequests"]
    assert [item["request_id"] for item in requests] == [command["request_id"]]
    assert requests[0]["status"] == "running" and requests[0]["revision"] == release.revision
    assert str(peer_request) not in observed.text and len(wakes) == 1


async def test_status_rechecks_current_admin_after_provider_read(legacy, app, db, monkeypatch, admin):
    original = deployments.status

    async def revoked(request, who):
        value = await original(request, who)
        async with db.connection() as conn:
            await conn.execute("UPDATE users SET role='user' WHERE id=%s", (admin,))
        return value

    monkeypatch.setattr(deployments, "status", revoked)
    result = await legacy.get(P)
    assert result.status_code == 403 and result.json() == {"error": "需要管理员权限"}


@pytest_asyncio.fixture
async def oauth_ready(legacy, app):
    assert (await save(legacy, token="SyntheticDeploySecret9")).status_code == 200
    app.state.settings.public_origin = "https://testserver"
    app.state.settings.deployment_github_client_id = "SyntheticClient"
    app.state.settings.deployment_github_client_secret = SecretStr("SyntheticClientSecret")
    legacy.base_url = "https://testserver"
    legacy.headers["origin"] = "https://testserver"
    response = await legacy.get(P + "/github/start")
    assert response.status_code == 303
    return parse_qs(urlsplit(response.headers["location"]).query)["state"][0], response.cookies[
        "alcor_legacy_deploy_oauth"
    ]


async def test_legacy_oauth_revocation_and_cross_protocol_state_never_exchange(
    legacy, oauth_ready, app, db, admin, monkeypatch
):
    state, nonce = oauth_ready
    calls = []
    monkeypatch.setattr(configuration, "oauth_json", lambda *args: calls.append(args))
    # Even with a copied nonce cookie, a legacy state cannot enter the native callback.
    legacy.cookies.set(configuration.COOKIE, nonce, domain="testserver.local", path=configuration.CALLBACK)
    foreign = await legacy.get(configuration.CALLBACK, params={"state": state, "code": "SyntheticCode"})
    assert "github_error" in foreign.headers["location"] and not calls
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET active=false WHERE id=%s", (admin,))
    revoked = await legacy.get(P + "/github/callback", params={"state": state, "code": "SyntheticCode"})
    assert "github_error" in revoked.headers["location"] and not calls
    async with db.connection() as conn:
        assert (
            await (await conn.execute("SELECT oauth_ciphertext FROM deployment_configuration")).fetchone()
        )["oauth_ciphertext"] is None


async def test_legacy_oauth_config_generation_change_never_commits_provider_secret(
    legacy, oauth_ready, db, monkeypatch
):
    state, _ = oauth_ready
    async with db.connection() as conn:
        await conn.execute("UPDATE deployment_configuration SET revision=gen_random_uuid()")
    calls = []

    def exchange(url, body=None, token=None):
        calls.append(url)
        return (
            {"access_token": "SyntheticUncommittedCredential9"}
            if "access_token" in url
            else {"login": "SyntheticOwner"}
        )

    monkeypatch.setattr(configuration, "oauth_json", exchange)
    response = await legacy.get(P + "/github/callback", params={"state": state, "code": "SyntheticCode"})
    assert "github_error" in response.headers["location"] and len(calls) == 2
    async with db.connection() as conn:
        row = await (
            await conn.execute("SELECT oauth_ciphertext,github_account FROM deployment_configuration")
        ).fetchone()
        assert row["oauth_ciphertext"] is None and row["github_account"] == ""


async def test_configured_status_maps_source_jobs_and_bounded_history_without_fabrication(
    legacy, app, db, monkeypatch
):
    from alcor_api import deployment_observations
    from test_deployment_requests import configure

    release, _, _ = configure(app, monkeypatch)
    seen = []
    when = "2026-01-03T01:02:03Z"
    run = {
        "id": 42,
        "name": "Publish AlcorApi",
        "display_title": "Synthetic build",
        "head_sha": release.revision,
        "status": "completed",
        "conclusion": "success",
        "event": "workflow_dispatch",
        "path": ".github/workflows/docker-publish.yml",
        "run_started_at": when,
        "updated_at": when,
    }

    def github(settings, path, body=None):
        assert body is None, "status must not dispatch"
        seen.append(path)
        if path == "/releases/latest":
            return {"body": release.model_dump_json(), "target_commitish": release.revision}
        if path == "/commits/main":
            return {"sha": release.revision}
        if path == "":
            return {"owner": {"login": "synthetic", "type": "User"}}
        if "/jobs?" in path:
            return {
                "jobs": [
                    {
                        "id": 9,
                        "name": "Publish linux/amd64 image",
                        "status": "completed",
                        "conclusion": "success",
                        "started_at": when,
                        "completed_at": when,
                        "steps": [
                            {
                                "number": 1,
                                "name": "Synthetic step",
                                "status": "completed",
                                "conclusion": "success",
                                "started_at": when,
                                "completed_at": when,
                            }
                        ],
                    }
                ]
            }
        if path.startswith("/commits?"):
            return (
                [{"sha": release.revision, "commit": {"committer": {"date": when}}}]
                if "page=1&" in path
                else []
            )
        return {"workflow_runs": [run], "total_count": 1}

    monkeypatch.setattr(deployments, "github_json", github)
    monkeypatch.setattr(deployment_observations, "github_json", github)
    async with db.connection() as conn, conn.transaction():
        before = await business_hashes(conn)
    result = await legacy.get(P)
    assert result.status_code == 200, result.text
    value = result.json()
    assert value["source"]["sha"] == release.revision and value["image"]["matchesMain"] is True
    assert value["runs"][0]["workflowPath"] == run["path"] and value["runs"][0]["publication"] == "published"
    assert value["runtime"]["matchesImage"] is None and value["runtime"]["sha"] == "unknown"
    assert value["imageProgress"]["jobs"][0]["steps"][0]["startedAt"] == when
    assert value["heatmap"] == {"2026-01-03": 1} and value["heatmapComplete"] is True
    assert "/actions/runs?branch=main&per_page=20&page=1" in seen
    async with db.connection() as conn, conn.transaction():
        assert await business_hashes(conn) == before
