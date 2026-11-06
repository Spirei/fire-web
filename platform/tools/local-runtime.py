#!/usr/bin/env python3
"""Owned local PostgreSQL + Redis + supervised API/Worker. Never uses an inherited database URL."""

import asyncio
import argparse
import fcntl
import ipaddress
import json
import os
import signal
import socket
import subprocess
from pathlib import Path
from uuid import uuid4

import pgserver
from pgserver.postgres_server import POSTGRES_BIN_PATH
import psycopg
from psycopg import sql

from alcor_api.config import Settings
from alcor_api.migrate import migrate

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vite", action="store_true", help="Allow the local Vite origin on port 5178")
    parser.add_argument("--lan", help="Bind only to this local private IPv4 address")
    parser.add_argument("--port", type=int, default=8088)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    host = args.lan or "127.0.0.1"
    if args.lan:
        try:
            address = ipaddress.IPv4Address(args.lan)
            if not any(address in ipaddress.ip_network(network) for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")):
                raise ValueError()
        except ValueError:
            parser.error("lan must be a local private IPv4 address")
        if args.vite:
            parser.error("lan and vite cannot be combined")
    local = ROOT / ".local"
    local.mkdir(mode=0o700, exist_ok=True)
    if local.is_symlink() or (local / "postgres").is_symlink():
        raise RuntimeError("Local database directory must not be a symlink")
    local.chmod(0o700)
    lock = (local / "runtime.lock").open("a")
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError("The owned local runtime is already running; refusing a second launcher") from None
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, args.port))
        except OSError:
            raise RuntimeError(
                f"Cannot bind {host}:{args.port}; check the local address and port ownership"
            ) from None
    owner = local / "instance.json"
    if not owner.exists():
        if (local / "postgres/PG_VERSION").exists():
            raise RuntimeError("Existing unowned PostgreSQL directory; refusing to open")
        owner.write_text(
            json.dumps({"instance_id": str(uuid4()), "database": "alcor_local", "environment": "local"})
        )
        owner.chmod(0o600)
    spec = json.loads(owner.read_text())
    server = pgserver.get_server(local / "postgres", cleanup_mode="stop")
    redis_process = supervisor = None
    try:
        with psycopg.connect(server.get_uri(), autocommit=True) as conn:
            directory = conn.execute("SHOW data_directory").fetchone()[0]
            if Path(directory).resolve() != (local / "postgres").resolve():
                raise RuntimeError("Local PostgreSQL identity mismatch")
            if not conn.execute("SELECT 1 FROM pg_database WHERE datname=%s", (spec["database"],)).fetchone():
                conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(spec["database"])))
        settings = Settings(
            database_url=server.get_uri(database=spec["database"]),
            instance_id=spec["instance_id"],
            environment="local",
        )
        asyncio.run(migrate(settings, spec["database"], initialize_empty=True))
        # Explicitly rebuild the application environment; never inherit a NAS/production target.
        env = {k: v for k, v in os.environ.items() if not k.startswith("ALCOR_")}
        env.update(
            {
                "ALCOR_DATABASE_URL": settings.database_url.get_secret_value(),
                "ALCOR_INSTANCE_ID": str(settings.instance_id),
                "ALCOR_ENVIRONMENT": "local",
                "ALCOR_PUBLIC_ORIGIN": "http://127.0.0.1:5178" if args.vite else f"http://{host}:{args.port}",
                "ALCOR_ROOT": str(ROOT),
                "ALCOR_RUNTIME": str(local),
                "ALCOR_PYTHON": str(ROOT / ".venv/bin/python"),
                "ALCOR_BIND_HOST": host,
                "ALCOR_PORT": str(args.port),
                "ALCOR_CONNECTION_SECRET_DIR": str(local / "connection-secrets"),
                "ALCOR_BACKUP_DIR": str(local / "backups"),
                "ALCOR_BACKUP_SECRET_DIR": str(local / "backup-secrets"),
                "ALCOR_FILE_ROOT": str(local / "files"),
                "ALCOR_PG_TOOLS_DIR": str(POSTGRES_BIN_PATH),
            }
        )
        binary = local / "tooling/redis-7.4.12/src/redis-server"
        if binary.is_file():
            with (local / "redis.log").open("a") as log:
                redis_process = subprocess.Popen(
                    [
                        str(binary),
                        "--port",
                        "0",
                        "--unixsocket",
                        str(local / "redis.sock"),
                        "--unixsocketperm",
                        "700",
                        "--save",
                        "",
                        "--appendonly",
                        "no",
                    ],
                    stdout=log,
                    stderr=log,
                )
            env["ALCOR_REDIS_URL"] = "unix://" + str(local / "redis.sock") + "?db=0"
        else:
            print("Redis not built: cache will be shown as unconfigured.", flush=True)
        print("Local platform: " + env["ALCOR_PUBLIC_ORIGIN"], flush=True)
        if args.vite:
            print("Start the frontend separately with npm run dev:web.", flush=True)
        print("Open the website and select Register. The first registered account is the administrator.", flush=True)
        supervisor = subprocess.Popen(
            [str(ROOT / ".venv/bin/supervisord"), "-c", str(ROOT / "deploy/supervisord.conf")], env=env
        )

        def stop(*_):
            if supervisor and supervisor.poll() is None:
                supervisor.terminate()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        supervisor.wait()
    finally:
        if supervisor and supervisor.poll() is None:
            supervisor.terminate()
            supervisor.wait(timeout=30)
        if redis_process:
            redis_process.terminate()
            redis_process.wait(timeout=10)
        server.cleanup()


if __name__ == "__main__":
    main()
