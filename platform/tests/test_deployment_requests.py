import asyncio
import io
import urllib.error
from uuid import uuid4

from alcor_api import __version__, deployments
from alcor_api import deployment_watchtower as bridge
from alcor_api.config import ROOT
from pydantic import SecretStr

P = "/api/deployment"


def configure(app, monkeypatch):
    settings = app.state.settings
    settings.deployment_repository = "synthetic/alcor-api"
    settings.deployment_image = "ghcr.io/synthetic/alcor-api"
    settings.deployment_github_token = SecretStr("synthetic-github-token")
    settings.deployment_runner_token = SecretStr("synthetic-runner-token-" + "x" * 32)
    settings.deployment_updater_url = "http://alcor-watchtower:8080"
    monkeypatch.setattr(bridge, "probe", lambda _: {"configured": True, "online": True, "kind": "watchtower"})
    monkeypatch.setattr(bridge, "notify", lambda _: {"status": "running", "message": "accepted"})
    release = deployments.Release(
        version=__version__,
        image=settings.deployment_image + "@sha256:" + "a" * 64,
        revision="b" * 40,
        schema_hash=deployments.schema_hash(ROOT / "migrations"),
    )
    calls = []

    def github(settings, path, body=None):
        calls.append((path, body))
        if path == "/releases/latest":
            return {"body": release.model_dump_json(), "target_commitish": release.revision}
        if path.endswith("/dispatches"):
            return {}
        if path == "/commits/main":
            return {"sha": "c" * 40}
        if path.startswith("/releases?"):
            return []
        if "status=" in path:
            return {"workflow_runs": []}
        return {"workflow_runs": [{"status": "completed", "conclusion": "success", "head_sha": "b" * 40}]}

    monkeypatch.setattr(deployments, "github_json", github)
    from alcor_api import deployment_observations

    monkeypatch.setattr(deployment_observations, "github_json", github)
    return release, calls, {"authorization": "Bearer " + settings.deployment_runner_token.get_secret_value()}


async def test_admin_only_csrf_and_no_unconfigured_dispatch(client, admin):
    result = await client.get(P)
    assert result.status_code == 200 and not result.json()["configured"]
    assert result.json()["release"] is None and not result.json()["can_update"]
    assert (await client.post(P + "/builds", json={"request_id": str(uuid4())})).status_code == 409
    client.cookies.clear()
    assert (await client.get(P)).status_code == 401
    registered = await client.post(
        "/api/session/register", json={"username": "NormalUser", "password": "Synthetic9Pass"}
    )
    # Existing fixture admin already occupies first registration.
    assert registered.status_code == 201, registered.text
    assert (await client.get(P)).status_code == 403


async def test_request_uuid_concurrency_and_runtime_recovery_survive_github_failure(client, admin, app, monkeypatch):
    release, _calls, headers = configure(app, monkeypatch)
    sent = []
    monkeypatch.setattr(bridge, "notify", lambda _: sent.append(True) or {"status": "running", "message": "accepted"})
    assert (await client.post(P + "/runner/claim", headers=headers)).status_code == 410
    assert (await client.post(P + "/runner/finish", headers=headers)).status_code == 410
    assert (await client.get(P)).json()["can_update"]
    data = {"request_id": str(uuid4()), "release": release.model_dump()}
    responses = await asyncio.gather(*[client.post(P + "/requests", json=data) for _ in range(2)])
    assert all(r.status_code == 202 for r in responses), [r.text for r in responses]
    assert responses[0].json()["id"] == responses[1].json()["id"] and sent == [True]
    assert responses[0].json()["revision"] == release.revision
    assert (await client.post(P + "/requests", json={**data, "request_id": str(uuid4())})).status_code == 409

    def offline(*_args, **_kwargs):
        raise OSError("synthetic network failure")

    monkeypatch.setattr(deployments, "github_json", offline)
    assert (await client.post(P + "/requests", json=data)).json()["status"] == "running"
    assert (await client.get(P + "/requests/" + data["request_id"])).json()["status"] == "running"
    app.state.settings.source_revision = release.revision
    async with app.state.db.connection() as conn:
        await conn.execute("INSERT INTO worker_heartbeats(worker_id,version) VALUES(%s,%s)", (uuid4(), __version__))
    assert (await client.get(P + "/requests/" + data["request_id"])).json()["status"] == "succeeded"
    observed = await client.get(P)
    assert observed.json()["release_error"] and sent == [True]
    assert "synthetic-github-token" not in observed.text and "synthetic-runner-token" not in observed.text


async def test_no_runner_schema_mismatch_stale_release_and_csrf(client, admin, app, monkeypatch):
    release, _calls, _headers = configure(app, monkeypatch)
    data = {"request_id": str(uuid4()), "release": release.model_dump()}
    app.state.settings.deployment_updater_url = None
    assert (await client.post(P + "/requests", json=data)).status_code == 409
    app.state.settings.deployment_updater_url = "http://alcor-watchtower:8080"
    client.headers["x-csrf-token"] = "wrong"
    assert (await client.post(P + "/requests", json=data)).status_code == 403
    login = await client.post("/api/session/login", json={"login": "AdminOne", "password": "Synthetic9Pass"})
    client.headers["x-csrf-token"] = login.json()["csrf"]
    bad = {**data, "release": {**data["release"], "version": "0.1.98"}}
    assert (await client.post(P + "/requests", json=bad)).status_code == 409
    release.schema_hash = "c" * 64
    data["release"] = release.model_dump()
    assert not (await client.get(P)).json()["schema_compatible"]
    assert (await client.post(P + "/requests", json=data)).status_code == 409


async def test_build_unknown_is_durable_and_never_redispatched(client, admin, app, monkeypatch):
    _release, calls, _headers = configure(app, monkeypatch)

    prior = deployments.github_json

    def uncertain(settings, path, body=None):
        if path.endswith("/dispatches"):
            calls.append((path, body))
            raise TimeoutError()
        return prior(settings, path, body)

    monkeypatch.setattr(deployments, "github_json", uncertain)
    data = {"request_id": str(uuid4())}
    first = await client.post(P + "/builds", json=data)
    assert first.status_code == 202 and first.json()["status"] == "unknown"
    again = await client.post(P + "/builds", json=data)
    assert again.json() == first.json() and sum(path.endswith("/dispatches") for path, _ in calls) == 1
    receipt = await client.get(P + "/builds/" + data["request_id"])
    assert receipt.json() == first.json()
    assert (await client.post(P + "/builds", json={"request_id": str(uuid4())})).status_code == 409


async def test_explicit_github_rejections_are_failed_not_unknown_and_do_not_block_retry(client, admin, app, monkeypatch):
    _release, calls, _headers = configure(app, monkeypatch)
    prior = deployments.github_json
    status = 403

    def provider(settings, path, body=None):
        if path.endswith("/dispatches"):
            calls.append((path, body))
            raise urllib.error.HTTPError("https://github.invalid/private", status, "private-token-value", {}, io.BytesIO(b"private-provider-body"))
        return prior(settings, path, body)

    monkeypatch.setattr(deployments, "github_json", provider)
    for status in (401, 403, 404, 422, 429):
        payload = {"request_id": str(uuid4())}
        first = await client.post(P + "/builds", json=payload)
        assert first.status_code == 202 and first.json()["status"] == "failed", first.text
        assert "GitHub" in first.json()["message"] and "private" not in first.text
        count = len(calls)
        replay = await client.post(P + "/builds", json=payload)
        assert replay.json()["status"] == "failed" and len(calls) == count
        assert (await client.get(P + "/builds/" + payload["request_id"])).json()["status"] == "failed"
    monkeypatch.setattr(deployments, "github_json", prior)
    assert (await client.post(P + "/builds", json={"request_id": str(uuid4())})).json()["status"] == "submitted"


async def test_github_server_error_keeps_uncertainty_and_prevents_redispatch(client, admin, app, monkeypatch):
    _release, calls, _headers = configure(app, monkeypatch)
    prior = deployments.github_json

    def provider(settings, path, body=None):
        if path.endswith("/dispatches"):
            calls.append((path, body))
            raise urllib.error.HTTPError("https://github.invalid", 503, "private", {}, io.BytesIO())
        return prior(settings, path, body)

    monkeypatch.setattr(deployments, "github_json", provider)
    payload = {"request_id": str(uuid4())}
    first = await client.post(P + "/builds", json=payload)
    assert first.json()["status"] == "unknown"
    assert (await client.post(P + "/builds", json=payload)).json() == first.json()
    assert sum(path.endswith("/dispatches") for path, _ in calls) == 1


async def test_unknown_update_requires_explicit_target_bound_close_before_new_notification(client, admin, app, monkeypatch):
    release, _calls, _headers = configure(app, monkeypatch)
    sent = []
    monkeypatch.setattr(bridge, "notify", lambda _: sent.append(True) or {"status": "unknown", "message": "uncertain"})
    payload = {"request_id": str(uuid4()), "release": release.model_dump()}
    first = await client.post(P + "/requests", json=payload)
    assert first.status_code == 202 and first.json()["status"] == "unknown"
    assert not (await client.get(P)).json()["can_update"]
    assert (await client.post(P + "/requests", json={**payload, "request_id": str(uuid4())})).status_code == 409
    path = P + "/requests/" + payload["request_id"] + "/close"
    wrong = {"release": {**release.model_dump(), "revision": "f" * 40}}
    assert (await client.post(path, json=wrong)).status_code == 409
    closed = await client.post(path, json={"release": release.model_dump()})
    assert closed.status_code == 200 and closed.json()["status"] == "cancelled"
    assert (await client.post(path, json={"release": release.model_dump()})).json()["status"] == "cancelled"
    assert sent == [True] and (await client.get(P)).json()["can_update"]
    replay = await client.post(P + "/requests", json=payload)
    assert replay.json()["status"] == "cancelled" and sent == [True]
    async with app.state.db.connection() as conn:
        audit = await (await conn.execute("SELECT count(*) AS n FROM audit_events WHERE action='deployment.observation_closed' AND request_id=%s", (payload["request_id"],))).fetchone()
    assert audit["n"] == 1
    assert (await client.post(P + "/requests", json={**payload, "request_id": str(uuid4())})).status_code == 202
    assert sent == [True, True]


async def test_build_confirmation_rejects_changed_main_before_dispatch(client, admin, app, monkeypatch):
    _release, calls, _headers = configure(app, monkeypatch)
    payload = {"request_id": str(uuid4()), "expected_revision": "d" * 40}
    assert (await client.post(P + "/builds", json=payload)).status_code == 409
    assert not any(path.endswith("/dispatches") for path, _ in calls)
    async with app.state.db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM deployment_builds")).fetchone()
    payload["expected_revision"] = "c" * 40
    assert (await client.post(P + "/builds", json=payload)).status_code == 202
    assert next(body for path, body in calls if path.endswith("/dispatches"))["inputs"]["expected_revision"] == "c" * 40


async def test_discovery_rejects_other_image_repository(client, admin, app, monkeypatch):
    release, _calls, _headers = configure(app, monkeypatch)
    release.image = "ghcr.io/other/project@sha256:" + "a" * 64
    result = (await client.get(P)).json()
    assert result["release"] is None and result["release_error"] and not result["can_update"]


async def test_failed_original_github_run_recovers_without_dispatch(client, admin, app, monkeypatch):
    _release, calls, _headers = configure(app, monkeypatch)
    request_id = uuid4()
    async with app.state.db.connection() as conn:
        await conn.execute("INSERT INTO deployment_builds(owner_id,request_id,status,repository) VALUES(%s,%s,'unknown',%s)",
                           (admin, request_id, app.state.settings.deployment_repository))
    def github(_settings, path, body=None):
        assert body is None and "/runs?" in path
        return {"workflow_runs": [{"event": "workflow_dispatch", "path": ".github/workflows/docker-publish.yml",
                "head_branch": "main", "display_title": "发布 · " + str(request_id), "status": "completed", "conclusion": "failure"}]}
    monkeypatch.setattr(deployments, "github_json", github)
    result = await client.get(P + "/builds/" + str(request_id))
    assert result.json()["status"] == "failed" and "未成功" in result.json()["message"]
    assert not calls
