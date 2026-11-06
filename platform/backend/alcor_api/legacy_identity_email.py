"""Email identity protocols backed by shared PG challenges and durable delivery."""

from fastapi import HTTPException, Request, Response

from .identity_email import IdentityEmail, normalized_email
from .legacy_identity import (
    WEB_COOKIE,
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
from .security import digest, trusted_origin
from .web_email_registration import recipient_budget, registration_budget


def mount_legacy_identity_email(app, settings, db, rate_limit):
    service = IdentityEmail(settings, db)
    app.state.identity_email = service

    async def budget(request, label, owner=None, *, maximum=20, window=900):
        address = request.client.host if request.client else "unknown"
        keys = [
            (digest("identity-mail:" + label + ":ip:" + address), maximum),
            ("identity-mail:" + label + ":global", maximum * 20),
        ]
        if owner:
            keys.append((digest("identity-mail:" + label + ":owner:" + owner), maximum))
        for key, limit in keys:
            if not await rate_limit(db, key, limit, window_seconds=window):
                raise HTTPException(429, "尝试过于频繁，请稍后再试")

    @app.post("/api/auth/register/email/request", tags=["legacy-web-identity"])
    async def registration_request(request: Request):
        trusted_origin(request)
        await registration_budget(request, db, rate_limit)
        raw = await body(request, ("email",), 8192)
        email = normalized_email(raw.get("email"))
        await recipient_budget(db, rate_limit, email)
        return await service.request_registration(email)

    @app.post("/api/auth/register/email/confirm", status_code=201, tags=["legacy-web-identity"])
    async def registration_confirm(request: Request, response: Response):
        trusted_origin(request)
        await registration_budget(request, db, rate_limit, confirm=True)
        raw = await body(request, ("email", "challenge", "code", "password", "setupToken"))
        email = normalized_email(raw.get("email"))
        user, token, _ = await service.confirm_registration(
            email,
            text(raw, "challenge", maximum=128),
            text(raw, "code", maximum=6),
            text(raw, "password", minimum=1),
            request.state.request_id,
            app.state.legacy_create_session,
            setup_token=text(raw, "setupToken", maximum=512) if "setupToken" in raw else None,
        )
        response.set_cookie(
            WEB_COOKIE,
            token,
            path="/",
            httponly=True,
            secure=settings.secure_cookie,
            samesite="lax",
            max_age=settings.session_hours * 3600,
        )
        async with db.connection() as conn:
            profile = await public_profile(conn, user["id"])
        return {"user": profile}

    @app.post("/api/auth/email-verification/request", tags=["legacy-web-identity"])
    async def verification_request(request: Request):
        who, _, _ = await web_identity(request, db)
        await budget(request, "verify-email-send", who.id, maximum=5)
        result = await service.request_verification(who)
        # A durable accepted request is not an assertion of delivery. Old clients
        # display this actual status text instead of a false "already sent".
        if result["verified"]:
            return result
        return {"ok": True, "message": "验证邮件已进入发送队列。", "deliveryStatus": "queued"}

    @app.post("/api/auth/email-verification/confirm", tags=["legacy-web-identity"])
    async def verification_confirm(request: Request):
        trusted_origin(request)
        await budget(request, "verify-email-confirm", maximum=20)
        raw = await body(request, ("token",), 8192)
        await service.confirm_verification(text(raw, "token", maximum=128))
        return {"ok": True}

    async def native_member(request, write=False):
        native_version(request)
        assert_native_origin(request, settings)
        who, grant = await native_identity(request, db, "security.write" if write else "security.read")
        who.email_scope = grant["scope"]
        return who

    @app.get("/api/v{version}/auth/email-verification", tags=["legacy-native-identity"])
    async def native_verification_status(version: int, request: Request, response: Response):
        who = await native_member(request)
        return envelope(await service.verification_status(who), request, response)

    @app.post("/api/v{version}/auth/email-verification/{action}", tags=["legacy-native-identity"])
    async def native_verification_action(version: int, action: str, request: Request, response: Response):
        if action not in ("request", "confirm"):
            raise LegacyError(404, 40401, "接口不存在")
        who = await native_member(request, True)
        await budget(request, "verify-email-" + action, who.id, maximum=5 if action == "request" else 20)
        raw = await body(request, () if action == "request" else ("token",))
        try:
            if action == "request":
                result = await service.request_verification(who)
                if not result.get("verified"):
                    result = {**result, "deliveryStatus": "queued", "message": "验证邮件已进入发送队列。"}
            else:
                await service.confirm_verification(text(raw, "token", maximum=128), who)
                async with db.connection() as conn:
                    profile = await public_profile(conn, who.id, scope=who.email_scope, settings=settings)
                result = {"ok": True, "verified": True, "user": profile}
        except HTTPException as exc:
            if exc.status_code == 503:
                raise LegacyError(503, 50301, str(exc.detail)) from None
            if exc.status_code == 400 and action == "confirm":
                raise LegacyError(400, 40003, str(exc.detail)) from None
            raise
        return envelope(result, request, response)

    from .native_security_aliases import mount_security_alias

    mount_security_alias(app, "/email-verification", ["GET"], native_verification_status)
    mount_security_alias(
        app, "/email-verification/{action}", ["POST"], native_verification_action, action=True
    )
