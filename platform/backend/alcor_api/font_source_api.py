"""Cookie-only explicit font migration evidence; no browser filesystem locator."""

import json
from typing import Literal
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .font_source_import import FontSourceImport
from .legacy_identity import assert_native_origin
from .profile_http import bounded_body
from .resource_api import no_duplicate_object
from .security import digest, identity
from .system_asset_api import content


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: UUID


class Register(Command):
    grantId: UUID
    grantRevision: int = Field(ge=1, strict=True)
    originalId: str = Field(max_length=160, pattern=r"^custom-[1-9][0-9]*-[a-f0-9]{64}\.(woff2?|ttf|otf)$")
    evidenceRef: str = Field(min_length=1, max_length=200, pattern=r"^[^\x00-\x1f\x7f]+$")


class Consent(Command):
    revision: int = Field(ge=1, strict=True)
    approve: bool = Field(strict=True)
    acknowledgeUnverifiedUploader: bool = Field(strict=True)
    name: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=1, max_length=1024)
    code: str = Field(max_length=32)


class Capture(Command):
    permissionId: UUID
    permissionRevision: int = Field(ge=1, strict=True)


class Preview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    captureId: UUID


class Apply(Command):
    captureId: UUID
    permissionRevision: int = Field(ge=1, strict=True)
    expectedRevision: int = Field(ge=0, le=9007199254740991, strict=True)
    preview: str = Field(pattern="^[a-f0-9]{64}$")


class Close(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expectedKind: Literal["register", "consent", "capture", "apply"]


def mount_font_source_import(app, settings, db, rate_limit):
    service = FontSourceImport(db, app.state.source_authority)
    app.state.font_source_import = service

    async def member(request, write=False):
        if request.query_params:
            raise HTTPException(400, "查询字段无效")
        if "authorization" in request.headers:
            raise HTTPException(403, "请使用当前本人网页会话")
        assert_native_origin(request, settings)
        who = await identity(request)
        if write:
            if not await rate_limit(db, digest("font-source:" + who.id), 120, window_seconds=3600):
                raise HTTPException(429, "字体迁移操作过于频繁")
            if not await rate_limit(db, "font-source-global", 1200, window_seconds=3600):
                raise HTTPException(429, "字体迁移操作过于频繁")
        return who

    async def body(request, model):
        try:
            raw = await bounded_body(request, 8192)
            return model.model_validate(json.loads(raw, object_pairs_hook=no_duplicate_object)).model_dump(
                mode="json"
            )
        except (ValueError, TypeError, ValidationError):
            raise HTTPException(422, "字体迁移字段无效") from None

    def result(value):
        return JSONResponse(
            value, status_code=value.get("httpStatus", 200), headers={"Cache-Control": "private, no-store"}
        )

    @app.get("/api/personal-font-import/registration-options", tags=["personal-font-import"])
    async def options(request: Request):
        return result(await service.options(await member(request)))

    @app.get("/api/personal-font-import/permissions", tags=["personal-font-import"])
    async def listing(request: Request):
        return result(await service.listing(await member(request)))

    @app.post("/api/personal-font-import/permissions", tags=["personal-font-import"])
    async def register(request: Request):
        who = await member(request, True)
        return result(await service.register(who, await body(request, Register)))

    @app.post("/api/personal-font-import/permissions/{identifier}/consent", tags=["personal-font-import"])
    async def consent(identifier: UUID, request: Request):
        who = await member(request, True)
        if not await rate_limit(db, digest("identity-manage:" + who.id), 20):
            raise HTTPException(429, "身份确认过于频繁")
        return result(await service.consent(who, identifier, await body(request, Consent)))

    @app.post("/api/personal-font-import/captures", tags=["personal-font-import"])
    async def capture(request: Request):
        who = await member(request, True)
        async with app.state.resource_library.upload_slot():
            return result(await service.capture(who, await body(request, Capture)))

    @app.post("/api/personal-font-import/preview", tags=["personal-font-import"])
    async def preview(request: Request):
        who = await member(request)
        return result(await service.preview(who, (await body(request, Preview))["captureId"]))

    @app.post("/api/personal-font-import/operations", tags=["personal-font-import"])
    async def apply(request: Request):
        who = await member(request, True)
        return result(await service.apply(who, await body(request, Apply)))

    @app.get("/api/personal-font-import/operations/{identifier}", tags=["personal-font-import"])
    async def operation(identifier: UUID, request: Request):
        value = await service.operation(await member(request), identifier)
        return JSONResponse(value, headers={"Cache-Control": "private, no-store"})

    @app.post("/api/personal-font-import/operations/{identifier}/close", tags=["personal-font-import"])
    async def close(identifier: UUID, request: Request):
        who = await member(request, True)
        value = await service.close(who, identifier, (await body(request, Close))["expectedKind"])
        return JSONResponse(value, headers={"Cache-Control": "private, no-store"})

    @app.get("/api/personal-font-import/captures/{identifier}/original", tags=["personal-font-import"])
    async def original(identifier: UUID, request: Request):
        row, stream = await service.original(await member(request), identifier)
        row = {
            **row,
            "original_size": row["byte_length"],
            "served_size": row["byte_length"],
            "original_sha256": row["sha256"],
            "served_sha256": row["sha256"],
        }
        response = content(request, row, stream, private=True)
        response.headers["Cache-Control"] = "private, no-store"
        return response
