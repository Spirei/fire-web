"""Fire internal process and explicit configuration/database tools. No automatic migration."""

import asyncio
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

root = Path(
    os.environ.get(
        "FIRE_PLATFORM_ROOT", Path(__file__).resolve().parents[1] / "platform"
    )
).resolve()
sys.path.insert(0, str(root / "backend"))
os.environ["ALCOR_ROOT"] = str(root)


def create_app():
    from alcor_api.fire_config import load_fire_settings
    from alcor_api.main import create_app as platform_app

    settings = load_fire_settings()
    app = platform_app(settings)
    app.state.fire_version = os.environ.get("FIRE_SOFTWARE_VERSION", "")
    public = urlsplit(settings.public_origin)

    @app.middleware("http")
    async def local_gateway(request, call_next):
        if request.headers.get("host") != public.netloc:
            from fastapi.responses import JSONResponse

            return JSONResponse({"error": "入口不匹配"}, status_code=403)
        request.scope["scheme"] = public.scheme
        return await call_next(request)

    return app


async def inspect_database():
    import psycopg
    from psycopg.rows import dict_row

    dsn = os.environ.get("FIRE_DATABASE_URL")
    if not dsn:
        raise ValueError("请先填写 FIRE_DATABASE_URL")
    from alcor_api.fire_config import validate_database_target

    validate_database_target(dsn)
    async with await psycopg.AsyncConnection.connect(
        dsn,
        connect_timeout=3,
        row_factory=dict_row,
        options="-c default_transaction_read_only=on -c statement_timeout=5000",
    ) as conn:
        marker = (
            await (
                await conn.execute(
                    "SELECT to_regclass('public.alcor_instance') AS marker"
                )
            ).fetchone()
        )["marker"]
        if marker:
            row = await (
                await conn.execute(
                    "SELECT instance_id::text,environment,product FROM alcor_instance WHERE singleton=true"
                )
            ).fetchone()
            if not row:
                raise ValueError("数据库实例标识不完整")
            return {
                "state": "marked",
                "instance_id": row["instance_id"],
                "environment": row["environment"],
                "product": row["product"],
                "configured_identity_matches": row["instance_id"]
                == os.environ.get("FIRE_INSTANCE_ID")
                and row["environment"] == os.environ.get("FIRE_ENVIRONMENT"),
                "wrote_database": False,
            }
        exists = await (
            await conn.execute(
                "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' LIMIT 1"
            )
        ).fetchone()
        return {
            "state": "unmarked_nonempty"
            if exists
            else "empty_requires_explicit_initialization",
            "wrote_database": False,
        }


async def command(mode, args):
    from alcor_api.fire_config import load_fire_settings

    if mode == "inspect-database":
        return await inspect_database()
    settings = load_fire_settings()
    if mode == "validate-config":
        return {
            "valid": True,
            "instance_id": str(settings.instance_id),
            "environment": settings.environment,
            "redis_configured": bool(settings.redis_url),
            "worker_enabled": os.environ.get("FIRE_WORKER") == "on",
            "mail_enabled": settings.mail_enabled,
            "restore_targets": len(settings.restore_targets),
            "automatic_migration": False,
        }
    if mode == "check-schema":
        from alcor_api.schema_preflight import check

        value = await check(settings)
        if not value["compatible"]:
            raise ValueError("数据库迁移版本与当前源码不一致；未修改数据库")
        return value
    if mode == "migrate":
        import argparse

        parser = argparse.ArgumentParser(prog="fire platform:migrate")
        parser.add_argument("--database", required=True)
        parser.add_argument("--initialize-empty", action="store_true")
        flags = parser.parse_args(args)
        from alcor_api.migrate import migrate

        await migrate(settings, flags.database, initialize_empty=flags.initialize_empty)
        return {"migrated": True, "instance_id": str(settings.instance_id)}
    raise ValueError("运行方式无效")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if mode == "serve":
            import uvicorn

            uvicorn.run(
                create_app(),
                uds=os.environ["FIRE_PLATFORM_SOCKET"],
                access_log=False,
                proxy_headers=False,
            )
        elif mode == "worker":
            import logging

            from alcor_api.fire_config import load_fire_settings
            from alcor_api.worker import run

            logging.basicConfig(level=logging.INFO)
            asyncio.run(run(load_fire_settings()))
        else:
            print(
                json.dumps(asyncio.run(command(mode, sys.argv[2:])), ensure_ascii=False)
            )
    except Exception as error:  # noqa: BLE001 -- CLI boundary must never print credentials from arbitrary driver errors
        # Pydantic is configured to hide input values. Other failures never echo a DSN or credentials.
        from pydantic import ValidationError

        if isinstance(error, ValidationError):
            print(
                "Fire 配置无效："
                + ", ".join(".".join(map(str, e["loc"])) for e in error.errors()),
                file=sys.stderr,
            )
        elif isinstance(error, ValueError) and type(error) is ValueError:
            print(str(error), file=sys.stderr)
        else:
            print(
                "Fire 启动或核对失败，请检查配置、私有目录、数据库身份及迁移版本",
                file=sys.stderr,
            )
        sys.exit(1)
