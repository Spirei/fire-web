"""Legacy Web credential contract over the single platform password service."""

from fastapi import HTTPException, Request, Response

from .account_credentials import change_own_password
from .legacy_passkeys import text
from .security import digest

PATH = "/api/auth/password"


def mount_legacy_identity_security(app, settings, db, rate_limit, web_identity, read_body):
    @app.post(PATH, tags=["legacy-web-security"])
    async def password(request: Request):
        who, _, _ = await web_identity(request)
        address = request.client.host if request.client else "unknown"
        budgets = (
            ("change-password:" + who.id, 10),
            (digest("legacy-password-ip:" + address + ":" + who.id), 20),
            ("legacy-password-global", 100),
        )
        for key, maximum in budgets:
            if not await rate_limit(db, key, maximum):
                raise HTTPException(429, "尝试过于频繁，请稍后再试")
        data = await read_body(request, ("oldPassword", "newPassword", "code", "signOutOthers"))
        old = text(data, "oldPassword", minimum=1)
        new = text(data, "newPassword", minimum=1)
        code = text(data, "code", maximum=64)
        sign_out = data.get("signOutOthers", True)
        if type(sign_out) is not bool:
            raise HTTPException(400, "密码或验证码格式不正确")
        try:
            await change_own_password(
                db,
                who,
                old,
                new,
                code,
                request.state.request_id,
                keep_current=True,
                keep_all_sessions=not sign_out,
            )
        except HTTPException as exc:
            # Web historically uses 400 for rejected credentials/factors; preserve
            # authorization expiry, conflict and provider failures as distinct errors.
            if exc.status_code == 422:
                message = "原密码错误" if exc.detail == "当前密码不正确" else str(exc.detail)
                raise HTTPException(400, message) from None
            if exc.status_code == 403 and exc.detail == "二次验证失败":
                raise HTTPException(400, str(exc.detail)) from None
            raise
        return {"ok": True, "signedOutOthers": sign_out}

    @app.post("/api/v{version}/auth/password", tags=["legacy-native-security"])
    async def native_password(version: int, request: Request, response: Response):
        from .legacy_identity import (
            LegacyError,
            assert_native_origin,
            envelope,
            native_identity,
            native_version,
            public_profile,
        )
        from .legacy_identity import (
            web_identity as legacy_member,
        )

        native_version(request)
        assert_native_origin(request, settings)
        authorization = request.headers.get("authorization", "")
        if version == 1 and not authorization.startswith("Bearer fat_"):
            who, _, _ = await legacy_member(request, db, allow_v1_bearer=True)
        else:
            who, _ = await native_identity(request, db, "portfolio.read")
        address = request.client.host if request.client else "unknown"
        for key, maximum in (
            ("change-password:" + who.id, 10),
            (digest("legacy-password-ip:" + address + ":" + who.id), 20),
            ("legacy-password-global", 100),
        ):
            if not await rate_limit(db, key, maximum):
                raise LegacyError(429, 42901, "尝试过于频繁，请稍后再试")
        data = await read_body(request, ("currentPassword", "newPassword", "code"))
        old = text(data, "currentPassword", minimum=1)
        new = text(data, "newPassword", minimum=1)
        code = text(data, "code", maximum=64)
        async with db.connection() as conn:
            profile = await public_profile(conn, who.id)
        user = {
            key: profile[key]
            for key in ("id", "username", "nickname", "uid", "email", "emailVerified", "avatar", "role")
        }
        user["isTest"] = profile["is_test"]
        if getattr(who, "native_client", False):
            user["role"] = "user"
        try:
            await change_own_password(db, who, old, new, code, request.state.request_id)
        except HTTPException as exc:
            if exc.status_code == 422:
                if exc.detail == "当前密码不正确":
                    raise LegacyError(403, 40103, "原密码错误") from None
                raise LegacyError(400, 40001, str(exc.detail)) from None
            if exc.status_code == 403 and exc.detail == "二次验证失败":
                raise LegacyError(403, 40104, str(exc.detail)) from None
            raise
        return envelope(
            {"ok": True, "signedOutOthers": True, "reauthenticationRequired": True, "user": user},
            request,
            response,
        )
