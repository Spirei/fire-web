"""Legacy Web and native device protocols sharing an owner-scoped service."""

from fastapi import HTTPException, Request, Response

from .identity_devices import IdentityDevices
from .legacy_identity import (
    LegacyError,
    assert_native_origin,
    body,
    envelope,
    native_identity,
    native_version,
    web_identity,
)
from .legacy_passkeys import text
from .security import digest


def mount_legacy_devices(app, settings, db, rate_limit):
    service = IdentityDevices(db, app.state.native_passkeys)
    app.state.identity_devices = service

    async def web_member(request):
        if "authorization" in request.headers:
            raise LegacyError(401, 40101, "请在 Alcor 网页登录")
        return (await web_identity(request, db))[0]

    @app.get("/api/v1/auth/devices", tags=["legacy-web-security"])
    async def web_list(request: Request, response: Response):
        who = await web_member(request)
        return envelope(await service.list(who, apps_only=True), request, response)

    @app.delete("/api/v1/auth/devices", tags=["legacy-web-security"])
    async def web_remove(request: Request, response: Response):
        who = await web_member(request)
        if not await rate_limit(db, digest("app-device:" + who.id), 30, window_seconds=60):
            raise LegacyError(429, 42901, "请求过于频繁")
        data = await body(request, ("id",), 8192)
        identifier = text(data, "id", minimum=1, maximum=1024)
        await service.remove(who, identifier, "", "", request.state.request_id, apps_only=True)
        return envelope({"revoked": True}, request, response)

    @app.get("/api/v{version}/auth/security-devices", tags=["legacy-native-security"])
    async def native_list(version: int, request: Request, response: Response):
        native_version(request)
        assert_native_origin(request, settings)
        who, _ = await native_identity(request, db, "security.read")
        return envelope(await service.list(who), request, response)

    @app.delete("/api/v{version}/auth/security-devices", tags=["legacy-native-security"])
    async def native_remove(version: int, request: Request, response: Response):
        native_version(request)
        assert_native_origin(request, settings)
        who, _ = await native_identity(request, db, "security.write")
        address = request.client.host if request.client else "unknown"
        for key, maximum in (
            (digest("device-remove:" + who.id), 20),
            (digest("native-security-ip:" + address), 100),
            ("native-security-global", 500),
        ):
            if not await rate_limit(db, key, maximum):
                raise LegacyError(429, 42901, "尝试过于频繁")
        data = await body(request, ("id", "currentPassword", "code"))
        identifier = text(data, "id", minimum=1, maximum=1024)
        password = text(data, "currentPassword")
        code = text(data, "code", maximum=1024)
        try:
            result = await service.remove(who, identifier, password, code, request.state.request_id)
        except HTTPException as exc:
            if exc.status_code == 403 and exc.detail == "当前密码不正确":
                raise LegacyError(403, 40103, str(exc.detail)) from None
            if exc.status_code == 403 and exc.detail == "二次验证码或备用码不正确":
                raise LegacyError(403, 40104, "二次验证失败") from None
            raise
        return envelope(result, request, response)

    from .native_security_aliases import mount_security_alias

    mount_security_alias(app, "/security-devices", ["GET"], native_list)
    mount_security_alias(app, "/security-devices", ["DELETE"], native_remove)
