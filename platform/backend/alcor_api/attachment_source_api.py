"""Same-origin admin-only global attachment import; no HTTP source locator."""

import json
from typing import Literal
from uuid import UUID

from fastapi import HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from .attachment_source_import import AttachmentSourceImport
from .attachment_source_registry import unique
from .security import digest, identity
from .system_asset_api import content


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Capture(Strict):
    requestId: str = Field(pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
    sourceAlias: str = Field(min_length=3, max_length=64)


class Preview(Strict):
    maxItems: int = Field(default=32, ge=1, le=32)
    retryBlocked: bool = False


class Segment(Preview):
    requestId: str = Field(pattern=r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
    expectedRevision: int = Field(ge=1, le=9007199254740991)
    manifestRevision: int = Field(ge=1, le=9007199254740991)
    preview: str = Field(pattern=r"^[a-f0-9]{64}$")


class Close(Strict):
    expectedKind: Literal["capture", "segment"]


def mount_attachment_source_import(app, db):
    service = AttachmentSourceImport(db)
    app.state.attachment_source_import = service

    async def admin(request, response, query=()):
        if "authorization" in request.headers:
            raise HTTPException(403, "请使用当前管理员网页会话")
        if set(request.query_params) - set(query) or any(
            len(request.query_params.getlist(k)) != 1 for k in request.query_params
        ):
            raise HTTPException(400, "查询字段无效")
        who = await identity(request)
        if who.role != "admin":
            raise HTTPException(403, "需要管理员权限")
        from .main import rate_limit

        if not await rate_limit(db, digest("admin-attachments:" + who.id), 180, window_seconds=60):
            raise HTTPException(429, "请求过于频繁")
        if request.method not in ("GET", "HEAD"):
            try:
                json.loads(await request.body(), object_pairs_hook=unique)
            except (ValueError, UnicodeError):
                raise HTTPException(422, "JSON字段重复或结构无效") from None
        response.headers["Cache-Control"] = "private, no-store"
        return who

    @app.get("/api/admin/attachment-import/sources")
    async def sources(request: Request, response: Response):
        return await service.options(await admin(request, response))

    @app.get("/api/admin/attachment-import/snapshots")
    async def listing(
        request: Request,
        response: Response,
        after: UUID | None = None,
        limit: int = Query(default=25, ge=1, le=50),
    ):
        return await service.listing(await admin(request, response, ("after", "limit")), after, limit)

    @app.get("/api/admin/attachment-import/snapshots/{identifier}/items/{ordinal}/original")
    async def original(identifier: UUID, ordinal: int, request: Request, response: Response):
        row, stream = await service.original(await admin(request, response), identifier, ordinal)
        media = {
            "original_size": row["byte_length"],
            "served_size": row["byte_length"],
            "original_sha256": row["sha256"],
            "served_sha256": row["sha256"],
            "media_type": "application/octet-stream",
        }
        return content(request, media, stream, private=True)

    @app.post("/api/admin/attachment-import/snapshots")
    async def capture(data: Capture, request: Request, response: Response):
        result = await service.capture(await admin(request, response), data.model_dump())
        response.status_code = result["httpStatus"]
        return result

    @app.get("/api/admin/attachment-import/snapshots/{identifier}")
    async def manifest(
        identifier: UUID,
        request: Request,
        response: Response,
        after: int = Query(default=-1, ge=-1),
        limit: int = Query(default=50, ge=1, le=100),
    ):
        return await service.read(
            await admin(request, response, ("after", "limit")), identifier, after, limit
        )

    @app.post("/api/admin/attachment-import/snapshots/{identifier}/preview")
    async def preview(identifier: UUID, data: Preview, request: Request, response: Response):
        return await service.preview(await admin(request, response), identifier, data.model_dump())

    @app.post("/api/admin/attachment-import/snapshots/{identifier}/segments")
    async def segment(identifier: UUID, data: Segment, request: Request, response: Response):
        result = await service.segment(await admin(request, response), identifier, data.model_dump())
        response.status_code = result["httpStatus"]
        return result

    @app.post("/api/admin/attachment-import/operations/{identifier}/close")
    async def close(identifier: UUID, data: Close, request: Request, response: Response):
        return await service.close(await admin(request, response), identifier, data.expectedKind)

    @app.get("/api/admin/attachment-import/operations/{identifier}")
    async def receipt(identifier: UUID, request: Request, response: Response):
        return await service.attachments.receipt(await admin(request, response), identifier)
