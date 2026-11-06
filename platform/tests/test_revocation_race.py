from uuid import uuid4

import pytest
from fastapi import HTTPException

from alcor_api.models import TaskInput
from alcor_api.security import Identity, csrf_token, digest
from alcor_api.tasks import submit


async def test_revoked_identity_between_http_check_and_commit(client, admin, db):
    token = client.cookies["alcor_session"]
    async with db.connection() as conn:
        row = await (
            await conn.execute("SELECT expires_at FROM sessions WHERE token_hash=%s", (digest(token),))
        ).fetchone()
        await conn.execute("DELETE FROM sessions WHERE token_hash=%s", (digest(token),))
    stale = Identity(admin, "AdminOne", "admin", digest(token), csrf_token(token), row["expires_at"])
    with pytest.raises(HTTPException) as result:
        await submit(db, stale, TaskInput(request_id=uuid4()))
    assert result.value.status_code == 401
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) AS n FROM tasks")).fetchone())["n"] == 0
