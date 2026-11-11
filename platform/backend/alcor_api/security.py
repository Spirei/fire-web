import hashlib
import secrets
from dataclasses import dataclass
from datetime import datetime

from fastapi import HTTPException, Request

COOKIE = "alcor_session"


def assert_expected_account(request, account_id):
    # A consistency check after authentication, never a caller-supplied identity.
    expected = request.headers.get("x-alcor-expected-account")
    if expected is not None and expected != account_id:
        raise HTTPException(403, "当前账号已变化，请重新读取", headers={"X-Alcor-Retire-Context": "true"})


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def csrf_token(token: str) -> str:
    return digest("alcor.csrf.v1:" + token)


@dataclass
class Identity:
    id: str
    username: str
    role: str
    token_hash: str
    csrf: str
    expires_at: datetime


def trusted_origin(request: Request):
    if (
        request.headers.get("origin") != request.app.state.settings.public_origin
        or request.headers.get("sec-fetch-site") == "cross-site"
    ):
        raise HTTPException(403, "请求来源未获允许")


async def identity(request: Request) -> Identity:
    token = request.cookies.get(COOKIE, "")
    if not token or len(token) > 128:
        raise HTTPException(401, "请先登录")
    async with request.app.state.db.connection() as conn:
        row = await (
            await conn.execute(
                """
            SELECT u.id,u.username,u.role,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
            WHERE s.token_hash=%s AND s.expires_at>clock_timestamp() AND u.active
              AND s.session_version=u.session_version AND s.client_id='new-web'
        """,
                (digest(token),),
            )
        ).fetchone()
    if not row:
        raise HTTPException(401, "登录已失效，请重新登录")
    who = Identity(**row, token_hash=digest(token), csrf=csrf_token(token))
    assert_expected_account(request, who.id)
    # New Web binds reads to its displayed session. Older clients may omit this header.
    read_binding = request.headers.get("x-csrf-token")
    if request.method in {"GET", "HEAD"} and read_binding is not None:
        if not secrets.compare_digest(read_binding, who.csrf):
            raise HTTPException(
                403,
                "登录身份已变化，请重新读取当前账号",
                headers={"X-Alcor-Session-Changed": "true"},
            )
    if request.method not in {"GET", "HEAD", "OPTIONS"}:
        trusted_origin(request)
        if not secrets.compare_digest(request.headers.get("x-csrf-token", ""), who.csrf):
            raise HTTPException(403, "操作校验已失效，请刷新页面")
    from .request_activity import bind_account
    bind_account(who.id)
    return who


async def administrator(request: Request) -> Identity:
    who = await identity(request)
    if who.role != "admin":
        raise HTTPException(403, "需要管理员权限")
    return who


async def lock_mutation_identity(conn, who: Identity, *, require_admin=True):
    """Revalidate and hold identity until commit; a prior HTTP check cannot authorize a late write."""
    if getattr(who, "grant_id", None):
        if require_admin:
            raise HTTPException(403, "客户端不能执行管理操作")
        if getattr(who,"native_client",False):
            from .native_app_auth import lock_native_mutation
            await lock_native_mutation(conn,who)
            return
        from .client_auth import lock_client_mutation

        return await lock_client_mutation(conn, who)
    row = await (
        await conn.execute(
            """
        SELECT u.id FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.token_hash=%s AND u.id=%s AND u.active AND (NOT %s OR u.role='admin')
          AND s.expires_at>clock_timestamp() AND s.session_version=u.session_version
          AND s.client_id=ANY(%s) FOR SHARE OF u,s
    """,
            (who.token_hash, who.id, require_admin, ["legacy-web","legacy-v1"] if getattr(who,"legacy_client",False) and not getattr(who,"legacy_platform",False) else ["new-web"]),
        )
    ).fetchone()
    if not row:
        raise HTTPException(401, "操作授权已变化，请重新登录核对")
