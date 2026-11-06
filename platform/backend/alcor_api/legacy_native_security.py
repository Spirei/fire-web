"""Native v1/v2 security adapters; shared factors remain the only authority."""

from types import SimpleNamespace

from fastapi import HTTPException, Request, Response

from .legacy_identity import (
    LegacyError,
    assert_native_origin,
    body,
    envelope,
    native_identity,
    native_version,
)
from .legacy_passkeys import text
from .native_app_auth import authenticate
from .security import digest


def mount_legacy_native_security(app, settings, db, rate_limit):
    management = app.state.identity_management
    keys = app.state.passkey_management

    async def member(request, write=False, action=None):
        native_version(request)
        assert_native_origin(request, settings)
        who, _ = await native_identity(request, db, "security.write" if write else "security.read")
        if action:
            address = request.client.host if request.client else "unknown"
            maximum = 8 if action == "totp-setup" else 15 if action == "passkey-remove" else 20
            for key, limit in (
                (digest("identity-manage:" + who.id), 20),
                (digest("native-security:" + action + ":" + who.id), maximum),
                (digest("native-security-ip:" + address), 100),
                ("native-security-global", 500),
            ):
                if not await rate_limit(db, key, limit):
                    raise LegacyError(429, 42901, "尝试过于频繁")
        return who

    async def invalidated(who):
        async with db.connection() as conn:
            try:
                await authenticate(conn, who.native_access_token)
                return False
            except HTTPException as exc:
                if exc.status_code == 401:
                    return True
                raise

    def translate(exc):
        if exc.status_code == 403 and exc.detail == "当前密码不正确":
            return LegacyError(403, 40103, str(exc.detail))
        if exc.status_code == 403 and exc.detail == "二次验证码或备用码不正确":
            return LegacyError(403, 40104, "二次验证失败")
        if exc.status_code == 409:
            return LegacyError(409, 40902, str(exc.detail))
        if exc.status_code == 400 and exc.detail == "验证码不正确，或设置已过期":
            return LegacyError(403, 40104, "验证码错误或设置已过期")
        return exc

    @app.get("/api/v{version}/auth/totp", tags=["legacy-native-security"])
    async def totp_status(version: int, request: Request, response: Response):
        who = await member(request)
        return envelope(await management.status(who), request, response)

    @app.post("/api/v{version}/auth/totp/{action}", tags=["legacy-native-security"])
    async def totp_change(version: int, action: str, request: Request, response: Response):
        if action not in ("setup", "confirm", "disable", "backup-codes"):
            raise LegacyError(404, 40401, "接口不存在")
        who = await member(request, True, "totp-" + action)
        allowed = (
            ("currentPassword",)
            if action == "setup"
            else ("currentPassword", "code", "challengeId", "name")
            if action == "confirm"
            else ("currentPassword", "code")
        )
        raw = await body(request, allowed)
        data = SimpleNamespace(
            password=text(raw, "currentPassword"),
            code=text(raw, "code", maximum=1024),
            challengeId=text(raw, "challengeId", maximum=1024),
            name=text(raw, "name", default="身份验证应用", minimum=1, maximum=64, trim=True, label=True),
        )
        try:
            operation = {
                "setup": management.setup,
                "confirm": management.confirm,
                "disable": management.disable,
                "backup-codes": management.regenerate,
            }[action]
            result = await operation(data, who)
        except HTTPException as exc:
            raise translate(exc) from None
        if action != "setup":
            result["reauthenticationRequired"] = await invalidated(who)
        return envelope(result, request, response)

    @app.get("/api/v{version}/auth/passkeys", tags=["legacy-native-security"])
    async def passkey_list(version: int, request: Request, response: Response):
        who = await member(request)
        result = await keys.list(who)
        config = await keys.config()
        return envelope(
            {
                "keys": result["keys"],
                "registration": {
                    "supported": False,
                    "rpID": config["rpID"],
                    "origin": config["origin"],
                    "reason": "web_registration_only",
                },
            },
            request,
            response,
        )

    @app.delete("/api/v{version}/auth/passkeys", tags=["legacy-native-security"])
    async def passkey_remove(version: int, request: Request, response: Response):
        who = await member(request, True, "passkey-remove")
        raw = await body(request, ("id", "currentPassword", "code"))
        data = SimpleNamespace(
            id=text(raw, "id", minimum=1, maximum=1024),
            password=text(raw, "currentPassword"),
            code=text(raw, "code", maximum=1024),
        )
        try:
            await keys.remove(data, who)
        except HTTPException as exc:
            raise translate(exc) from None
        return envelope({"ok": True, "reauthenticationRequired": await invalidated(who)}, request, response)



    @app.post("/api/v{version}/auth/password-change/{action}", tags=["legacy-native-security"])
    async def password_change(version: int, action: str, request: Request, response: Response):
        from .account_credentials import confirm_password_proof, issue_password_proof

        if action not in ("verify", "confirm"):
            raise LegacyError(404, 40401, "接口不存在")
        who = await member(request, True, "password-change")
        raw = await body(request, ("currentPassword",) if action == "verify" else ("proof", "newPassword"))
        try:
            if action == "verify":
                result = await issue_password_proof(
                    db, who, text(raw, "currentPassword"), request.state.request_id
                )
            else:
                result = await confirm_password_proof(
                    db,
                    who,
                    text(raw, "proof", maximum=1024),
                    text(raw, "newPassword", minimum=1),
                    request.state.request_id,
                )
        except HTTPException as exc:
            if exc.status_code == 403 and exc.detail == "原密码错误":
                raise LegacyError(403, 40103, str(exc.detail)) from None
            if exc.status_code == 400:
                raise LegacyError(
                    400, 40003 if exc.detail == "验证凭证错误或已失效" else 40001, str(exc.detail)
                ) from None
            raise
        return envelope(result, request, response)

    from .native_security_aliases import mount_security_alias

    mount_security_alias(app, "/totp", ["GET"], totp_status)
    mount_security_alias(app, "/totp/{action}", ["POST"], totp_change, action=True)
    mount_security_alias(app, "/passkeys", ["GET"], passkey_list)
    mount_security_alias(app, "/passkeys", ["DELETE"], passkey_remove)
    mount_security_alias(app, "/password-change/{action}", ["POST"], password_change, action=True)
