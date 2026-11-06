"""Connection-specific verification without replacing the browser session or its drafts."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request

from .admin_verification import VerificationInput, require_admin_verification, verify_admin_access
from .security import Identity, administrator

router = APIRouter(prefix="/api/connections", tags=["administration"])
Admin = Annotated[Identity, Depends(administrator)]


async def require_connection_verification(conn, who):
    await require_admin_verification(conn, who, "connection")


@router.post("/reauthenticate", status_code=204)
async def verify_connection_access(data: VerificationInput, request: Request, who: Admin):
    return await verify_admin_access(data, request, who, "connection")
