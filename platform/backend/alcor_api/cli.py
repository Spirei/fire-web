import argparse
import asyncio
import getpass
import json
import sys
from pathlib import Path

from .accounts import insert_account
from .config import Settings
from .db import Database
from .migrate import migrate
from .passwords import hash_password


async def create_user(
    settings: Settings,
    username: str,
    password: str,
    role: str = "admin",
    email: str = "",
    *,
    is_test: bool = False,
):
    username, email = username.strip(), email.strip()
    if not username or len(username) > 80 or len(email) > 254:
        raise ValueError("Invalid login identifier")
    hashed = await asyncio.to_thread(hash_password, password)
    db = Database(settings)
    await db.open()
    try:
        async with db.connection() as conn, conn.transaction():
            user = await insert_account(conn, username, hashed, role=role, email=email, is_test=is_test)
            return user["id"]
    finally:
        await db.close()


def main():
    p = argparse.ArgumentParser(prog="alcor")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("check-schema")
    m = sub.add_parser("migrate")
    m.add_argument("--database", required=True, help="Exact confirmed target database name")
    m.add_argument("--initialize-empty", action="store_true")
    a = sub.add_parser("create-admin")
    a.add_argument("--username", required=True)
    a.add_argument("--password-stdin", action="store_true")
    r = sub.add_parser("enroll-restore-target")
    r.add_argument("--target", required=True)
    r.add_argument("--database", required=True)
    trial = sub.add_parser("trial-import-identities")
    trial.add_argument("--snapshot", required=True, type=Path)
    trial.add_argument("--database", required=True)
    key = trial.add_mutually_exclusive_group()
    key.add_argument("--source-key-file", type=Path)
    key.add_argument("--source-key-env")
    e = sub.add_parser("export-openapi")
    e.add_argument("--output", type=Path, default=Path("contracts/platform.openapi.json"))
    args = p.parse_args()
    try:
        if args.command == "export-openapi":
            from .main import create_app

            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(
                json.dumps(
                    create_app(
                        Settings(
                            database_url=None,
                            redis_url=None,
                            instance_id=None,
                            connection_secret_dir=None,
                            connection_targets=[],
                            backup_dir=None,
                            backup_secret_dir=None,
                            file_root=None,
                            asset_root=None,
                            legacy_source_registry_path=None,
                            resource_import_registry_path=None,
                            watch_group_import_registry_path=None,
                            attachment_import_registry_path=None,
                            font_import_registry_path=None,
                            operational_source_registry_path=None,
                            restore_targets=[],
                            environment="test",
                            public_origin="http://testserver",
                        )
                    ).openapi(),
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )
        elif args.command == "trial-import-identities":
            import os
            import re
            import stat

            from .identity_import import import_trial_snapshot

            cfg = Settings()
            if cfg.environment != "test":
                raise ValueError("Only isolated trial imports are enabled")

            def private_file(path, limit):
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, "rb") as file:
                    info = os.fstat(file.fileno())
                    if (
                        not stat.S_ISREG(info.st_mode)
                        or info.st_mode & 0o077
                        or info.st_uid != os.getuid()
                        or info.st_size > limit
                    ):
                        raise ValueError("Private input file requirements not met")
                    return file.read(limit + 1)

            source_key = None
            if args.source_key_file:
                source_key = private_file(args.source_key_file, 4096)
                if len(source_key) < 32:
                    raise ValueError("Source key file is invalid")
            elif args.source_key_env:
                if not re.fullmatch(r"[A-Z_][A-Z0-9_]{0,63}", args.source_key_env):
                    raise ValueError("Invalid source key variable")
                value = os.environ.get(args.source_key_env, "").strip()
                if not value:
                    raise ValueError("Source key variable is missing")
                source_key = value.encode()
            payload = json.loads(private_file(args.snapshot, 16 * 1024 * 1024))

            async def import_trial():
                db = Database(cfg)
                await db.open()
                try:
                    return await import_trial_snapshot(
                        db, payload, source_key=source_key, expected_database=args.database
                    )
                finally:
                    await db.close()

            print(json.dumps(asyncio.run(import_trial())))
        elif args.command == "enroll-restore-target":
            from psycopg.conninfo import conninfo_to_dict

            from .backups import target_connection, target_for

            cfg = Settings()
            target = target_for(cfg, args.target)
            if conninfo_to_dict(target.database_url.get_secret_value()).get("dbname") != args.database:
                raise ValueError("Database confirmation mismatch")

            async def enroll():
                conn = await target_connection(target, enroll=True)
                await conn.close()

            asyncio.run(enroll())
            print("Isolated empty target enrolled; no data restored.")
        elif args.command == "check-schema":
            from .schema_preflight import check
            result = asyncio.run(check(Settings()))
            print(json.dumps(result, ensure_ascii=False))
            if not result["compatible"]:
                raise SystemExit(2)
        elif args.command == "migrate":
            asyncio.run(migrate(Settings(), args.database, args.initialize_empty))
            print("Migration complete; target identity verified.")
        else:
            password = (
                sys.stdin.readline().rstrip("\n") if args.password_stdin else getpass.getpass("Password: ")
            )
            asyncio.run(create_user(Settings(), args.username, password))
            print("Administrator created.")
    except Exception:  # noqa: BLE001 -- CLI errors must never expose credentials or SQL.
        # Never print connection strings, SQL details, submitted credentials or raw driver exceptions.
        print("Operation failed. Check the target identity, migration state and inputs.", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
