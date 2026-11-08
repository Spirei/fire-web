"""Single native password mutation implementation shared by all protocol adapters."""

import asyncio
from uuid import uuid4

from fastapi import HTTPException

from .identity_service import IdentityService
from .passwords import hash_password, password_error, verify_password
from .security import lock_mutation_identity


async def apply_password_locked(
    conn, who, hashed, request_id, *, keep_current=False, keep_all_sessions=False
):
    await conn.execute(
        "UPDATE users SET password_hash=%s,session_version=session_version+1,revision=%s WHERE id=%s",
        (hashed, uuid4(), who.id),
    )
    if keep_all_sessions:
        await conn.execute(
            "UPDATE sessions SET session_version=(SELECT session_version FROM users WHERE id=%s) WHERE user_id=%s",
            (who.id, who.id),
        )
    elif keep_current:
        await conn.execute(
            "DELETE FROM sessions WHERE user_id=%s AND token_hash<>%s", (who.id, who.token_hash)
        )
        await conn.execute(
            "UPDATE sessions SET session_version=(SELECT session_version FROM users WHERE id=%s) WHERE token_hash=%s",
            (who.id, who.token_hash),
        )
    else:
        await conn.execute("DELETE FROM sessions WHERE user_id=%s", (who.id,))
    await conn.execute(
        "UPDATE client_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE owner_id=%s",
        (who.id,),
    )
    await conn.execute(
        "UPDATE identity_app_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=%s",
        (who.id,),
    )
    await conn.execute("UPDATE identity_security SET source_stamp=NULL WHERE user_id=%s", (who.id,))
    await conn.execute("DELETE FROM identity_challenges WHERE user_id=%s", (who.id,))
    await conn.execute(
        "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'account.password.changed',%s)",
        (who.id, request_id),
    )


async def change_own_password(
    db, who, current_password, new_password, code, request_id, *, keep_current=False, keep_all_sessions=False
):
    if error := password_error(new_password):
        raise HTTPException(422, error)
    async with db.connection() as conn:
        from .session_verification import SESSION_PROOF, verified
        strong = current_password == SESSION_PROOF and await verified(conn, who)
        original = await (
            await conn.execute("SELECT password_hash FROM users WHERE id=%s", (who.id,))
        ).fetchone()
    if not original or not strong and not await asyncio.to_thread(
        verify_password, current_password, original["password_hash"]
    ):
        raise HTTPException(422, "当前密码不正确")
    hashed = await asyncio.to_thread(hash_password, new_password)
    async with db.connection() as conn, conn.transaction():
        # Serialize before taking user/session SHARE locks, matching factor and
        # passkey mutations; upgrading concurrent SHARE locks can otherwise deadlock.
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await lock_mutation_identity(conn, who, require_admin=False)
        current = await (
            await conn.execute("SELECT password_hash FROM users WHERE id=%s FOR UPDATE", (who.id,))
        ).fetchone()
        if current["password_hash"] != original["password_hash"]:
            raise HTTPException(409, "账号已更新，请重新核对")
        if strong and not await verified(conn, who):
            raise HTTPException(403, "身份验证已失效")
        service = IdentityService(db.settings, db)
        factor = await service.factor(conn, who.id)
        if not strong and factor and factor["totp_enabled"] and not await service.consume(conn, who.id, code):
            raise HTTPException(403, "二次验证失败")
        await apply_password_locked(
            conn, who, hashed, request_id, keep_current=keep_current, keep_all_sessions=keep_all_sessions
        )


async def issue_password_proof(db, who, current_password, request_id):
    """Native two-step proof: password only, bound to one grant and identity state."""
    import secrets

    from psycopg.types.json import Jsonb

    from .native_app_auth import security_stamp
    from .security import digest

    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await lock_mutation_identity(conn, who, require_admin=False)
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s FOR UPDATE", (who.id,))).fetchone()
        if not current_password or not await asyncio.to_thread(
            verify_password, current_password, user["password_hash"]
        ):
            raise HTTPException(403, "原密码错误")
        proof = secrets.token_urlsafe(32)
        await conn.execute(
            "DELETE FROM identity_challenges WHERE user_id=%s AND purpose='password-proof'", (who.id,)
        )
        row = await (
            await conn.execute(
                "INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at) VALUES(%s,'password-proof',%s,%s,%s,clock_timestamp()+interval '5 minutes') RETURNING expires_at",
                (
                    digest(proof),
                    who.id,
                    "grant:" + who.grant_id,
                    Jsonb(
                        {
                            "email": user["email"],
                            "session_version": user["session_version"],
                            "security_stamp": await security_stamp(conn, user),
                        }
                    ),
                ),
            )
        ).fetchone()
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'account.password.proof.issued',%s)",
            (who.id, request_id),
        )
        return {"ok": True, "proof": proof, "expiresAt": int(row["expires_at"].timestamp() * 1000)}


async def confirm_password_proof(db, who, proof, new_password, request_id):
    import re

    from .native_app_auth import security_stamp
    from .security import digest

    if error := password_error(new_password):
        raise HTTPException(400, error)
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", proof):
        raise HTTPException(400, "验证凭证错误或已失效")
    hashed = await asyncio.to_thread(hash_password, new_password)
    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await lock_mutation_identity(conn, who, require_admin=False)
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s FOR UPDATE", (who.id,))).fetchone()
        state = await (
            await conn.execute(
                "SELECT *,expires_at>clock_timestamp() AS valid FROM identity_challenges WHERE id=%s AND purpose='password-proof' AND user_id=%s AND binding=%s FOR UPDATE",
                (digest(proof), who.id, "grant:" + who.grant_id),
            )
        ).fetchone()
        if (
            not state
            or not state["valid"]
            or state["payload"]
            != {
                "email": user["email"],
                "session_version": user["session_version"],
                "security_stamp": await security_stamp(conn, user),
            }
        ):
            raise HTTPException(400, "验证凭证错误或已失效")
        await apply_password_locked(conn, who, hashed, request_id)
    return {"ok": True, "reauthenticationRequired": True}
