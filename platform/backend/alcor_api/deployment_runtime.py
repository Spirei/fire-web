"""Pinned Compose operations and a verified backup of the quiesced database."""

import hashlib
import json
import os
import subprocess
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from .backups import command_env, private_dir, tools
from .db import PRODUCT, SCHEMA_MIGRATION_LOCK, TargetMismatch


IMAGE_METADATA = """
import hashlib, json, os, sys
from pathlib import Path
sys.path.insert(0, '/app/platform/backend')
from alcor_api import __version__ as worker_version
manifest = {}
schema = hashlib.sha256()
for file in sorted(Path('/app/platform/migrations').glob('*.sql')):
    content = file.read_bytes()
    schema.update(file.name.encode() + b'\\0' + content + b'\\0')
    manifest[file.name] = hashlib.sha256(content).hexdigest()
print(json.dumps(dict(version=json.loads(Path('/app/package.json').read_text())['version'], worker_version=worker_version,
                      revision=os.environ['FIRE_BUILD_SHA'], schema_hash=schema.hexdigest(),
                      migrations=manifest)))
"""

HEALTH_CHECK = """
const base = 'http://127.0.0.1:' + (process.env.PORT || '3000')
Promise.all(['/health/ready','/api/health'].map(p => fetch(base+p, {signal:AbortSignal.timeout(4000)})))
  .then(async ([ready,health]) => {
    if (!ready.ok || !health.ok || (await ready.json()).status !== 'ready') process.exit(1)
    const {data} = await health.json()
    process.stdout.write(JSON.stringify({revision:data.buildSha,version:data.version}))
  }).catch(() => process.exit(1))
"""


def save_json(path, value):
    fd, pending = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(value, output, ensure_ascii=False, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
        os.replace(pending, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(pending).unlink(missing_ok=True)


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def execute(args, *, seconds=40, env=None):
    result = subprocess.run(args, capture_output=True, text=True, timeout=seconds, env=env)
    if result.returncode:
        raise RuntimeError("Maintenance command failed")
    return result.stdout


class Runtime:
    def __init__(self, settings):
        self.settings = settings
        self.repository = os.environ["FIRE_UPDATER_REPOSITORY_IMAGE"]
        self.project = Path(os.environ["FIRE_DEPLOYMENT_PROJECT_DIR"]).resolve(strict=True)
        self.compose_file = self.project / "docker-compose.ghcr.yml"
        self.root = private_dir(Path(os.environ["FIRE_DEPLOYMENT_STATE_DIR"]))
        self.dsn = settings.database_url.get_secret_value()

    def docker(self, *args, seconds=40):
        return execute(["docker", *args], seconds=seconds)

    def compose(self, *args, override=None, seconds=60):
        files = ["-f", str(self.compose_file)]
        if override:
            files.extend(["-f", str(override)])
        return self.docker("compose", "--project-directory", str(self.project), *files, *args, seconds=seconds)

    @contextmanager
    def database(self, job):
        if (job["instance_id"], job["environment"]) != (str(self.settings.instance_id), self.settings.environment):
            raise TargetMismatch("Release approval differs from updater configuration")
        with psycopg.connect(self.dsn, row_factory=dict_row, connect_timeout=5,
                             options="-c statement_timeout=5000 -c lock_timeout=2000") as conn:
            self.check_database(conn, job)
            yield conn

    def check_database(self, conn, job):
        row = conn.execute("SELECT current_database() AS name,instance_id,environment,product "
                           "FROM public.alcor_instance WHERE singleton=true").fetchone()
        if (not row or (row["name"], str(row["instance_id"]), row["environment"], row["product"]) !=
                (job["database"], job["instance_id"], job["environment"], PRODUCT)):
            raise TargetMismatch("Unexpected release database identity")

    def authorize(self, job):
        with self.database(job) as conn:
            row = conn.execute(
                "SELECT r.*,u.role,u.active FROM deployment_requests r JOIN users u ON u.id=r.owner_id "
                "WHERE r.id=%s AND r.request_id=%s AND r.owner_id=%s",
                (job["id"], job["request_id"], job["owner_id"]),
            ).fetchone()
        if (not row or not row["active"] or row["role"] != "admin" or row["status"] == "cancelled"
                or any(row[key] != job[key] for key in ("version", "image", "revision", "schema_hash"))):
            raise TargetMismatch("Exact deployment approval is not active")

    def applied(self, job):
        with self.database(job) as conn:
            return self.receipts(conn)

    def clock(self, job):
        with self.database(job) as conn:
            return conn.execute("SELECT clock_timestamp() AS at").fetchone()["at"]

    @staticmethod
    def receipts(conn):
        return {row["name"]: row["sha256"] for row in conn.execute("SELECT name,sha256 FROM public.schema_migrations")}

    def image(self, reference):
        inspect = json.loads(self.docker("image", "inspect", reference))[0]
        data = json.loads(self.docker("run", "--rm", "--network", "none", "--pull", "never", "--entrypoint",
                                      "/platform/.venv/bin/python", inspect["Id"], "-c", IMAGE_METADATA))
        return {**data, "id": inspect["Id"], "digests": inspect.get("RepoDigests") or []}

    def target(self, job):
        try:
            image = self.image(job["image"])
        except RuntimeError:
            self.docker("pull", job["image"], seconds=900)
            image = self.image(job["image"])
        if (job["image"] not in image["digests"] or not image["migrations"] or
                any(image[key] != job[key] for key in ("revision", "version", "schema_hash"))):
            raise TargetMismatch("Pulled image does not match the approved release")
        image.pop("digests")
        return image

    def config(self):
        return json.loads(self.compose("config", "--format", "json"))

    @staticmethod
    def config_hash(config):
        return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()

    def running(self, job):
        config = self.config()
        services = [name for name in ("fire", "fire-model-worker") if name in config["services"]]
        if not services or services[0] != "fire":
            raise TargetMismatch("The Fire Compose service is missing")
        candidate = config["services"]["fire"]
        env = candidate["environment"]
        expected = {"FIRE_DATABASE_URL": self.dsn, "FIRE_INSTANCE_ID": job["instance_id"],
                    "FIRE_ENVIRONMENT": job["environment"]}
        if any(env.get(key) != value for key, value in expected.items()):
            raise TargetMismatch("Compose database configuration differs from the release database")
        old, writers = None, []
        for service in services:
            ids = self.compose("ps", "-q", service).splitlines()
            if len(ids) != 1:
                raise TargetMismatch("The configured Fire project is not running")
            item = json.loads(self.docker("container", "inspect", ids[0]))[0]
            labels = item["Config"]["Labels"]
            actual = dict(value.split("=", 1) for value in item["Config"]["Env"] if "=" in value)
            if (not item["State"]["Running"] or any(actual.get(key) != value for key, value in expected.items())
                    or labels.get("com.docker.compose.project") != config["name"]
                    or labels.get("com.docker.compose.service") != service):
                raise TargetMismatch("The live Fire project uses a different database")
            writers.append(item["Name"].lstrip("/"))
            if old is None:
                old = self.image(item["Image"])
            if item["Image"] != old["id"]:
                raise TargetMismatch("The active Fire services use different images")
        if "fire-model-worker" not in services and "fire-model-worker" in self.docker(
                "container", "ls", "--format", "{{.Names}}").splitlines():
            raise TargetMismatch("The existing Fire worker is outside the approved Compose project")
        return {**old, "services": services, "config_hash": self.config_hash(config),
                "container": writers[0], "writers": writers,
                "worker": env.get("FIRE_WORKER") == "on" or "fire-model-worker" in services}

    def check_project(self, old):
        if self.config_hash(self.config()) != old["config_hash"]:
            raise TargetMismatch("The Compose project changed after release approval")

    def stop(self, old):
        self.check_project(old)
        self.compose("stop", "--timeout", "30", *old["services"], seconds=120)
        if self.writers_running(old):
            raise RuntimeError("The approved Fire services have not stopped")

    def writers_running(self, old):
        names = self.docker("container", "ls", "--format", "{{.Names}}").splitlines()
        return bool(set(old["writers"]).intersection(names))

    def backup_path(self, job):
        return self.root / (job["request_id"] + ".dump")

    def wait_for_quiescence(self, job, source, *, seconds=15):
        deadline = time.monotonic() + seconds
        while True:
            with self.database(job) as conn:
                if self.receipts(conn) != source:
                    raise TargetMismatch("The source database changed before backup")
                other = conn.execute("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() "
                                     "AND backend_type='client backend' AND pid<>pg_backend_pid() LIMIT 1").fetchone()
            if not other:
                return
            if time.monotonic() >= deadline:
                raise TargetMismatch("Other clients remain connected to the source database")
            time.sleep(min(0.2, max(0, deadline - time.monotonic())))

    def backup(self, job, source):
        self.wait_for_quiescence(job, source)
        path = self.backup_path(job)
        with tempfile.TemporaryDirectory(prefix="backup-", dir=self.root) as root:
            scratch = Path(root)
            dump = scratch / "database.dump"
            env = command_env(self.dsn, scratch)
            execute([tools(self.settings, "pg_dump"), "-Fc", "--no-owner", "--no-privileges", "-f", str(dump)],
                    env=env, seconds=1800)
            self.restore_check(dump, scratch, job, source)
            dump.chmod(0o600)
            with dump.open("rb") as saved:
                os.fsync(saved.fileno())
            digest = sha256(dump)
            os.replace(dump, path)
            directory = os.open(self.root, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        return digest

    def restore_check(self, dump, scratch, job, source):
        cluster = scratch / "pg"
        binary = lambda name: tools(self.settings, name)
        execute([binary("initdb"), "--no-sync", "-D", str(cluster), "-A", "trust", "-U", "postgres"], seconds=180)
        socket = tempfile.TemporaryDirectory(prefix="fire-restore-")
        try:
            socket_path = Path(socket.name)
            execute([binary("pg_ctl"), "-D", str(cluster), "-l", str(scratch / "restore.log"), "-w", "start",
                     "-o", f"-c listen_addresses='' -k {socket_path} -c fsync=off"])
            env = {"PATH": os.environ.get("PATH", ""), "PGHOST": str(socket_path), "PGUSER": "postgres",
                   "PGDATABASE": "postgres", "PGPORT": "5432"}
            if job["database"] != "postgres":
                execute([binary("createdb"), "--", job["database"]], env=env)
            execute([binary("pg_restore"), "--exit-on-error", "--no-owner", "--no-privileges",
                     "--dbname=" + job["database"], str(dump)], env=env, seconds=1800)
            with psycopg.connect(host=str(socket_path), port=5432, user="postgres", dbname=job["database"],
                                 row_factory=dict_row) as conn:
                self.check_database(conn, job)
                if self.receipts(conn) != source:
                    raise TargetMismatch("Restored backup does not match the source schema")
        finally:
            if (cluster / "postmaster.pid").exists():
                execute([binary("pg_ctl"), "-D", str(cluster), "-m", "immediate", "-w", "stop"])
            socket.cleanup()

    def verify_backup(self, job, digest):
        if sha256(self.backup_path(job)) != digest:
            raise TargetMismatch("Verified backup checksum changed")

    @contextmanager
    def override(self, old, image):
        with tempfile.TemporaryDirectory(prefix="compose-", dir=self.root) as root:
            path = Path(root) / "release.json"
            save_json(path, {"services": {name: {"image": image} for name in old["services"]}})
            yield path

    def migrate(self, job, old):
        self.check_project(old)
        if self.writers_running(old):
            raise TargetMismatch("Source writes must remain stopped during migration")
        name = self.migration_name(job)
        existing = self.migration_container(job)
        if existing and existing["State"]["Status"] == "created":
            self.docker("container", "start", name)
        elif existing and existing["State"]["Status"] == "exited":
            if existing["State"]["ExitCode"] == 0:
                return
            self.docker("container", "rm", name)
            existing = None
        if not existing:
            with self.override(old, job["image"]) as override:
                self.compose("run", "-d", "--no-deps", "--pull", "never", "--name", name,
                             "--label", "fire.release.request=" + job["request_id"], "--entrypoint", "npm",
                             "fire", "run", "platform:migrate", "--", "--database", job["database"],
                             "--require-target-schema", override=override, seconds=90)
        if self.docker("wait", name, seconds=1800).strip() != "0":
            raise RuntimeError("The target image migration transaction failed")

    @staticmethod
    def migration_name(job):
        return "fire-migrate-" + job["request_id"]

    def migration_container(self, job):
        name = self.migration_name(job)
        ids = self.docker("container", "ls", "--all", "--filter", "name=^/" + name + "$", "-q").splitlines()
        if not ids:
            return None
        item = json.loads(self.docker("container", "inspect", ids[0]))[0]
        if item["Config"]["Labels"].get("fire.release.request") != job["request_id"]:
            raise TargetMismatch("Unexpected migration container")
        return item

    def migration_active(self, job):
        item = self.migration_container(job)
        return bool(item and item["State"]["Status"] in {"created", "running", "restarting"})

    def switch(self, old, image):
        self.check_project(old)
        with self.override(old, image) as override:
            self.compose("up", "-d", "--no-deps", "--no-build", "--pull", "never", *old["services"],
                         override=override, seconds=180)

    def ready(self, old, target, job, started):
        deadline = time.monotonic() + 180
        heartbeat_floor = None
        while time.monotonic() < deadline:
            try:
                verified = set()
                for service in old["services"]:
                    ids = self.compose("ps", "-q", service).splitlines()
                    if len(ids) == 1:
                        item = json.loads(self.docker("container", "inspect", ids[0]))[0]
                        if item["Image"] == target["id"] and item["State"]["Running"]:
                            verified.add(service)
                if len(verified) == len(old["services"]) and json.loads(self.docker("exec", old["container"], "node", "-e", HEALTH_CHECK, seconds=6)) == {
                    "revision": target["revision"], "version": target["version"],
                }:
                    if not old["worker"]:
                        return
                    if heartbeat_floor is None:
                        # A previous image can share the release version and
                        # post while Compose is still switching containers.
                        heartbeat_floor = max(started, self.clock(job))
                    with self.database(job) as conn:
                        worker = conn.execute(
                            "SELECT 1 FROM worker_heartbeats WHERE version=%s AND observed_at >= %s "
                            "AND observed_at>clock_timestamp()-interval '30 seconds' LIMIT 1",
                            (target["worker_version"], heartbeat_floor),
                        ).fetchone()
                    if worker:
                        return
                else:
                    heartbeat_floor = None
            except (RuntimeError, ValueError, subprocess.TimeoutExpired, psycopg.OperationalError):
                heartbeat_floor = None
            time.sleep(2)
        raise RuntimeError("The expected runtime did not become ready")

    def finish(self, job, target):
        with self.database(job) as conn:
            conn.execute("SELECT pg_advisory_xact_lock_shared(%s)", (SCHEMA_MIGRATION_LOCK,))
            if self.receipts(conn) != target:
                raise TargetMismatch("Database changed before release completion")
            row = conn.execute(
                "UPDATE deployment_requests SET status='succeeded',finished_at=clock_timestamp() "
                "WHERE id=%s AND status IN ('queued','running','unknown') RETURNING id", (job["id"],),
            ).fetchone()
            if row:
                conn.execute("INSERT INTO audit_events(actor_id,action,target_id,request_id) "
                             "VALUES(%s,'deployment.succeeded',%s,%s)",
                             (job["owner_id"], str(row["id"]), job["request_id"]))
            elif not conn.execute("SELECT 1 FROM deployment_requests WHERE id=%s AND status='succeeded'",
                                  (job["id"],)).fetchone():
                raise TargetMismatch("The original deployment receipt is no longer active")
