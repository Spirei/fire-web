"""Candidate routes mounted explicitly only by isolated create_app tests."""

from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, Query, Request

from alcor_api import tasks
from alcor_api.dividend_chain import DividendChain
from alcor_api.dividend_chain_tasks import DividendTaskInput, submit
from alcor_api.models import TaskDetail, TaskOut
from alcor_api.security import Identity, administrator, identity


def mount_dividend_chain(app, db, coverage_verifier=None):
    service = DividendChain(db, coverage_verifier)
    member = Annotated[Identity, Depends(identity)]
    admin = Annotated[Identity, Depends(administrator)]
    app.state.dividend_chain_candidate = service

    @app.post("/api/dividends/announcements/tasks", status_code=202)
    async def queue(data: DividendTaskInput, who: admin):
        row = await submit(db, who, data)
        return {"id": str(row["id"]), "requestId": str(row["request_id"]), "status": row["status"]}

    @app.get("/api/dividends/tasks/{task_id}", response_model=TaskDetail)
    async def task(task_id: UUID, who: admin):
        return await tasks.detail(db, who, task_id)

    @app.post("/api/dividends/tasks/{task_id}/cancel", response_model=TaskOut)
    async def cancel(task_id: UUID, who: admin):
        return await tasks.cancel(db, who, task_id)

    @app.get("/api/dividends/announcements")
    async def announcements(
        who: member,
        market: str,
        code: str,
        limit: int = Query(50, ge=1, le=100),
        before: int | None = Query(None, ge=1),
    ):
        return await service.list(who, market, code, limit, before)

    @app.get("/api/dividends/announcements/{revision}/history")
    async def history(
        revision: UUID,
        who: member,
        limit: int = Query(50, ge=1, le=100),
        before_version: int | None = Query(None, ge=1),
    ):
        return await service.history(who, revision, limit, before_version)

    @app.post("/api/dividends/history-evidence")
    async def coverage(data: dict, who: member):
        return await service.capture_coverage(who, data)

    @app.get("/api/dividends/entitlements")
    async def expectation(
        who: member, record_id: str, announcement_revision: UUID, coverage_revision: UUID | None = None
    ):
        return await service.entitlement(who, record_id, announcement_revision, coverage_revision)

    @app.post("/api/dividends/receipt-links")
    async def link(data: dict, who: member):
        return await service.link(who, data)

    @app.get("/api/dividends/notices")
    async def notices(
        who: member, limit: int = Query(50, ge=1, le=100), before: int | None = Query(None, ge=1)
    ):
        return await service.notices(who, limit, before)

    @app.post("/api/v1/dividends")
    async def legacy_estimated_settlement(request: Request):
        from alcor_api.legacy_identity import body
        from alcor_api.legacy_portfolio import portfolio_member

        who = await portfolio_member(request, db.settings, db, write=True)
        data = await body(request, ("recordId",), limit=4096)
        record_id = data.get("recordId")
        if not isinstance(record_id, str) or not 1 <= len(record_id.strip()) <= 100:
            raise HTTPException(400, "缺少持仓记录")
        async with db.connection() as conn:
            exists = await (
                await conn.execute(
                    "SELECT 1 FROM portfolio_records WHERE owner_id=%s AND id=%s AND deleted_at IS NULL",
                    (who.id, record_id.strip()),
                )
            ).fetchone()
        if not exists:
            raise HTTPException(404, "持仓记录不存在")
        raise HTTPException(409, "旧自动补账缺少实际到账单据，请更新客户端并通过统一股息凭证入口登记")
