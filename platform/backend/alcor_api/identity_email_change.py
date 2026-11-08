"""One email authority, with distinct direct and grant-bound proof policies."""

import asyncio
import hmac
import re
import secrets
from uuid import uuid4

from fastapi import HTTPException
from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb

from .identity_service import IdentityService
from .native_app_auth import security_stamp
from .passwords import verify_password
from .security import digest, lock_mutation_identity


def email_value(value, *, proof=False):
    value = value.strip()
    if proof:
        value = value.lower()
    pattern = (
        r"[a-z0-9.!#$%&'*+/=?^_{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
        if proof
        else r"\S+@\S+\.\S+"
    )
    if len(value) > 254 or ((proof or value) and not re.fullmatch(pattern, value)):
        raise HTTPException(400, "邮箱格式不正确")
    return value


class IdentityEmailChange:
    def __init__(self, settings, db, mail):
        self.settings, self.db, self.mail = settings, db, mail
        self.factors = IdentityService(settings, db)

    async def owner(self, conn, who):
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )
        await conn.execute("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE")
        await lock_mutation_identity(conn, who, require_admin=False)
        return await (await conn.execute("SELECT * FROM users WHERE id=%s FOR UPDATE", (who.id,))).fetchone()

    async def stamp(self, conn, user):
        return {
            "email": user["email"],
            "session_version": user["session_version"],
            "security_stamp": await security_stamp(conn, user),
        }

    async def apply(self, conn, who, user, email, request_id, *, revoke, audit_actor_id=None):
        changed = email.lower() != user["email"].strip().lower()
        if revoke and not changed:
            raise HTTPException(409, "请填写新的邮箱")
        # owner() already holds the same users table lock as account registration.
        conflict = (
            await (
                await conn.execute(
                    "SELECT 1 FROM users WHERE id<>%s AND (lower(email)=lower(%s) OR lower(username)=lower(%s))",
                    (who.id, email, email),
                )
            ).fetchone()
            if email
            else None
        )
        if conflict:
            raise HTTPException(409, "该邮箱已被其他账号绑定")
        try:
            await conn.execute("UPDATE users SET email=%s,revision=%s WHERE id=%s", (email, uuid4(), who.id))
        except UniqueViolation:
            raise HTTPException(409, "该邮箱已被其他账号绑定") from None
        if changed:
            await conn.execute(
                "UPDATE identity_security SET email_verified=false WHERE user_id=%s", (who.id,)
            )
            await conn.execute(
                "DELETE FROM identity_challenges WHERE user_id=%s AND (purpose LIKE 'recovery-%%' OR purpose LIKE 'email-%%' OR purpose='password-proof')",
                (who.id,),
            )
            await conn.execute(
                "UPDATE identity_mail_outbox SET status=CASE WHEN status='sending' THEN 'unknown' ELSE 'cancelled' END, ciphertext=NULL,finished_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL WHERE user_id=%s AND status IN ('queued','sending')",
                (who.id,),
            )
        if revoke:
            await conn.execute("UPDATE users SET session_version=session_version+1 WHERE id=%s", (who.id,))
            await conn.execute("DELETE FROM sessions WHERE user_id=%s", (who.id,))
            await conn.execute(
                "UPDATE client_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE owner_id=%s",
                (who.id,),
            )
            await conn.execute(
                "UPDATE identity_app_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=%s",
                (who.id,),
            )
            await conn.execute("DELETE FROM identity_challenges WHERE user_id=%s", (who.id,))
        await conn.execute(
            "INSERT INTO audit_events(actor_id,action,target_id,request_id) VALUES(%s,'account.email.changed',%s,%s)",
            (audit_actor_id or who.id, who.id, request_id),
        )

    async def direct(self, who, email, password, code, request_id):
        email = email_value(email)
        async with self.db.connection() as conn, conn.transaction():
            user = await self.owner(conn, who)
            await self.direct_locked(conn, who, user, email, password, code, request_id)

    async def direct_locked(self, conn, who, user, email, password, code, request_id):
        from .session_verification import SESSION_PROOF, verified
        strong = password == SESSION_PROOF and await verified(conn, who)
        if not strong:
            if not password or not await asyncio.to_thread(verify_password, password, user["password_hash"]):
                raise HTTPException(403, "修改邮箱需要验证当前密码")
            factor = await self.factors.factor(conn, who.id)
            if factor and factor["totp_enabled"] and not await self.factors.consume(conn, who.id, code):
                raise HTTPException(403, "二次验证失败")
        await self.apply(conn, who, user, email, request_id, revoke=False)

    async def request(self, who, request_id):
        async with self.db.connection() as conn, conn.transaction():
            user = await self.owner(conn, who)
            if not user["email"]:
                raise HTTPException(409, "请先绑定邮箱")
            if not self.mail.configured:
                raise HTTPException(503, "邮件服务尚未配置")
            counts = await (
                await conn.execute(
                    "SELECT count(*) FILTER(WHERE created_at>clock_timestamp()-interval '60 seconds') AS recent,count(*) FILTER(WHERE created_at>clock_timestamp()-interval '15 minutes') AS quarter,count(*) AS daily FROM identity_mail_outbox WHERE user_id=%s AND kind='email-change' AND created_at>clock_timestamp()-interval '24 hours'",
                    (who.id,),
                )
            ).fetchone()
            if counts["recent"] or counts["quarter"] >= 5 or counts["daily"] >= 10:
                raise HTTPException(429, "发送过于频繁，请稍后再试")
            token = secrets.token_urlsafe(32)
            code = f"{secrets.randbelow(1000000):06d}"
            payload = await self.stamp(conn, user)
            payload["code_hash"] = digest(token + ":" + code)
            await conn.execute(
                "DELETE FROM identity_challenges WHERE user_id=%s AND purpose IN ('email-change-code','email-change-proof')",
                (who.id,),
            )
            row = await (
                await conn.execute(
                    "INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at) VALUES(%s,'email-change-code',%s,%s,%s,clock_timestamp()+interval '30 minutes') RETURNING expires_at",
                    (digest(token), who.id, "grant:" + who.grant_id, Jsonb(payload)),
                )
            ).fetchone()
            await self.mail.enqueue(
                conn,
                user_id=who.id,
                challenge_id=digest(token),
                kind="email-change",
                recipient=user["email"],
                text="变更邮箱验证码：" + code + "。30分钟内有效。",
                template_values={"code": code, "minutes": 30},
                expires_at=row["expires_at"],
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'account.email.challenge.queued',%s)",
                (who.id, request_id),
            )
            return {
                "ok": True,
                "challenge": token,
                "expiresAt": int(row["expires_at"].timestamp() * 1000),
                "retryAfter": 60,
            }

    async def state(self, conn, who, user, token, purpose):
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            return None
        row = await (
            await conn.execute(
                "SELECT *,expires_at>clock_timestamp() AS valid FROM identity_challenges WHERE id=%s AND purpose=%s AND user_id=%s AND binding=%s FOR UPDATE",
                (digest(token), purpose, who.id, "grant:" + who.grant_id),
            )
        ).fetchone()
        stamp = await self.stamp(conn, user)
        if (
            not row
            or not row["valid"]
            or row["attempts"] >= 5
            or any(row["payload"].get(k) != v for k, v in stamp.items())
        ):
            return None
        return row

    async def verify(self, who, challenge, code):
        result = None
        async with self.db.connection() as conn, conn.transaction():
            user = await self.owner(conn, who)
            row = await self.state(conn, who, user, challenge, "email-change-code")
            if row:
                await conn.execute(
                    "UPDATE identity_challenges SET attempts=attempts+1 WHERE id=%s", (row["id"],)
                )
                if re.fullmatch(r"\d{6}", code) and hmac.compare_digest(
                    row["payload"]["code_hash"], digest(challenge + ":" + code)
                ):
                    token = secrets.token_urlsafe(32)
                    await conn.execute(
                        "DELETE FROM identity_challenges WHERE id=%s OR (user_id=%s AND purpose='email-change-proof')",
                        (row["id"], who.id),
                    )
                    saved = await (
                        await conn.execute(
                            "INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at) VALUES(%s,'email-change-proof',%s,%s,%s,clock_timestamp()+interval '5 minutes') RETURNING expires_at",
                            (
                                digest(token),
                                who.id,
                                "grant:" + who.grant_id,
                                Jsonb(await self.stamp(conn, user)),
                            ),
                        )
                    ).fetchone()
                    result = {
                        "ok": True,
                        "proof": token,
                        "expiresAt": int(saved["expires_at"].timestamp() * 1000),
                    }
        if result is None:
            raise HTTPException(400, "验证码错误或已失效")
        return result

    async def confirm(self, who, proof, email, request_id):
        email = email_value(email, proof=True)
        async with self.db.connection() as conn, conn.transaction():
            user = await self.owner(conn, who)
            if not await self.state(conn, who, user, proof, "email-change-proof"):
                raise HTTPException(400, "验证凭证错误或已失效")
            await self.apply(conn, who, user, email, request_id, revoke=True)
        return {"ok": True, "reauthenticationRequired": True}
