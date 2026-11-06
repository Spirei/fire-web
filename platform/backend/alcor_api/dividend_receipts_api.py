from typing import Annotated
from uuid import UUID

from fastapi import Depends, Query
from pydantic import BaseModel, ConfigDict

from alcor_api.dividend_receipts import DividendReceipts
from alcor_api.security import Identity, identity


class Submission(BaseModel):
    model_config = ConfigDict(extra="forbid")
    data: dict
    preview: str


def mount_dividend_receipts(app, db):
    service = DividendReceipts(db)
    member = Annotated[Identity, Depends(identity)]

    @app.post("/api/dividends/receipts/preview")
    async def preview(data: dict, who: member):
        return await service.preview(who, data)

    @app.post("/api/dividends/receipts/operations")
    async def submit(data: Submission, who: member):
        return await service.submit(who, data.data, data.preview)

    @app.get("/api/dividends/receipts/operations/{request_id}")
    async def receipt(request_id: UUID, who: member):
        return await service.receipt(who, request_id)

    @app.get("/api/dividends/receipts")
    async def history(
        who: member,
        limit: int = Query(default=25, ge=1, le=100),
        before: int | None = Query(default=None, ge=1),
    ):
        return await service.list(who, limit, before)
