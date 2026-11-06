"""Same-origin new-Web migration operations; no added v1/v2/native capability."""

import json
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.requests import ClientDisconnect

from .profile_http import bounded_body
from .resource_import import ResourceImport, object_pairs
from .resource_import_registry import load_resources
from .security import digest, identity


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Register(Strict):
    requestId: str = Field(pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
    sourceAlias: str = Field(min_length=1, max_length=64)
    sourceOwner: str = Field(min_length=1, max_length=200)
    targetUserId: str = Field(min_length=1, max_length=200)


class Approve(Strict):
    requestId: str
    revision: int = Field(ge=1, le=9007199254740991)
    password: str = Field(min_length=1, max_length=1024)
    code: str = Field(max_length=32)
    approve: bool


class Capture(Strict):
    requestId: str
    revision: int = Field(ge=1, le=9007199254740991)


class Preview(Strict):
    revision: int = Field(ge=1, le=9007199254740991)


class Close(Strict):
    expectedKind: str = Field(pattern="^capture$")


class Segment(Capture):
    preview: str = Field(pattern=r"^[a-f0-9]{64}$")
    maxItems: int = Field(ge=1, le=32)
    retryBlocked: bool = False


def mount_resource_import(app, settings):
    from .main import rate_limit

    authority = app.state.source_authority
    service = ResourceImport(
        app.state.db, authority, load_resources(settings, authority.registry), app.state.native_passkeys
    )
    app.state.resource_import = service

    async def member(request, model=None, allowed_query=()):
        if "authorization" in request.headers:
            raise HTTPException(403, "请使用当前网页登录会话")
        if set(request.query_params) - set(allowed_query) or any(
            len(request.query_params.getlist(k)) != 1 for k in request.query_params
        ):
            raise HTTPException(400, "查询字段无效")
        who = await identity(request)
        if not await rate_limit(app.state.db, digest("resources:" + who.id), 180, window_seconds=60):
            raise HTTPException(429, "请求过于频繁")
        if model is None:
            return who
        if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            raise HTTPException(415, "请提交JSON请求")
        try:
            raw = json.loads(
                await bounded_body(request, 8192),
                object_pairs_hook=object_pairs,
                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()),
            )
            return who, model.model_validate(raw).model_dump()
        except ClientDisconnect:
            raise HTTPException(499, "请求已断开，请查询原操作UUID") from None
        except (ValueError, UnicodeError, ValidationError):
            raise HTTPException(422, "请求字段无效") from None

    def response(value):
        return JSONResponse(value, headers={"Cache-Control": "no-store, private"})

    @app.get("/api/resource-import/authorizations")
    async def grants(request: Request):
        return response(await service.grants(await member(request)))

    @app.post("/api/resource-import/authorizations")
    async def register(request: Request):
        who, data = await member(request, Register)
        return response(await service.register(who, data))

    @app.post("/api/resource-import/authorizations/{identifier}/consent")
    async def approve(identifier: UUID, request: Request):
        who, data = await member(request, Approve)
        if not await rate_limit(app.state.db, digest("identity-manage:" + who.id), 20):
            raise HTTPException(429, "操作过于频繁")
        return response(await service.approve(who, identifier, data))

    @app.post("/api/resource-import/authorizations/{identifier}/snapshots")
    async def snapshot(identifier: UUID, request: Request):
        who, data = await member(request, Capture)
        if not await rate_limit(
            app.state.db, digest("resource-source-capture:" + who.id), 12, window_seconds=3600
        ):
            raise HTTPException(429, "来源捕获过于频繁")
        return response(await service.snapshot(who, identifier, data))

    @app.get("/api/resource-import/operations/{identifier}")
    async def receipt(identifier: UUID, request: Request):
        return response(await service.receipt(await member(request), identifier))

    @app.post("/api/resource-import/operations/{identifier}/close")
    async def close(identifier: UUID, request: Request):
        who, _ = await member(request, Close)
        return response(await service.close_capture(who, str(identifier)))

    @app.get("/api/resource-import/manifests/{identifier}")
    async def manifest(identifier: UUID, request: Request):
        who = await member(request, allowed_query=("after",))
        after = request.query_params.get("after", "0")
        if not re_decimal(after):
            raise HTTPException(400, "分页位置无效")
        return response(await service.read_manifest(who, identifier, int(after)))

    @app.get("/api/resource-import/manifests/{identifier}/records/{sequence}")
    async def original(identifier: UUID, sequence: int, request: Request):
        return response(await service.raw(await member(request), identifier, sequence))

    @app.post("/api/resource-import/manifests/{identifier}/preview")
    async def preview(identifier: UUID, request: Request):
        who, data = await member(request, Preview)
        return response(await service.preview(who, identifier, data["revision"]))

    @app.post("/api/resource-import/manifests/{identifier}/segments")
    async def segment(identifier: UUID, request: Request):
        who, data = await member(request, Segment)
        return response(await service.segment(who, identifier, data))


def re_decimal(value):
    return (
        isinstance(value, str)
        and value.isascii()
        and value.isdecimal()
        and len(value) <= 6
        and int(value) <= 200000
    )
