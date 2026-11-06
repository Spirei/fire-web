"""The live PG registration gate, shared by every public account insertion."""

from fastapi import HTTPException

MIGRATION = "0085_site_settings.sql"


async def installed(conn):
    row = await (
        await conn.execute(
            "SELECT EXISTS(SELECT 1 FROM public.schema_migrations WHERE name=%s) AS installed", (MIGRATION,)
        )
    ).fetchone()
    if row["installed"]:
        return True
    relation = await (await conn.execute("SELECT to_regclass('public.site_settings') AS relation")).fetchone()
    if relation["relation"] is not None:
        raise HTTPException(503, "站点配置结构与迁移记录不一致")
    return False


async def registration_open(conn):
    if not await installed(conn):
        # A historical schema keeps its established open-registration behavior.
        return True
    row = await (
        await conn.execute("SELECT allow_register FROM public.site_settings WHERE singleton FOR SHARE")
    ).fetchone()
    if not row:
        raise HTTPException(503, "站点注册配置缺失")
    return row["allow_register"]


async def require_registration_open(conn):
    if not await registration_open(conn):
        raise HTTPException(403, "注册暂未开放")
