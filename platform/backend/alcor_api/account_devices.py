"""Canonical owner device management, reusing the existing revocation authority."""

from fastapi import HTTPException, Request

from .legacy_identity import body
from .legacy_passkeys import text
from .security import digest, identity


def mount_account_devices(app, db, rate_limit):
    service = app.state.identity_devices

    async def member(request):
        if "authorization" in request.headers:
            raise HTTPException(403, "请使用当前网页登录会话")
        return await identity(request)

    @app.get("/api/account/devices", tags=["account"])
    async def devices(request: Request):
        who = await member(request)
        result = await service.list(who)
        async with db.connection() as conn:
            factor = await (
                await conn.execute("SELECT totp_enabled FROM identity_security WHERE user_id=%s", (who.id,))
            ).fetchone()
        return {**result, "twoFactorEnabled": bool(factor and factor["totp_enabled"])}

    @app.delete("/api/account/devices", tags=["account"])
    async def revoke_device(request: Request):
        who = await member(request)
        if not await rate_limit(db, digest("device-remove:" + who.id), 20):
            raise HTTPException(429, "尝试过于频繁")
        data = await body(request, ("id", "currentPassword", "code"))
        return await service.remove(
            who,
            text(data, "id", minimum=1, maximum=1024),
            text(data, "currentPassword"),
            text(data, "code", maximum=64),
            request.state.request_id,
        )
