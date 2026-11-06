"""Legacy v1 self-closure contract using the platform's durable account retirement."""

from types import SimpleNamespace
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .account_admin import retire_account
from .legacy_identity import body, legacy_me_mutation_trusted, web_identity
from .passwords import js_length
from .security import digest

PATH = "/api/v1/auth/delete-account"


def mount_legacy_account_closure(app, settings, db, rate_limit):
    @app.post(PATH, tags=["legacy-account-security"])
    async def close_legacy_account(request: Request):
        try:
            authorization = request.headers.get("authorization", "")
            if authorization.startswith("Bearer fat_"):
                # The old appIdentity allowlist excludes delete-account entirely.
                raise HTTPException(401, "未登录")
            else:
                if not authorization.startswith("Bearer ") and not legacy_me_mutation_trusted(request):
                    raise HTTPException(401, "未登录")
                who, _, _ = await web_identity(request, db, allow_v1_bearer=True, origin_checked=True)
            address = request.client.host if request.client else "unknown"
            for key, maximum in (
                (digest("delete-account:" + address + ":" + who.id), 5),
                ("delete-account-global", 30),
            ):
                if not await rate_limit(db, key, maximum, window_seconds=3600):
                    raise HTTPException(429, "尝试过于频繁，请稍后再试")
            data = await body(request, ("password", "code"))
            password, code = data.get("password", ""), data.get("code", "")
            if not isinstance(password, str) or js_length(password) > 128:
                raise HTTPException(403, "当前密码错误")
            if not isinstance(code, str) or js_length(code) > 64:
                raise HTTPException(403, "二次验证失败")
            async with db.connection() as conn, conn.transaction():
                # Same global -> identity -> row order as administrator retirement.
                await conn.execute("SELECT pg_advisory_xact_lock(67132005)")
                await app.state.identity_management.serialize(conn, who)
                try:
                    user = await app.state.native_passkeys.step_up(conn, who, password, code)
                except HTTPException as exc:
                    if exc.status_code == 403:
                        message = "当前密码错误" if exc.detail == "当前密码不正确" else "二次验证失败"
                        raise HTTPException(403, message) from None
                    raise
                command = SimpleNamespace(
                    request_id=UUID(request.state.request_id), revision=user["revision"]
                )
                try:
                    await retire_account(
                        conn, who, who.id, command, request.state.request_id, self_close=True
                    )
                except HTTPException as exc:
                    if exc.status_code == 409 and "管理员" in str(exc.detail):
                        raise HTTPException(400, "不能删除最后一个管理员账号") from None
                    raise
            return JSONResponse({"ok": True}, headers={"Cache-Control": "no-store"})
        except HTTPException as exc:
            message = "未登录" if exc.status_code == 401 else str(exc.detail)
            return JSONResponse(
                {"error": message}, status_code=exc.status_code, headers={"Cache-Control": "no-store"}
            )
        except Exception:  # noqa: BLE001 - protocol boundary must not expose database or credential details
            return JSONResponse(
                {"error": "账号注销失败，请稍后再试"}, status_code=500, headers={"Cache-Control": "no-store"}
            )
