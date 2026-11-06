"""Canonical record API with explicit preview/confirm and exact Decimal strings."""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field

from .portfolio_records import PortfolioRecords
from .security import Identity, identity

Member = Annotated[Identity, Depends(identity)]


class RecordPreview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["create", "update", "delete"]
    recordId: str = Field(default="", max_length=100)
    revision: int | None = Field(default=None, ge=1, strict=True)
    data: dict = Field(default_factory=dict, max_length=15)


class BatchSelection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1,max_length=100)
    revision: int = Field(ge=1,strict=True)


class BatchPreview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    collectionRevision: int = Field(ge=0,strict=True)
    records: list[BatchSelection] = Field(min_length=1,max_length=200)


class RecordConfirm(BaseModel):
    model_config = ConfigDict(extra="forbid")
    previewId: UUID
    requestId: UUID


def mount_portfolio_records(app, db):
    service = PortfolioRecords(db)
    app.state.portfolio_records = service
    from .legacy_record_writes import ReadOnlyRecords, RecordCommands, TransactionDB
    from .security import lock_mutation_identity
    batches=RecordCommands(db)

    async def current_read(who,method,*args,**kwargs):
        async with db.connection() as conn,conn.transaction():
            await lock_mutation_identity(conn,who,require_admin=False)
            current=ReadOnlyRecords(TransactionDB(db,conn),who)
            return await getattr(current,method)(who.id,*args,**kwargs)

    @app.post('/api/portfolio/records/batch/preview')
    async def batch_preview(data:BatchPreview,who:Member):
        return await batches.preview_batch(who,data.model_dump())

    @app.post('/api/portfolio/records/batch/confirm')
    async def batch_confirm(data:RecordConfirm,who:Member):
        return await batches.confirm_batch(who,data.previewId,data.requestId)

    @app.get('/api/portfolio/records/batch/operations/{request_id}')
    async def batch_receipt(request_id:UUID,who:Member):
        value=await batches.receipt(who,request_id)
        if value.get('kind') not in ('batch_delete','clear'):
            raise HTTPException(404,'原批量删除回执不存在')
        return value

    @app.get("/api/portfolio/records", tags=["portfolio"])
    async def records(
        who: Member,
        page: int = Query(default=1, ge=1, le=1_000_000),
        pageSize: int = Query(default=100, ge=1, le=100),
        collectionRevision: int | None = Query(default=None, ge=0),
        market: str = Query(default="", max_length=40),
        group: str = Query(default="", max_length=100),
        view: str = Query(default="", max_length=100),
        brokerAccountId: str = Query(default="", max_length=100),
        displayRevision: str | None = Query(default=None,pattern="^[a-f0-9]{64}$"),
        displayMode: Literal["all","watch"] = "all",
    ):
        return await current_read(who,"list", page=page, page_size=pageSize, collection_revision=collectionRevision, market=market, group=group, view=view, broker_account_id=brokerAccountId,display_revision=displayRevision,display_mode=displayMode)

    @app.post("/api/portfolio/records/preview", tags=["portfolio"])
    async def preview(data: RecordPreview, who: Member):
        return await service.preview(who.id, data.kind, data.data, record_id=data.recordId, revision=data.revision, authorization=who)

    @app.post("/api/portfolio/records/confirm", tags=["portfolio"])
    async def confirm(data: RecordConfirm, who: Member):
        return await service.confirm(who.id, data.previewId, data.requestId, authorization=who)

    @app.get("/api/portfolio/records/operations/{request_id}", tags=["portfolio"])
    async def receipt(request_id: UUID, who: Member):
        return await current_read(who,"receipt", request_id)

    @app.get("/api/portfolio/records/{record_id}", tags=["portfolio"])
    async def record(record_id: str, who: Member):
        return await current_read(who,"snapshot", record_id)
