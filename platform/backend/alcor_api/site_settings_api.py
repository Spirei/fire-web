"""Public legacy brand projections and explicit, versioned administrator commands."""

import json
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import Field, SecretStr

from .identity_mail import IdentityMail
from .legacy_identity import assert_native_origin, native_identity
from .models import InputModel
from .profile_http import bounded_body
from .resource_api import no_duplicate_object
from .security import Identity, administrator
from .site_settings import ASSETS, SiteSettings

Admin = Annotated[Identity, Depends(administrator)]
V1_KEYS = (
    "title",
    "ico",
    "homepageBg",
    "domain",
    "siteLogo",
    "logoText",
    "logoFont",
    "footerDesc",
    "homeNav",
    "allowRegister",
)


class SaveSiteSettings(InputModel):
    requestId: UUID
    expectedRevision: int = Field(ge=0, le=9007199254740991, strict=True)
    patch: dict
    password: SecretStr = Field(min_length=1, max_length=128)
    code: SecretStr = Field(default=SecretStr(""), max_length=64)


class CloseSiteSettings(InputModel):
    expectedKind: str = Field(pattern="^site-settings$")


class SiteSettingsRoute(APIRoute):
    def get_route_handler(self):
        native = super().get_route_handler()

        async def handle(request):
            if request.method in {"PUT", "POST"}:

                def invalid_constant(_value):
                    raise ValueError()

                try:
                    value = json.loads(
                        await bounded_body(request, 65536),
                        object_pairs_hook=no_duplicate_object,
                        parse_constant=invalid_constant,
                    )
                    if not isinstance(value, dict):
                        raise TypeError()
                except (ValueError, TypeError, UnicodeError):
                    raise HTTPException(422, "站点配置请求格式无效") from None
            return await native(request)

        return handle


def mount_site_settings(app, settings, db):
    service = SiteSettings(db, IdentityMail(settings, db, dynamic=True))
    app.state.site_settings = service

    @app.get("/api/settings/public", tags=["legacy-public-site"])
    async def public_web():
        return JSONResponse(
            {"settings": await service.public()},
            headers={"Cache-Control": "no-store", "X-Alcor-Source-Coverage": "platform-only"},
        )

    @app.get("/api/v1/settings/public", tags=["legacy-public-site"])
    async def public_v1():
        value = await service.public()
        return JSONResponse(
            {"code": 0, "message": "ok", "data": {key: value[key] for key in V1_KEYS}},
            headers={"Cache-Control": "no-store", "X-Alcor-Source-Coverage": "platform-only"},
        )

    @app.get("/api/v2/settings/public", tags=["legacy-public-site"])
    async def public_v2(request: Request):
        try:
            assert_native_origin(request, settings)
            if "authorization" in request.headers:
                authorization = request.headers["authorization"]
                if not authorization.startswith("Bearer "):
                    raise HTTPException(401, "需要有效的 App 连接")
                await native_identity(request, db)
        except HTTPException as error:
            code = 40102 if error.detail == "连接已失效，请重新连接" else error.status_code * 100 + 1
            return JSONResponse(
                {"code": code, "message": str(error.detail)},
                status_code=error.status_code,
                headers={"Cache-Control": "no-store"},
            )
        value = await service.public()
        return JSONResponse(
            {"code": 0, "message": "ok", "data": {key: value[key] for key in V1_KEYS}},
            headers={
                "Cache-Control": "no-store",
                "X-Alcor-API-Version": "2",
                "X-Alcor-Source-Coverage": "platform-only",
            },
        )

    router = APIRouter(
        prefix="/api/admin/site-settings", tags=["site-settings"], route_class=SiteSettingsRoute
    )

    @router.get("")
    async def read(who: Admin):
        return await service.read(who)

    @router.put("")
    async def save(data: SaveSiteSettings, request: Request, who: Admin):
        return await service.save(
            who,
            data.requestId,
            data.expectedRevision,
            data.patch,
            data.password.get_secret_value(),
            data.code.get_secret_value(),
            request.app.state.native_passkeys,
        )

    @router.get("/assets")
    async def assets(who: Admin):
        async with db.connection() as conn, conn.transaction():
            await service.authorize(conn, who)
            current = await (await conn.execute("SELECT settings FROM site_settings WHERE singleton")).fetchone()
            if not current:
                raise HTTPException(503, "站点配置缺失")
            try:
                selected = [UUID(current["settings"][key]) for key in ASSETS if current["settings"].get(key)]
            except (ValueError, TypeError, AttributeError):
                raise HTTPException(503, "站点图片登记版本无效") from None
            rows = await (
                await conn.execute(
                    "SELECT id,kind,public_path,served_sha256 FROM system_asset_versions WHERE kind IN ('ico','background','login','logo') ORDER BY (id=ANY(%s::uuid[])) DESC,created_at DESC,id LIMIT 200",
                    (selected,),
                )
            ).fetchall()
            return {"items": rows, "limit": 200}

    @router.get("/operations/{request_id}")
    async def receipt(request_id: UUID, who: Admin):
        return await service.receipt(who, request_id)

    @router.post("/operations/{request_id}/close")
    async def close(request_id: UUID, data: CloseSiteSettings, who: Admin):
        return await service.close(who, request_id)

    app.include_router(router)
    from .legacy_site_settings import mount_legacy_site_settings

    mount_legacy_site_settings(app, settings, db, service)
    return service
