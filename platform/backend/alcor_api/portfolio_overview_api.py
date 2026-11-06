"""Canonical portfolio observation reads. GET never renews or collects a source."""

from fastapi import Request
from fastapi.responses import JSONResponse

from .portfolio_overview import PortfolioOverview
from .record_file_api import actor


def mount_portfolio_overview(app, db, market_authority):
    service = PortfolioOverview(db, market_authority)
    app.state.portfolio_overview = service

    @app.get("/api/portfolio/overview")
    async def overview(
        request: Request, currency: str = "USD", costMethod: str = "diluted", usPrice: str = "observed"
    ):
        who = await actor(request, db)
        return JSONResponse(
            await service.read(who, currency=currency, cost_method=costMethod, us_price=usPrice),
            headers={"Cache-Control": "private, no-store", "Vary": "Cookie, Authorization"},
        )

    return service
