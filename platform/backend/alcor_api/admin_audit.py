"""Rejected verified-admin attempts are recorded after mutation rollback."""

from functools import wraps
from inspect import signature

from fastapi import HTTPException


def audit_admin_rejection(action):
    def decorate(endpoint):
        parameters = signature(endpoint)

        @wraps(endpoint)
        async def wrapped(*args, **kwargs):
            bound = parameters.bind(*args, **kwargs).arguments
            try:
                return await endpoint(*args, **kwargs)
            except HTTPException as error:
                if error.status_code != 403:
                    raise
                request, who = bound["request"], bound["who"]
                # Endpoint dependencies/protocol identity have already verified
                # this actor. No body, password, code, or user-controlled reason.
                async with request.app.state.db.connection() as conn, conn.transaction():
                    await conn.execute(
                        "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,%s,%s,%s)",
                        (who.id, action, bound["user_id"], request.state.request_id),
                    )
                raise

        return wrapped

    return decorate
