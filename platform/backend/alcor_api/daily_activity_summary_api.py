"""One owner-bound daily summary read, never collection on GET."""

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from .daily_activity_summary import DailyActivitySummary
from .record_file_api import actor


def mount_daily_activity_summary(app, db):
    service = DailyActivitySummary(db, app.state.market_authority)
    app.state.daily_activity_summary = service

    async def read(request: Request):
        if request.query_params:
            raise HTTPException(400, "日汇总不接受查询参数")
        who = await actor(request, db)
        return JSONResponse(
            await service.read(who),
            headers={"Cache-Control": "no-store, private", "Vary": "Cookie, Authorization"},
        )

    app.add_api_route(
        "/api/activities/daily-summary", read, methods=["GET"], operation_id="legacy_activities_daily_summary"
    )
    app.add_api_route(
        "/api/portfolio/daily-summary", read, methods=["GET"], operation_id="portfolio_daily_summary"
    )
    return service
