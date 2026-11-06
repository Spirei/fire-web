from typing import Annotated
from uuid import UUID

from fastapi import Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from .internal_orders import InternalOrders
from .security import Identity, identity

Member = Annotated[Identity, Depends(identity)]


class OrderSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid")
    data: dict = Field(max_length=20)
    preview: str = Field(min_length=1, max_length=128)


def mount_internal_orders(app, db):
    service = InternalOrders(db)
    app.state.internal_orders = service

    @app.post("/api/trading/orders/preview", tags=["internal-orders"])
    async def preview(data: dict, who: Member):
        return await service.preview(who, data)

    @app.post("/api/trading/orders/operations", tags=["internal-orders"])
    async def submit(data: OrderSubmission, who: Member):
        return await service.submit(who, data.data, data.preview)

    @app.get("/api/trading/orders/operations/{request_id}", tags=["internal-orders"])
    async def receipt(request_id: UUID, who: Member):
        return await service.receipt(who, request_id)

    @app.get("/api/trading/orders", tags=["internal-orders"])
    async def orders(
        who: Member,
        limit: int = Query(default=50, ge=1, le=100),
        offset: int = Query(default=0, ge=0, le=1000000),
        revision: int | None = Query(default=None, ge=0),
    ):
        return await service.list(who, limit=limit, offset=offset, revision=revision)
