"""Explicit candidate wiring of source-aware replay into the existing GET route."""

from typing import Annotated
from uuid import UUID

from fastapi import Depends

from .dividend_chain_api import mount_dividend_chain
from .dividend_source_service import mount
from .dividend_source_verification import SourceAwareChain
from .security import Identity, identity


def mount_source_chain(app, sources, history_verifier=None):
    """Startup-only candidate hook; formal merge should inject the service factory.

    Reuse every frozen mutation/history/receipt route and replace only the existing
    entitlement reader, under its exact canonical URL. There is no second calculator.
    """
    mount_dividend_chain(app, sources.db)
    app.router.routes[:] = [
        route
        for route in app.router.routes
        if not (
            getattr(route, "path", "") == "/api/dividends/entitlements"
            and getattr(route, "methods", set()) == {"GET"}
        )
    ]
    service = SourceAwareChain(sources.db, sources, history_verifier)
    app.state.dividend_chain_source_candidate = service
    member = Annotated[Identity, Depends(identity)]

    @app.get("/api/dividends/entitlements")
    async def entitlement(
        who: member, record_id: str, announcement_revision: UUID, coverage_revision: UUID | None = None
    ):
        return await service.entitlement(who, record_id, announcement_revision, coverage_revision)

    mount(app, sources)
