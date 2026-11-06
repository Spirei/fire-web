"""Root API and native thin adapters over the same mail template authority."""

import re
from copy import deepcopy
from uuid import UUID

from fastapi import HTTPException, Request, Response

from .legacy_identity import LegacyError, assert_native_origin, envelope
from .mail_templates import MailTemplates
from .mail_template_model import COMMON, DEFAULTS, PRICE
from .native_app_auth import authenticate
from .profile_http import bounded_body
from .security import identity


def mount_mail_templates(app, db):
    service = MailTemplates(db)
    app.state.mail_templates = service

    async def admin(request):
        if "authorization" in request.headers:
            raise HTTPException(403, "请使用当前网页管理员会话")
        who = await identity(request)
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        return who

    async def discovery(request):
        assert_native_origin(request, db.settings)
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        value = await service.read()
        return {
            "version": 1,
            "style": "alcor-brand-v1",
            "banner_path": "/api/system-assets/mail-banner",
            "templates": value["templates"],
        }

    @app.get("/api/auth/mail-templates", tags=["identity"])
    async def canonical(request: Request, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return await discovery(request)

    @app.get("/api/v{version}/auth/mail-templates", tags=["legacy-native"])
    async def legacy(version: int, request: Request, response: Response):
        if version not in (1, 2):
            raise HTTPException(404, "接口版本不存在")
        response.headers["Cache-Control"] = "no-store"
        # Public v2 discovery still rejects a supplied invalid App credential.
        if version == 2 and "authorization" in request.headers:
            assert_native_origin(request, db.settings)
            matched = re.fullmatch(r"Bearer (fat_[A-Za-z0-9_-]{43})", request.headers["authorization"])
            if not matched:
                raise LegacyError(401, 40101, "需要有效的 App 连接")
            async with db.connection() as conn:
                try:
                    await authenticate(conn, matched[1])
                except HTTPException as error:
                    raise LegacyError(error.status_code, 40102, str(error.detail)) from None
        return envelope(await discovery(request), request, response)

    @app.get("/api/system/mail-templates", tags=["admin"])
    async def read(request: Request, response: Response):
        response.headers["Cache-Control"] = "private, no-store"
        value = await service.read(await admin(request))
        # Editor metadata comes from the same model as validation and rendering.
        # Reading presets never replaces the administrator's saved templates.
        return {
            **value,
            "defaults": deepcopy(DEFAULTS),
            "variables": {
                item["id"]: sorted(COMMON | (PRICE if item["id"] == "price_alert" else set()))
                for item in DEFAULTS
            },
        }

    @app.post("/api/system/mail-templates/operations", tags=["admin"])
    async def save(request: Request, response: Response):
        who = await admin(request)
        await bounded_body(request, 32768)
        try:
            data = await request.json()
        except ValueError:
            raise HTTPException(400, "请求格式无效") from None
        response.headers["Cache-Control"] = "private, no-store"
        return await service.save(who, data)

    @app.get("/api/system/mail-templates/operations/{rid}", tags=["admin"])
    async def receipt(rid: UUID, request: Request, response: Response):
        response.headers["Cache-Control"] = "private, no-store"
        return await service.receipt(await admin(request), rid)

    @app.post("/api/system/mail-templates/operations/{rid}/close", tags=["admin"])
    async def close(rid: UUID, request: Request, response: Response):
        who = await admin(request)
        await bounded_body(request, 128)
        if request.query_params or (await request.body()).strip() not in (b"", b"{}"):
            raise HTTPException(400, "关闭请求不能携带模板内容")
        response.headers["Cache-Control"] = "private, no-store"
        return await service.close(who, rid)
