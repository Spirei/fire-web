"""Email protocol adapters; owner credentials and security proofs remain distinct."""

from fastapi import HTTPException, Request, Response

from .identity_email_change import IdentityEmailChange
from .legacy_identity import (
    LegacyError,
    assert_native_origin,
    body,
    envelope,
    native_identity,
    native_version,
    public_profile,
    web_identity,
)
from .legacy_passkeys import text
from .security import digest, identity


def mount_legacy_identity_email_change(app, settings, db, rate_limit):
    service = IdentityEmailChange(settings, db, app.state.identity_email.mail)
    app.state.identity_email_change = service

    async def limits(request, who, proof):
        address = request.client.host if request.client else "unknown"
        buckets = (
            (
                ("account-change:email:" + who.id, 30),
                (digest("account-change-ip:" + address), 100),
                ("account-change-global", 500),
            )
            if proof
            else (
                (digest("profile:" + address + ":" + who.id), 30),
                ("profile-account:" + who.id, 30),
                ("profile-global", 300),
            )
        )
        for key, maximum in buckets:
            if not await rate_limit(db, key, maximum, window_seconds=900 if proof else 3600):
                raise LegacyError(429, 42901, "操作过于频繁，请稍后再试")

    def translated(exc):
        code = exc.status_code * 100 + 1
        if exc.detail == "修改邮箱需要验证当前密码":
            code = 40103
        elif exc.detail == "二次验证失败":
            code = 40104
        elif exc.detail in ("请先绑定邮箱", "请填写新的邮箱"):
            code = 40902
        elif exc.detail in ("验证码错误或已失效", "验证凭证错误或已失效"):
            code = 40003
        return LegacyError(exc.status_code, code, str(exc.detail))

    @app.put("/api/v{version}/auth/email", tags=["legacy-native-identity"])
    async def direct(version: int, request: Request, response: Response):
        native_version(request)
        assert_native_origin(request, settings)
        grant = None
        if version == 1 and not request.headers.get("authorization", "").startswith("Bearer fat_"):
            who, _, _ = await web_identity(request, db, allow_v1_bearer=True)
        else:
            who, grant = await native_identity(request, db, "portfolio.read")
        return envelope(await direct_result(request, who, grant), request, response)

    async def direct_result(request, who, grant):
        await limits(request, who, False)
        raw = await body(request, ("email", "currentPassword", "code"))
        if not isinstance(raw.get("email"), str):
            raise LegacyError(400, 40001, "请填写邮箱")
        try:
            await service.direct(
                who,
                text(raw, "email", maximum=254),
                text(raw, "currentPassword", maximum=512),
                text(raw, "code", maximum=64),
                request.state.request_id,
            )
        except HTTPException as exc:
            raise translated(exc) from None
        async with db.connection() as conn:
            profile = await public_profile(
                conn, who.id, scope=grant["scope"] if grant else None, settings=settings
            )
        return profile

    @app.put("/api/client/email", tags=["client-identity"])
    async def client_email(request: Request):
        assert_native_origin(request, settings)
        who, grant = await native_identity(request, db, "portfolio.read")
        return await direct_result(request, who, grant)

    async def stepwise_result(action: str, request: Request):
        assert_native_origin(request, settings)
        if action not in ("request", "verify", "confirm"):
            raise LegacyError(404, 40401, "接口不存在")
        who, _ = await native_identity(request, db, "security.write")
        await limits(request, who, True)
        raw = await body(
            request, {"request": (), "verify": ("challenge", "code"), "confirm": ("proof", "email")}[action]
        )
        try:
            if action == "request":
                result = await service.request(who, request.state.request_id)
            elif action == "verify":
                result = await service.verify(
                    who, text(raw, "challenge", maximum=128), text(raw, "code", maximum=64)
                )
            else:
                result = await service.confirm(
                    who,
                    text(raw, "proof", maximum=128),
                    text(raw, "email", maximum=254),
                    request.state.request_id,
                )
        except HTTPException as exc:
            raise translated(exc) from None
        return result

    @app.post("/api/v{version}/auth/email-change/{action}", tags=["legacy-native-identity"])
    async def stepwise(version: int, action: str, request: Request, response: Response):
        native_version(request)
        return envelope(await stepwise_result(action, request), request, response)

    @app.post("/api/client/email-change/request", tags=["client-identity"])
    async def client_email_request(request: Request):
        return await stepwise_result("request", request)

    @app.post("/api/client/email-change/verify", tags=["client-identity"])
    async def client_email_verify(request: Request):
        return await stepwise_result("verify", request)

    @app.post("/api/client/email-change/confirm", tags=["client-identity"])
    async def client_email_confirm(request: Request):
        return await stepwise_result("confirm", request)

    @app.get("/api/account/email", tags=["account"])
    async def own_email(request: Request):
        who = await identity(request)
        async with db.connection() as conn:
            profile = await public_profile(conn, who.id)
        return {
            "email": profile["email"],
            "verified": profile["emailVerified"],
            "twoFactorEnabled": profile["security"]["twoFactorEnabled"],
        }

    @app.put("/api/account/email", tags=["account"])
    async def change_own_email(request: Request):
        who = await identity(request)
        await limits(request, who, False)
        raw = await body(request, ("email", "currentPassword", "code"))
        if not isinstance(raw.get("email"), str):
            raise HTTPException(400, "请填写邮箱")
        await service.direct(
            who,
            text(raw, "email", maximum=254),
            text(raw, "currentPassword", maximum=512),
            text(raw, "code", maximum=64),
            request.state.request_id,
        )
        async with db.connection() as conn:
            profile = await public_profile(conn, who.id)
        return {
            "email": profile["email"],
            "verified": profile["emailVerified"],
            "twoFactorEnabled": profile["security"]["twoFactorEnabled"],
        }

    @app.post("/api/account/email/verification", tags=["account"])
    async def verify_own_email(request: Request):
        who = await identity(request)
        await limits(request, who, False)
        result = await app.state.identity_email.request_verification(who)
        return result if result["verified"] else {"ok": True, "deliveryStatus": "queued"}
