"""The single Fire configuration namespace; independent AlcorApi environment is not inherited."""

import os

from .config import Settings

REQUIRED = ("DATABASE_URL", "INSTANCE_ID", "ENVIRONMENT", "PUBLIC_ORIGIN")


def validate_database_target(dsn):
    """Require a concrete current PG target instead of libpq's ambient defaults."""
    from psycopg import ProgrammingError
    from psycopg.conninfo import conninfo_to_dict

    try:
        target = conninfo_to_dict(dsn)
    except ProgrammingError:
        raise ValueError("FIRE_DATABASE_URL 格式无效") from None
    if any(not target.get(key, "").strip() for key in ("host", "user", "dbname")) or target.get("service"):
        raise ValueError("FIRE_DATABASE_URL 必须明确填写数据库主机、用户和库名，不能依赖默认连接")
    return dsn


def load_fire_settings():
    missing = [name for name in REQUIRED if not os.environ.get("FIRE_" + name, "").strip()]
    if missing:
        raise ValueError("缺少必填配置：" + ", ".join("FIRE_" + name for name in missing))
    validate_database_target(os.environ["FIRE_DATABASE_URL"])
    # Fire has one infrastructure authority: its server environment.
    overrides = {"connections_from_environment": True, "deployment_checks_workflow": "docker-publish.yml"}
    if "FIRE_BUILD_SHA" in os.environ:
        overrides["source_revision"] = os.environ["FIRE_BUILD_SHA"]
    for name, field in Settings.model_fields.items():
        value = os.environ.get("FIRE_" + name.upper())
        if value == "" and field.default is None:
            overrides[name] = None
    setup_token = os.environ.get("FIRE_SETUP_TOKEN", "")
    previous_token = os.environ.get("FIRE_REGISTRATION_SETUP_TOKEN", "")
    if setup_token:
        if previous_token and setup_token != previous_token:
            raise ValueError("安装令牌配置重复，请统一使用 FIRE_SETUP_TOKEN")
        overrides["registration_setup_token"] = setup_token
    image = os.environ.get("GHCR_IMAGE", "")
    if (
        image
        and not os.environ.get("FIRE_DEPLOYMENT_IMAGE")
        and not os.environ.get("FIRE_DEPLOYMENT_REPOSITORY")
    ):
        overrides["deployment_image"] = image
        overrides["deployment_repository"] = image.removeprefix("ghcr.io/")
    result = Settings(_env_prefix="FIRE_", **overrides)
    if result.trusted_proxy_ips:
        raise ValueError("Fire 内置后端使用私有 socket，无需配置 FIRE_TRUSTED_PROXY_IPS")
    return result
