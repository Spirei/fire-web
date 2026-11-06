"""Short, session-bound administrator verification for one sensitive feature."""

from typing import Literal

from fastapi import HTTPException, Request, Response
from psycopg.types.json import Jsonb
from pydantic import Field, SecretStr

from .models import InputModel
from .security import digest, lock_mutation_identity

Scope = Literal["connection", "deployment", "reference"]


class VerificationInput(InputModel):
    password: SecretStr = Field(min_length=1, max_length=128)
    code: SecretStr = Field(default=SecretStr(""), max_length=32)


def purpose(scope: Scope):
    if scope not in {"connection", "deployment", "reference"}:
        raise ValueError("Unknown verification scope")
    return scope + "-reauth"


async def require_admin_verification(conn, who, scope: Scope):
    name = purpose(scope)
    row = await (
        await conn.execute(
            """SELECT s.created_at>clock_timestamp()-interval '15 minutes' OR EXISTS(
        SELECT 1 FROM identity_challenges c WHERE c.id=%s AND c.purpose=%s
          AND c.user_id=u.id AND c.binding=s.token_hash AND c.expires_at>clock_timestamp()
          AND c.payload->>'session_version'=u.session_version::text) AS ok
        FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=%s""",
            (digest(name + ":" + who.token_hash), name, who.token_hash),
        )
    ).fetchone()
    if not row or not row["ok"]:
        raise HTTPException(403, "请验证身份后继续", headers={"X-Alcor-Reauthentication": "required"})


async def verify_admin_access(data: VerificationInput, request: Request, who, scope: Scope):
    name = purpose(scope)
    if not await request.app.state.rate_limit(request.app.state.db, name + ":" + who.id, 10):
        raise HTTPException(429, "验证尝试过于频繁，请稍后再试")
    async with request.app.state.db.connection() as conn, conn.transaction():
        await request.app.state.native_passkeys.serialize(conn, who)
        await lock_mutation_identity(conn, who)
        user = await request.app.state.native_passkeys.step_up(
            conn, who, data.password.get_secret_value(), data.code.get_secret_value()
        )
        await conn.execute(
            """INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at)
            VALUES(%s,%s,%s,%s,%s,clock_timestamp()+interval '15 minutes')
            ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at""",
            (
                digest(name + ":" + who.token_hash),
                name,
                who.id,
                who.token_hash,
                Jsonb({"session_version": user["session_version"]}),
            ),
        )
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action) VALUES(%s,%s)",
            (who.id, scope + ".identity.verified"),
        )
    return Response(status_code=204)
