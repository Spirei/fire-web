"""Explicit owner migration commands, original UUID lookup remains the 54 receipt API."""

import json
from uuid import UUID

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .profile_http import bounded_body
from .resource_import import object_pairs
from .security import identity
from .system_asset_api import content
from .watch_group_source_icons import WatchGroupSourceIcons


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Capture(Strict):
    requestId: str = Field(pattern='^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    originalGroupId: str = Field(pattern='^[A-Za-z0-9_-]{1,100}$')


class Preview(Strict):
    replaceCurrent: bool = False


class Apply(Strict):
    requestId: str = Field(pattern='^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
    preview: str = Field(pattern='^[a-f0-9]{64}$')
    expectedRevision: int = Field(ge=0, le=9007199254740991)
    replaceCurrent: bool = False


def mount_watch_group_source_icons(app, settings):
    service = WatchGroupSourceIcons(app.state.db, app.state.source_authority)
    app.state.watch_group_source_icons = service

    async def member(request, model=None):
        if request.query_params:
            raise HTTPException(400, '查询字段无效')
        if 'authorization' in request.headers:
            raise HTTPException(403, '请使用当前网页登录会话')
        who = await identity(request)
        if model is None:
            return who
        if request.headers.get('content-type', '').split(';')[0].lower() != 'application/json':
            raise HTTPException(415, '请提交JSON请求')
        try:
            def constant(_):
                raise ValueError()
            value = model.model_validate(json.loads(await bounded_body(request, 4096), object_pairs_hook=object_pairs, parse_constant=constant)).model_dump()
        except (ValueError, UnicodeError, ValidationError):
            raise HTTPException(422, '请求字段无效') from None
        return who, value

    def response(value):
        return JSONResponse(value, headers={'Cache-Control': 'private, no-store'})

    @app.post('/api/watch-group-import/manifests/{manifest_id}/icons/captures')
    async def capture(manifest_id: UUID, request: Request):
        who, command = await member(request, Capture)
        return response(await service.capture(who, manifest_id, command))

    @app.post('/api/watch-group-import/operations/{capture_id}/icon-preview')
    async def preview(capture_id: UUID, request: Request):
        who, command = await member(request, Preview)
        return response(await service.preview(who, capture_id, command['replaceCurrent']))

    @app.post('/api/watch-group-import/operations/{capture_id}/icon-operations')
    async def apply(capture_id: UUID, request: Request):
        who, command = await member(request, Apply)
        return response(await service.apply(who, capture_id, command))

    @app.get('/api/watch-group-import/operations/{capture_id}/icon-original')
    async def original(capture_id: UUID, request: Request):
        row, stream = await service.original(await member(request), capture_id)
        return content(request, {**row, 'media_type': 'application/octet-stream'}, stream, private=True)
