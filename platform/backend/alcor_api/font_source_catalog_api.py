"""Current-admin metadata catalog; only registered aliases and exact archived ordinals."""

import json
from uuid import UUID

from fastapi import HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .font_source_catalog import FontSourceCatalog
from .legacy_identity import assert_native_origin
from .profile_http import bounded_body
from .resource_api import no_duplicate_object
from .security import digest, identity


class Capture(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: UUID
    sourceAlias: str = Field(min_length=3, max_length=64, pattern="^[a-z0-9][a-z0-9_-]+$")
    maxEntries: int = Field(default=1000, ge=1, le=5000, strict=True)


class Registration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: UUID
    grantId: UUID
    grantRevision: int = Field(ge=1, strict=True)
    evidenceRef: str = Field(min_length=1, max_length=128, pattern=r"^[^\x00-\x1f\x7f]+$")


def mount_font_source_catalog(app, settings, db, rate_limit):
    service = FontSourceCatalog(db, app.state.font_source_import)
    app.state.font_source_catalog = service

    async def member(request, allowed=()):
        if set(request.query_params) - set(allowed) or any(
            len(request.query_params.getlist(k)) != 1 for k in request.query_params
        ):
            raise HTTPException(400, "查询字段无效")
        if "authorization" in request.headers:
            raise HTTPException(403, "请使用当前管理员网页会话")
        assert_native_origin(request, settings)
        who = await identity(request)
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        if request.method == "POST" and not await rate_limit(
            db, digest("font-source-catalog:" + who.id), 60, window_seconds=3600
        ):
            raise HTTPException(429, "目录清单操作过于频繁")
        return who

    async def body(request, model):
        try:
            return model.model_validate(
                json.loads(await bounded_body(request, 8192), object_pairs_hook=no_duplicate_object)
            ).model_dump(mode="json")
        except (ValueError, TypeError, ValidationError):
            raise HTTPException(422, "目录清单字段无效") from None

    def result(value, operation=False):
        return JSONResponse(
            value,
            status_code=value.get("httpStatus", 200) if operation else 200,
            headers={"Cache-Control": "private, no-store"},
        )

    @app.get("/api/personal-font-import/catalog-sources", tags=["personal-font-import"])
    async def sources(request: Request):
        return result(await service.options(await member(request)))

    @app.get("/api/personal-font-import/catalogs", tags=["personal-font-import"])
    async def history(request: Request, after: UUID | None = None):
        return result(await service.history(await member(request, ("after",)), after))

    @app.post("/api/personal-font-import/catalogs", tags=["personal-font-import"])
    async def capture(request: Request):
        who = await member(request)
        async with app.state.resource_library.upload_slot():
            return result(await service.capture(who, await body(request, Capture)), True)

    @app.get("/api/personal-font-import/catalogs/{identifier}", tags=["personal-font-import"])
    async def page(
        identifier: UUID,
        request: Request,
        after: int = Query(default=-1, ge=-1, le=5000),
        limit: int = Query(default=32, ge=1, le=32),
    ):
        return result(await service.page(await member(request, ("after", "limit")), identifier, after, limit))

    @app.post(
        "/api/personal-font-import/catalogs/{identifier}/entries/{ordinal}/registrations",
        tags=["personal-font-import"],
    )
    async def registration(identifier: UUID, ordinal: int, request: Request):
        who = await member(request)
        if not 0 <= ordinal < 5000:
            raise HTTPException(422, "目录项编号无效")
        return result(await service.register(who, identifier, ordinal, await body(request, Registration)))

    @app.get("/api/personal-font-import/catalog-operations/{identifier}", tags=["personal-font-import"])
    async def operation(identifier: UUID, request: Request):
        return result(await service.operation(await member(request), identifier))

    @app.post(
        "/api/personal-font-import/catalog-operations/{identifier}/close", tags=["personal-font-import"]
    )
    async def close(identifier: UUID, request: Request):
        who = await member(request)
        try:
            data = json.loads(await bounded_body(request, 256), object_pairs_hook=no_duplicate_object)
            if data != {"expectedKind": "catalog"}:
                raise ValueError()
        except (ValueError, TypeError):
            raise HTTPException(422, "目录操作关闭字段无效") from None
        return result(await service.close(who, identifier))
