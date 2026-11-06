"""One registration transaction for new and legacy Web protocol adapters."""

import asyncio
import hmac
from uuid import UUID

from fastapi import HTTPException

from .accounts import LoginConflict, insert_account, registration_status
from .passwords import hash_password, password_error
from .security import digest


async def require_setup_token(conn, settings, provided):
    """Serialize public first-admin claims and enforce the installed production secret."""
    await conn.execute("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE")
    if settings.environment != "production" or not (await registration_status(conn))["first_user"]:
        return
    expected = settings.registration_setup_token
    expected = expected.get_secret_value() if expected else ""
    if len(expected) < 32:
        raise HTTPException(503, "请先配置至少32字符的安装令牌")
    if not isinstance(provided, str) or len(provided) > 512:
        raise HTTPException(403, "安装令牌无效")
    try:
        candidate, installed = provided.encode("utf-8"), expected.encode("utf-8")
    except UnicodeEncodeError:
        raise HTTPException(403, "安装令牌无效") from None
    if not hmac.compare_digest(candidate, installed):
        raise HTTPException(403, "安装令牌无效")


async def register_account(db, rate_limit, address, username, password, request_id, create_session, *, setup_token=None):
    ip_ok = await rate_limit(db, digest("register-ip:" + address), 20)
    name_ok = await rate_limit(db, digest("register-name:" + username.lower()), 6)
    if not ip_ok or not name_ok:
        raise HTTPException(429, "注册尝试次数过多，请稍后再试")
    if message := password_error(password):
        raise HTTPException(400, message)
    hashed = await asyncio.to_thread(hash_password, password)
    try:
        async with db.connection() as conn, conn.transaction():
            await require_setup_token(conn, db.settings, setup_token)
            user = await insert_account(conn, username, hashed)
            await conn.execute(
                "INSERT INTO audit_events (actor_id,action,request_id) VALUES (%s,'user.registered',%s)",
                (user["id"], UUID(request_id)),
            )
            token, session = await create_session(conn, user, request_id)
    except LoginConflict:
        raise HTTPException(409, "用户名已被使用，请换一个用户名或登录已有账号") from None
    return user, token, session
