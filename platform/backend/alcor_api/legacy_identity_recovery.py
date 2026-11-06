"""Legacy Web/native password recovery over the platform's single proof service."""

import secrets

from fastapi import HTTPException, Request, Response

from .identity_recovery import IdentityRecovery
from .legacy_identity import LegacyError, assert_native_origin, body, envelope, native_version, web_identity
from .legacy_passkeys import text
from .security import digest, trusted_origin


def mount_legacy_identity_recovery(app, settings, db, rate_limit):
    service = IdentityRecovery(settings, db, app.state.identity_email.mail, rate_limit)
    app.state.identity_recovery = service

    async def budget(request, action):
        maximum = {"request": 5, "verify": 20, "confirm": 10}[action]
        global_max = {"request": 80, "verify": 200, "confirm": 120}[action]
        address = request.client.host if request.client else "unknown"
        for key, limit in (
            (digest("password-reset-" + action + ":" + address), maximum),
            ("password-reset-" + action + ":global", global_max),
        ):
            if not await rate_limit(db, key, limit):
                raise LegacyError(429, 42901, "请求过于频繁，请稍后再试")

    async def recover(request, action, native=False):
        if action not in ("request", "verify", "confirm"):
            raise LegacyError(404, 40401, "接口不存在")
        if native:
            native_version(request)
            assert_native_origin(request, settings)
        else:
            trusted_origin(request)
        await budget(request, action)
        allowed = {
            "request": ("login", "challenge"),
            "verify": ("challenge", "code"),
            "confirm": ("token", "newPassword"),
        }[action]
        if not native and action != "confirm":
            allowed = (*allowed, "method")
        raw = await body(request, allowed, 16384 if action == "confirm" else 8192)
        method = raw.get("method", "email")
        if method not in ("email", "totp"):
            raise LegacyError(400, 40002, "请求参数无效")
        if action == "request":
            login = text(raw, "login", maximum=160, minimum=1, trim=True)
            supplied = text(raw, "challenge", maximum=128)
            self_id = None
            if not native and not request.headers.get("authorization"):
                try:
                    self_id = (await web_identity(request, db, allow_platform=True))[0].id
                except HTTPException as exc:
                    if exc.status_code not in (401, 403):
                        raise
            try:
                challenge = await service.request(login, method, supplied, self_id)
            except HTTPException as exc:
                # No account-specific mail/vault setup failures escape public
                # recovery. A signed-in owner may see their own actionable error.
                if exc.status_code >= 500 and self_id is None:
                    challenge = secrets.token_urlsafe(32)
                else:
                    raise
            message = (
                "请使用该账号已配置的验证器验证码或备用码。"
                if method == "totp"
                else "如果账号已绑定并验证邮箱，验证码会发送至该邮箱。请检查收件箱与垃圾邮件。"
                if native
                else "如果账号已绑定邮箱，验证码会发送至该邮箱。请检查收件箱与垃圾邮件。"
            )
            return {"ok": True, "challenge": challenge, "retryAfter": 60, "message": message}
        if action == "verify":
            try:
                result = await service.verify(
                    text(raw, "challenge", maximum=128), text(raw, "code", maximum=64, trim=True), method
                )
            except HTTPException as exc:
                if exc.status_code == 400:
                    raise LegacyError(400, 40003, str(exc.detail)) from None
                raise
            return result if native else {"ok": True, "token": result["token"]}
        try:
            result = await service.confirm(
                text(raw, "token", maximum=128),
                text(raw, "newPassword", maximum=128, minimum=1),
                request.state.request_id,
            )
        except HTTPException as exc:
            if exc.status_code == 400:
                raise LegacyError(
                    400, 40003 if exc.detail == "验证凭证错误或已失效" else 40001, str(exc.detail)
                ) from None
            raise
        return result if native else {"ok": True}

    @app.post("/api/auth/password-reset/request", tags=["legacy-web-identity"])
    async def web_recovery_request(request: Request):
        return await recover(request, "request")

    @app.post("/api/auth/password-reset/verify", tags=["legacy-web-identity"])
    async def web_recovery_verify(request: Request):
        return await recover(request, "verify")

    @app.post("/api/auth/password-reset/confirm", tags=["legacy-web-identity"])
    async def web_recovery_confirm(request: Request):
        return await recover(request, "confirm")

    @app.post("/api/v{version}/auth/password-reset/{action}", tags=["legacy-native-identity"])
    async def native_recovery(version: int, action: str, request: Request, response: Response):
        return envelope(await recover(request, action, True), request, response)

    from .native_security_aliases import mount_security_alias

    mount_security_alias(app, "/password-reset/{action}", ["POST"], native_recovery, action=True)
