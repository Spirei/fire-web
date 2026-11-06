"""Canonical unversioned watch-group preference API; legacy adapters are separate."""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from .legacy_identity import OLD_COOKIE, WEB_COOKIE, assert_native_origin, native_identity, web_identity
from .security import COOKIE, Identity, identity
from .watch_group_source_display import WatchGroupSourceDisplay
from .watchlists import WatchGroups


class GroupMutation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: UUID
    expectedRevision: int = Field(ge=0, strict=True)
    action: Literal["initialize", "create", "update", "delete", "reorder", "assign", "reorder-records"]
    data: dict


def mount_watchlists(app, db):
    service = WatchGroups(db)
    app.state.watch_groups = service

    async def member(request, write=False):
        assert_native_origin(request, db.settings)
        if "authorization" in request.headers:
            from .legacy_optional_credentials import credentials_present

            credentials_present(request)
        if request.headers.get("authorization") is not None:
            who,grant=await native_identity(request,db,"portfolio.write" if write else "portfolio.read")
            from fastapi import HTTPException

            from .native_app_auth import CLIENT
            if grant['client_id']!=CLIENT:
                raise HTTPException(401,'连接已失效')
            return who
        if COOKIE in request.cookies:
            return await identity(request)
        if request.cookies.get(WEB_COOKIE) or request.cookies.get(OLD_COOKIE):
            return (await web_identity(request, db))[0]
        return await identity(request)

    async def read_member(request: Request):
        return await member(request)

    async def write_member(request: Request):
        return await member(request, True)

    @app.get("/api/watch-groups", tags=["watchlists"])
    async def groups(who: Annotated[Identity, Depends(read_member)]):
        return JSONResponse(await service.list(who.id, authorization=who),headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'})

    @app.get("/api/watch-groups/{group_id}/source-display", tags=["watchlists"])
    async def source_display(group_id: str, who: Annotated[Identity, Depends(read_member)]):
        return JSONResponse(await WatchGroupSourceDisplay(db).read(who, group_id), headers={"Cache-Control": "private, no-store"})

    @app.post("/api/watch-groups/operations", tags=["watchlists"])
    async def mutate(data: GroupMutation, who: Annotated[Identity, Depends(write_member)]):
        return JSONResponse(await service.mutate(who.id, data.action, data.data, data.requestId, data.expectedRevision, authorization=who),headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'})

    @app.get("/api/watch-groups/operations/{request_id}", tags=["watchlists"])
    async def receipt(request_id: UUID, who: Annotated[Identity, Depends(read_member)]):
        return JSONResponse(await service.receipt(who.id, request_id, authorization=who),headers={'Cache-Control':'no-store, private','Vary':'Cookie, Authorization'})
