"""Independent Watchtower transport and durable original-request observations."""

import asyncio
import io
import threading
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace
from uuid import uuid4

import pytest
from alcor_api import deployment_watchtower as bridge
from pydantic import SecretStr


def configuration(url="http://alcor-watchtower:8080/v1/update"):
    return SimpleNamespace(
        deployment_updater_url=url,
        deployment_runner_token=SecretStr("synthetic-watchtower-token-" + "x" * 32),
        deployment_image="ghcr.io/synthetic/alcor-api",
        source_revision="b" * 40,
    )


@pytest.mark.parametrize("path", ["", "/", "/v1/update"])
def test_watchtower_endpoint_uses_only_fixed_update_path(path):
    assert (
        bridge.endpoint(configuration("http://alcor-watchtower:8080" + path))
        == "http://alcor-watchtower:8080/v1/update"
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://outside.invalid/v1/update",
        "http://alcor-api-updater:8081",
        "http://localhost:8081",
        "http://watchtower:8080/other",
        "http://watchtower:8080/v1/update?image=other",
        "http://user@watchtower:8080/v1/update",
        "http://watchtower:8080/\n",
    ],
)
def test_watchtower_rejects_old_executor_and_arbitrary_targets(url):
    assert not bridge.configured(configuration(url))
    assert bridge.notify(configuration(url))["status"] == "failed"


def test_configuration_accepts_the_unified_fire_watchtower_target():
    from alcor_api.config import Settings

    value = Settings(_env_file=None, deployment_updater_url="http://fire-updater:8080/v1/update")
    assert value.deployment_updater_url == "http://fire-updater:8080/v1/update"
    assert bridge.configured(configuration(value.deployment_updater_url))


@pytest.mark.parametrize("token", ["short", "x" * 32 + "\n", " " * 32])
def test_watchtower_rejects_invalid_header_tokens_without_a_network_action(token, monkeypatch):
    settings = configuration()
    settings.deployment_runner_token = SecretStr(token)
    monkeypatch.setattr(
        bridge.urllib.request, "build_opener", lambda *_: pytest.fail("invalid token must stay local")
    )
    assert not bridge.configured(settings) and bridge.notify(settings)["status"] == "failed"
    assert bridge.probe(settings)["observed_at"] is None


def test_runtime_requires_current_commit_and_same_approved_repository():
    settings = configuration()
    approved = {
        "image": settings.deployment_image + "@sha256:" + "a" * 64,
        "version": "0.1.99",
        "revision": settings.source_revision,
        "schema_hash": "c" * 64,
    }
    assert bridge.runtime_matches(settings, approved, version="0.1.99", schema="c" * 64)
    assert not bridge.runtime_matches(
        settings,
        {**approved, "image": "ghcr.io/synthetic/other@sha256:" + "a" * 64},
        version="0.1.99",
        schema="c" * 64,
    )
    settings.source_revision = ""
    settings.deployment_running_image = approved["image"]
    assert not bridge.runtime_matches(settings, approved, version="0.1.99", schema="c" * 64)


def test_tcp_probe_is_not_an_update_and_http_200_is_only_running():
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            calls.append((self.path, self.headers.get("Authorization")))
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        settings = configuration("http://127.0.0.1:" + str(server.server_port))
        probed = bridge.probe(settings)
        assert probed["online"] and probed["observed_at"] is not None
        assert not calls
        outcome = bridge.notify(settings)
        assert outcome["status"] == "running" and "succeeded" not in str(outcome)
        assert calls == [("/v1/update", "Bearer " + settings.deployment_runner_token.get_secret_value())]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize(
    "fault,expected",
    [
        (TimeoutError(), "unknown"),
        (OSError(), "unknown"),
        (401, "failed"),
        (403, "failed"),
        (404, "failed"),
        (302, "failed"),
        (408, "unknown"),
        (503, "unknown"),
    ],
)
def test_watchtower_transport_failure_never_retries_or_exposes_upstream(fault, expected, monkeypatch):
    calls = []

    def opened(*args, **kwargs):
        calls.append((args, kwargs))
        if isinstance(fault, int):
            raise urllib.error.HTTPError(
                "http://private.invalid/secret",
                fault,
                "private-response",
                {},
                io.BytesIO(b"private-response"),
            )
        raise fault

    monkeypatch.setattr(bridge.urllib.request, "build_opener", lambda *_: SimpleNamespace(open=opened))
    result = bridge.notify(configuration())
    assert result["status"] == expected and len(calls) == 1
    assert "private" not in str(result) and "synthetic" not in str(result)


async def queued(db, owner, state="queued", **changes):
    values = {
        "id": uuid4(),
        "owner_id": owner,
        "request_id": uuid4(),
        "image": "ghcr.io/synthetic/alcor-api@sha256:" + "a" * 64,
        "version": "0.1.99",
        "revision": "b" * 40,
        "schema_hash": "c" * 64,
        "status": state,
        **changes,
    }
    async with db.connection() as conn:
        return await (
            await conn.execute(
                "INSERT INTO deployment_requests(id,owner_id,request_id,image,version,revision,schema_hash,status) "
                "VALUES(%(id)s,%(owner_id)s,%(request_id)s,%(image)s,%(version)s,%(revision)s,%(schema_hash)s,%(status)s) RETURNING *",
                values,
            )
        ).fetchone()


async def test_notification_commits_unknown_before_wire_and_same_uuid_is_never_sent_twice(
    db, admin, monkeypatch
):
    original = await queued(db, admin)
    entered, release = threading.Event(), threading.Event()
    calls = []

    def notify(_settings):
        calls.append(True)
        entered.set()
        assert release.wait(10)
        return {"status": "running", "message": "accepted"}

    monkeypatch.setattr(bridge, "notify", notify)
    task = asyncio.create_task(bridge.dispatch(db, configuration(), original["id"]))
    try:
        assert await asyncio.to_thread(entered.wait, 10)
        async with db.connection() as conn:
            state = await (
                await conn.execute("SELECT status FROM deployment_requests WHERE id=%s", (original["id"],))
            ).fetchone()
        assert state["status"] == "unknown"
        repeated = await bridge.dispatch(db, configuration(), original["id"])
        assert repeated["receipt"]["status"] == "unknown" and len(calls) == 1
    finally:
        release.set()
        result = await task
    assert result["receipt"]["status"] == "running"
    assert (await bridge.dispatch(db, configuration(), original["id"]))["receipt"]["status"] == "running"
    assert len(calls) == 1


async def test_revoked_queued_owner_never_notifies_watchtower(db, admin, monkeypatch):
    original = await queued(db, admin)
    async with db.connection() as conn:
        await conn.execute("UPDATE users SET active=false WHERE id=%s", (admin,))
    monkeypatch.setattr(
        bridge, "notify", lambda *_: pytest.fail("revoked administrator cannot notify Watchtower")
    )
    result = await bridge.dispatch(db, configuration(), original["id"])
    assert result["receipt"]["status"] == "cancelled"


async def test_unknown_receipt_survives_retry_and_completes_only_on_matching_runtime_and_worker(
    db, admin, monkeypatch
):
    original = await queued(db, admin)
    settings = configuration()
    calls = []
    monkeypatch.setattr(
        bridge, "notify", lambda *_: calls.append(True) or {"status": "unknown", "message": "uncertain"}
    )
    assert (await bridge.dispatch(db, settings, original["id"]))["receipt"]["status"] == "unknown"
    assert (await bridge.dispatch(db, settings, original["id"]))["receipt"]["status"] == "unknown"
    assert len(calls) == 1
    assert not await bridge.reconcile(db, settings, version="0.1.99", schema="c" * 64)
    async with db.connection() as conn:
        worker = uuid4()
        await conn.execute("INSERT INTO worker_heartbeats(worker_id,version) VALUES(%s,'0.1.98')", (worker,))
    assert not await bridge.reconcile(db, settings, version="0.1.99", schema="c" * 64)
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE worker_heartbeats SET version='0.1.99',observed_at=clock_timestamp()-interval '1 hour' WHERE worker_id=%s",
            (worker,),
        )
    assert not await bridge.reconcile(db, settings, version="0.1.99", schema="c" * 64)
    async with db.connection() as conn:
        await conn.execute(
            "UPDATE worker_heartbeats SET observed_at=clock_timestamp() WHERE worker_id=%s", (worker,)
        )
    assert not await bridge.reconcile(db, settings, version="0.1.99", schema="d" * 64)
    assert not await bridge.reconcile(db, settings, version="0.1.98", schema="c" * 64)
    settings.source_revision = "f" * 40
    assert not await bridge.reconcile(db, settings, version="0.1.99", schema="c" * 64)
    settings.source_revision = "b" * 40
    assert await bridge.reconcile(db, settings, version="0.1.99", schema="c" * 64) == [str(original["id"])]
    assert not await bridge.reconcile(db, settings, version="0.1.99", schema="c" * 64)
    async with db.connection() as conn:
        state = await (
            await conn.execute("SELECT status FROM deployment_requests WHERE id=%s", (original["id"],))
        ).fetchone()
        audits = await (
            await conn.execute(
                "SELECT count(*) AS n FROM audit_events WHERE action='deployment.succeeded' AND request_id=%s",
                (original["request_id"],),
            )
        ).fetchone()
    assert state["status"] == "succeeded" and audits["n"] == 1 and len(calls) == 1


async def test_fresh_runtime_observation_wins_over_a_late_notification_response(db, admin, monkeypatch):
    original = await queued(db, admin)
    settings = configuration()
    entered, release = threading.Event(), threading.Event()

    def notify(_settings):
        entered.set()
        assert release.wait(10)
        return {"status": "running", "message": "waiting"}

    monkeypatch.setattr(bridge, "notify", notify)
    task = asyncio.create_task(bridge.dispatch(db, settings, original["id"]))
    try:
        assert await asyncio.to_thread(entered.wait, 10)
        async with db.connection() as conn:
            await conn.execute(
                "INSERT INTO worker_heartbeats(worker_id,version) VALUES(%s,'0.1.99')", (uuid4(),)
            )
        assert await bridge.reconcile(db, settings, version="0.1.99", schema="c" * 64) == [
            str(original["id"])
        ]
    finally:
        release.set()
        outcome = await task
    assert outcome["receipt"]["status"] == "succeeded"
    assert "就绪" in outcome["message"]
