"""Canonical confirmed-fill recording; no legacy compatibility is implied."""

from typing import Annotated
from uuid import UUID

from fastapi import Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from .security import Identity, identity
from .dividend_trading import DividendAwareTrading as Trading

Member = Annotated[Identity, Depends(identity)]


class TradeSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid")
    data: dict = Field(max_length=20)
    preview: str = Field(min_length=1, max_length=128)


def mount_trading(app, db):
    service = Trading(db)
    app.state.trading = service

    @app.post("/api/trading/preview", tags=["trading"])
    async def preview(data: dict, who: Member):
        return await service.preview(who, data)

    @app.post("/api/trading/operations", tags=["trading"])
    async def submit(data: TradeSubmission, who: Member):
        return await service.submit(who, data.data, data.preview)

    @app.get("/api/trading/operations/{request_id}", tags=["trading"])
    async def receipt(request_id: UUID, who: Member):
        return await service.receipt(who, request_id)

    @app.get("/api/trading/fills", tags=["trading"])
    async def fills(
        who: Member,
        recordId: str = Query(min_length=1, max_length=100),
        limit: int = Query(default=50, ge=1, le=100),
        offset: int = Query(default=0, ge=0, le=1000000),
        recordRevision: int | None = Query(default=None, ge=1),
    ):
        return await service.list(who, recordId, limit=limit, offset=offset, revision=recordRevision)
