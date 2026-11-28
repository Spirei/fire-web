import asyncio
import json
import os
import subprocess
import sys
import threading
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

import httpx
import pgserver
import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict

from alcor_api import deployment_runner
from alcor_api.db import TargetMismatch
from alcor_api.deployment_runner import Runner
from alcor_api.deployment_runtime import Runtime
from alcor_api.migrate import migrate, pending_migrations


class IsolatedRuntime:
    repository = "ghcr.io/fixture/fire"
    original = {"0001.sql": "a"}
    newer = {"0001.sql": "a", "0002.sql": "b"}

    def __init__(self, *, needs_migration=True, failure=None):
        self.calls = []
        self.receipts = self.original.copy()
        self.target_receipts = self.newer if needs_migration else self.original
        self.failure = failure

    def authorize(self, job):
        if self.failure == "instance":
            raise TargetMismatch("Unexpected instance")

    def target(self, job):
        return {"id": "target-id", "migrations": self.target_receipts,
                "revision": job["revision"], "version": job["version"]}

    def applied(self, job):
        return self.receipts.copy()

    def running(self, job):
        return {"id": "source-id", "migrations": self.original, "revision": "0" * 40, "version": "0.1.91"}

    def stop(self, old):
        self.calls.append("stop")

    def backup(self, job, source):
        self.calls.append("backup")
        return "verified-dump"

    def verify_backup(self, job, digest):
        assert digest == "verified-dump"
        self.calls.append("verify_backup")

    def migration_active(self, job):
        return False

    def writers_running(self, old):
        return False

    def migrate(self, job, old):
        self.calls.append("migrate")
        if self.failure == "migrate":
            raise RuntimeError("Synthetic failed SQL")
        self.receipts = self.target_receipts.copy()

    def switch(self, old, image):
        self.calls.append(("switch", image))

    def clock(self, job):
        return datetime.now(UTC)

    def ready(self, old, target, job, since):
        self.calls.append(("ready", target["id"]))
        if target["id"] == "target-id" and self.failure == "ready":
            raise RuntimeError("Synthetic startup failure")

    def finish(self, job, target):
        assert target == self.receipts
        self.calls.append("finish")


def approval():
    return {"id": str(uuid4()), "request_id": str(uuid4()), "owner_id": "fixture",
            "image": "ghcr.io/fixture/fire@sha256:" + "a" * 64, "version": "0.1.92",
            "revision": "b" * 40, "schema_hash": "c" * 64, "instance_id": str(uuid4()),
            "environment": "test", "database": "fixture"}


def run(runner, job):
    runner.accept(job)
    runner.execute(runner.read(job["request_id"]))
    return runner.read(job["request_id"])


def test_same_schema_switches_pinned_image_without_maintenance_backup(tmp_path):
    runtime = IsolatedRuntime(needs_migration=False)
    runner = Runner(tmp_path / "state", runtime)
    job = approval()
    assert run(runner, job)["status"] == "succeeded"
    assert runtime.calls == [("switch", job["image"]), ("ready", "target-id"), "finish"]
    assert runner.accept(job)["status"] == "succeeded"
    with pytest.raises(ValueError):
        runner.accept({**job, "image": job["image"][:-1] + "f"})


def test_wrong_instance_rejected_before_changing_runtime(tmp_path):
    runtime = IsolatedRuntime(failure="instance")
    with pytest.raises(TargetMismatch):
        Runner(tmp_path / "state", runtime).accept(approval())
    assert runtime.calls == []


def test_failed_migration_recovers_old_service_then_captures_fresh_backup(tmp_path):
    runtime = IsolatedRuntime(failure="migrate")
    directory = tmp_path / "state"
    runner = Runner(directory, runtime)
    job = approval()
    failed = run(runner, job)
    assert failed["status"] == "failed" and "backup" not in failed
    assert runtime.calls == ["stop", "backup", "migrate", ("switch", "source-id"), ("ready", "source-id")]
    runtime.failure = None
    resumed = Runner(directory, runtime)
    assert run(resumed, job)["status"] == "succeeded"
    assert runtime.calls.count("backup") == runtime.calls.count("migrate") == 2
    assert runtime.calls[-3:] == [("switch", job["image"]), ("ready", "target-id"), "finish"]


def test_after_committed_migration_failed_health_requires_forward_resume(tmp_path):
    runtime = IsolatedRuntime(failure="ready")
    runner = Runner(tmp_path / "state", runtime)
    job = approval()
    failed = run(runner, job)
    assert failed["status"] == "maintenance_required" and failed["backup"] == "verified-dump"
    assert ("switch", "source-id") not in runtime.calls
    with pytest.raises(ValueError):
        runner.accept(approval())
    runtime.failure = None
    assert run(Runner(runner.root, runtime), job)["status"] == "succeeded"
    assert runtime.calls.count("backup") == runtime.calls.count("migrate") == 1
    assert runtime.calls.count("verify_backup") == 1


def test_interrupted_after_migration_uses_original_file_and_skips_sql(tmp_path):
    runtime = IsolatedRuntime()
    runner = Runner(tmp_path / "state", runtime)
    job = approval()
    runner.accept(job)
    state = runner.read(job["request_id"])
    state.update(source=runtime.original, old=runtime.running(job), target=runtime.target(job), backup="verified-dump")
    runner.update(state, "running", "migrating", "Synthetic interruption")
    runtime.receipts = runtime.newer
    runner = Runner(runner.root, runtime)
    runner.execute(runner.read(job["request_id"]))
    assert runner.read(job["request_id"])["status"] == "succeeded"
    assert runtime.calls == ["verify_backup", ("switch", job["image"]), ("ready", "target-id"), "finish"]


def test_same_request_rechecks_backup_if_old_writer_restarted(tmp_path, monkeypatch):
    runtime = IsolatedRuntime()
    runner = Runner(tmp_path / "state", runtime)
    job = approval()
    runner.accept(job)
    state = runner.read(job["request_id"])
    state.update(source=runtime.original, old=runtime.running(job), target=runtime.target(job), backup="stale")
    runner.update(state, "running", "backup_verified", "Synthetic interruption")
    monkeypatch.setattr(runtime, "writers_running", lambda old: True)
    runner.execute(runner.read(job["request_id"]))
    assert runner.read(job["request_id"])["status"] == "succeeded"
    assert runtime.calls[:3] == ["stop", "backup", "migrate"]


def test_migrator_uses_original_npm_entry_and_reuses_a_running_container(tmp_path, monkeypatch):
    runtime = object.__new__(Runtime)
    runtime.root = tmp_path
    monkeypatch.setattr(runtime, "check_project", lambda old: None)
    monkeypatch.setattr(runtime, "writers_running", lambda old: False)
    calls = []
    monkeypatch.setattr(runtime, "compose", lambda *args, **kwargs: calls.append(args))
    monkeypatch.setattr(runtime, "docker", lambda *args, **kwargs: calls.append(args) or "0")
    monkeypatch.setattr(runtime, "migration_container", lambda _job: None)
    job = approval()
    runtime.migrate(job, {"services": ["fire"]})
    args = calls[0]
    assert args[-7:] == ("fire", "run", "platform:migrate", "--", "--database", job["database"], "--require-target-schema")
    assert calls[1] == ("wait", runtime.migration_name(job))
    calls.clear()
    monkeypatch.setattr(runtime, "migration_container", lambda _job: {"State": {"Status": "running"}})
    runtime.migrate(job, {"services": ["fire"]})
    assert calls == [("wait", runtime.migration_name(job))]


def test_updater_cli_reads_same_fire_environment(tmp_path, monkeypatch, capsys):
    job = approval()
    for key, value in {
        "FIRE_DATABASE_URL": "postgresql://fixture:fixture@localhost/fixture",
        "FIRE_INSTANCE_ID": job["instance_id"], "FIRE_ENVIRONMENT": "test",
        "FIRE_PUBLIC_ORIGIN": "http://testserver",
        "FIRE_DEPLOYMENT_RUNNER_TOKEN": "a" * 40,
        "FIRE_UPDATER_REPOSITORY_IMAGE": "ghcr.io/fixture/fire",
        "FIRE_DEPLOYMENT_PROJECT_DIR": str(tmp_path),
        "FIRE_DEPLOYMENT_STATE_DIR": str(tmp_path / "state"),
    }.items():
        monkeypatch.setenv(key, value)
    runner = Runner(tmp_path / "state", IsolatedRuntime())
    runner.accept(job)
    monkeypatch.setattr("sys.argv", ["deployment_runner", "--status", job["request_id"]])
    deployment_runner.main()
    assert json.loads(capsys.readouterr().out)["request_id"] == job["request_id"]


def test_private_updater_requires_token_and_persists_original_approval(tmp_path):
    runner = Runner(tmp_path / "state", IsolatedRuntime())
    token = "test-token-" + "x" * 32
    server = ThreadingHTTPServer(("127.0.0.1", 0), deployment_runner.handler(runner, token.encode()))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{server.server_port}", trust_env=False) as client:
            assert client.get("/v1/health").status_code == 401
            client.headers["Authorization"] = "Bearer " + token
            assert client.get("/v1/health").json()["kind"] == "fire-release-updater"
            job = approval()
            first = client.post("/v1/update", json=job)
            assert first.status_code == 202 and first.json()["status"] == "queued"
            assert client.post("/v1/update", json=job).json() == first.json()
            assert client.get("/v1/update/" + job["request_id"]).json() == first.json()
            assert client.post("/v1/update", json={**job, "database": "different"}).status_code == 409
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def test_runtime_requires_all_target_images_and_fresh_worker_on_each_readiness_poll(monkeypatch):
    runtime = object.__new__(Runtime)
    target = {"id": "target", "revision": "new", "version": "0.1.92", "worker_version": "0.1.92"}
    old = {"services": ["fire", "fire-model-worker"], "container": "fire", "worker": True}
    inspected, pulses = [], []
    started = datetime.now(UTC)
    floor = started + timedelta(seconds=1)
    monkeypatch.setattr(runtime, "compose", lambda *argv: argv[-1])

    def docker(*argv, **kwargs):
        if argv[0] == "exec":
            return json.dumps({"revision": target["revision"], "version": target["version"]})
        inspected.append(argv[-1])
        wrong = len(inspected) == 2
        return json.dumps([{"Image": "wrong" if wrong else target["id"], "State": {"Running": True}}])

    class Heartbeat:
        def execute(self, sql, params):
            assert "observed_at >= %s" in sql and params == (target["worker_version"], floor)
            pulses.append(params)
            return self

        def fetchone(self):
            return {"fresh": True} if len(pulses) == 2 else None

    @contextmanager
    def database(job):
        yield Heartbeat()

    monkeypatch.setattr(runtime, "docker", docker)
    monkeypatch.setattr(runtime, "database", database)
    monkeypatch.setattr(runtime, "clock", lambda _job: floor)
    monkeypatch.setattr("alcor_api.deployment_runtime.time.sleep", lambda _: None)
    runtime.ready(old, target, approval(), started)
    assert inspected == ["fire", "fire-model-worker"] * 3 and len(pulses) == 2


async def test_verified_backup_restores_last_write_in_isolated_postgresql(settings, tmp_path):
    dsn = settings.database_url.get_secret_value()
    pg_tools = Path(pgserver.__file__).parent / "pginstall" / "bin"
    settings = settings.model_copy(update={"pg_tools_dir": pg_tools})
    runtime = object.__new__(Runtime)
    runtime.settings, runtime.dsn = settings, dsn
    runtime.root = tmp_path
    job = {**approval(), "instance_id": str(settings.instance_id),
           "database": conninfo_to_dict(dsn)["dbname"]}
    with psycopg.connect(dsn) as conn:
        conn.execute("CREATE TABLE deployment_fixture_last_write (id integer PRIMARY KEY)")
        conn.execute("INSERT INTO deployment_fixture_last_write VALUES (1)")
    source = runtime.applied(job)
    with pytest.raises(TargetMismatch):
        runtime.applied({**job, "instance_id": str(uuid4())})
    retiring_client = psycopg.connect(dsn)
    try:
        with pytest.raises(TargetMismatch, match="remain connected"):
            await asyncio.to_thread(runtime.wait_for_quiescence, job, source, seconds=0.05)
        backup = asyncio.create_task(asyncio.to_thread(runtime.backup, job, source))
        await asyncio.sleep(0.3)
    finally:
        retiring_client.close()
    digest = await backup
    runtime.verify_backup(job, digest)
    assert runtime.backup_path(job).stat().st_mode & 0o777 == 0o600
    out = runtime.backup_path(job)
    from alcor_api.deployment_runtime import execute
    data = execute([str(pg_tools / "pg_restore"), "-a", "-t", "deployment_fixture_last_write", "-f", "-", str(out)])
    assert "\n1\n" in data


async def test_strict_migration_rejects_changed_source_and_applies_only_missing(settings, tmp_path):
    dsn = settings.database_url.get_secret_value()
    name = conninfo_to_dict(dsn)["dbname"]
    env = {**os.environ, "FIRE_DATABASE_URL": dsn, "FIRE_INSTANCE_ID": str(settings.instance_id),
           "FIRE_ENVIRONMENT": settings.environment, "FIRE_PUBLIC_ORIGIN": settings.public_origin,
           "FIRE_PYTHON": sys.executable}
    response = await asyncio.to_thread(
        subprocess.run, ["npm", "run", "platform:migrate", "--", "--database", name, "--require-target-schema"],
        cwd=Path(__file__).resolve().parents[2], env=env, capture_output=True, text=True, timeout=40,
    )
    assert response.returncode == 0, response.stderr
    applied = {p.name: p.read_bytes() for p in settings.migration_dir.glob("[0-9]*.sql")}
    for file, body in applied.items():
        (tmp_path / file).write_bytes(body)
    settings = settings.model_copy(update={"migration_dir": tmp_path})
    new = tmp_path / "9999_fixture.sql"
    new.write_text("CREATE TABLE release_fixture_tab (id integer PRIMARY KEY); INSERT INTO release_fixture_tab VALUES (1);")
    await migrate(settings, name, require_target_schema=True)
    await migrate(settings, name, require_target_schema=True)
    with psycopg.connect(dsn) as conn:
        assert conn.execute("SELECT count(*) FROM release_fixture_tab").fetchone() == (1,)
        assert conn.execute("SELECT count(*) FROM schema_migrations WHERE name='9999_fixture.sql'").fetchone() == (1,)
    (tmp_path / "9999_rollback.sql").write_text(
        "CREATE TABLE release_rolled_back (id integer); INSERT INTO missing_release_fixture_table VALUES (1);",
    )
    with pytest.raises(psycopg.errors.UndefinedTable):
        await migrate(settings, name, require_target_schema=True)
    with psycopg.connect(dsn) as conn:
        assert conn.execute("SELECT to_regclass('release_rolled_back')").fetchone() == (None,)
        assert conn.execute("SELECT count(*) FROM schema_migrations WHERE name='9999_rollback.sql'").fetchone() == (0,)
    with pytest.raises(TargetMismatch):
        pending_migrations({"0001.sql": "changed"}, {"0001.sql": "original", "0002.sql": "new"})
