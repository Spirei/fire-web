"""Shared email challenges and registration. Secrets stay encrypted at rest."""

import asyncio
import hmac
import re
import secrets

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .accounts import LoginConflict, insert_account
from .identity_mail import IdentityMail
from .native_app_auth import security_stamp
from .native_identity_capabilities import verification_link_available
from .passwords import hash_password, password_error
from .security import digest, lock_mutation_identity


def normalized_email(value):
    if not isinstance(value, str):
        raise HTTPException(400, "请填写有效邮箱")
    email = value.strip().lower()
    if len(email) > 254 or not re.fullmatch(
        r"[a-z0-9.!#$%&'*+/=?^_{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?",
        email,
    ):
        raise HTTPException(400, "请填写有效邮箱")
    return email


class IdentityEmail:
    def __init__(self, settings, db):
        self.settings, self.db = settings, db
        self.mail = IdentityMail(settings, db, dynamic=True)

    async def request_registration(self, email):
        await self.mail.refresh()
        if not self.mail.configured:
            raise HTTPException(503, "邮箱注册暂不可用")
        challenge, code = secrets.token_urlsafe(32), f"{secrets.randbelow(1000000):06d}"
        binding = digest("registration-email:" + email)
        async with self.db.connection() as conn, conn.transaction():
            from .site_registration import require_registration_open

            await require_registration_open(conn)
            await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (binding,))
            existing = await (
                await conn.execute(
                    "SELECT 1 FROM identity_challenges WHERE purpose='email-registration' AND binding=%s AND expires_at>clock_timestamp()+interval '29 minutes'",
                    (binding,),
                )
            ).fetchone()
            if existing:
                raise HTTPException(429, "请在60秒后重试")
            registered = await (
                await conn.execute(
                    "SELECT 1 FROM users WHERE lower(email)=lower(%s) OR lower(username)=lower(%s)",
                    (email, email),
                )
            ).fetchone()
            if not registered:
                await conn.execute(
                    "DELETE FROM identity_challenges WHERE purpose='email-registration' AND binding=%s",
                    (binding,),
                )
                payload = {
                    "email_ciphertext": self.mail.vault.encrypt(
                        email, "registration-email:" + digest(challenge), self.settings.instance_id
                    ),
                    "code_hash": digest(challenge + ":" + code),
                    "origin": self.settings.public_origin,
                }
                row = await (
                    await conn.execute(
                        "INSERT INTO identity_challenges(id,purpose,binding,payload,expires_at) VALUES(%s,'email-registration',%s,%s,clock_timestamp()+interval '30 minutes') RETURNING expires_at",
                        (digest(challenge), binding, Jsonb(payload)),
                    )
                ).fetchone()
                await self.mail.enqueue(
                    conn,
                    user_id=None,
                    challenge_id=digest(challenge),
                    kind="email-registration",
                    recipient=email,
                    text="注册验证码：" + code + "。30分钟内有效。",
                    template_values={"code": code, "minutes": 30},
                    expires_at=row["expires_at"],
                )
        # Same public response for existing addresses; no account or mail-status oracle.
        return {"challenge": challenge, "email": email, "expires_in": 1800, "retry_after": 60}

    async def confirm_registration(self, email, challenge, code, password, request_id, create_session, *, setup_token=None):
        if error := password_error(password):
            raise HTTPException(400, error)
        hashed = await asyncio.to_thread(hash_password, password)
        result = None
        async with self.db.connection() as conn, conn.transaction():
            # Match insert_account's table lock before any proof lock. This also
            # makes the first successful email/username registration one decision.
            from .registration import require_setup_token
            await require_setup_token(conn, self.settings, setup_token)
            from .site_registration import require_registration_open

            await require_registration_open(conn)
            row = await (
                await conn.execute(
                    "SELECT *,expires_at>clock_timestamp() AS valid FROM identity_challenges WHERE id=%s AND purpose='email-registration' AND binding=%s FOR UPDATE",
                    (digest(challenge), digest("registration-email:" + email)),
                )
            ).fetchone()
            if (
                row
                and row["valid"]
                and row["attempts"] < 5
                and row["payload"]["origin"] == self.settings.public_origin
            ):
                await conn.execute(
                    "UPDATE identity_challenges SET attempts=attempts+1 WHERE id=%s", (row["id"],)
                )
                if re.fullmatch(r"\d{6}", code) and hmac.compare_digest(
                    row["payload"]["code_hash"], digest(challenge + ":" + code)
                ):
                    try:
                        async with conn.transaction():
                            user = await insert_account(
                                conn, "user_" + secrets.token_hex(6), hashed, email=email
                            )
                            await conn.execute(
                                "INSERT INTO identity_security(user_id,email_verified) VALUES(%s,true)",
                                (user["id"],),
                            )
                            token, session = await create_session(conn, user, request_id)
                            await conn.execute("DELETE FROM identity_challenges WHERE id=%s", (row["id"],))
                            await conn.execute(
                                "INSERT INTO audit_events(actor_id,action,request_id) VALUES(%s,'user.email_registered',%s)",
                                (user["id"], request_id),
                            )
                            result = (user, token, session)
                    except LoginConflict:
                        await conn.execute("DELETE FROM identity_challenges WHERE id=%s", (row["id"],))
        if result is None:
            raise HTTPException(400, "验证码错误或已失效，请重新核对")
        return result

    async def verification_status(self, who):
        async with self.db.connection() as conn:
            row = await (
                await conn.execute(
                    "SELECT u.email,COALESCE(s.email_verified,false) AS verified,NOT EXISTS(SELECT 1 FROM restore_quarantine WHERE category='external_delivery_disabled') AS delivery_allowed FROM users u LEFT JOIN identity_security s ON s.user_id=u.id WHERE u.id=%s",
                    (who.id,),
                )
            ).fetchone()
        return {
            "email": row["email"],
            "verified": row["verified"],
            "canRequest": bool(
                row["email"]
                and not row["verified"]
                and self.mail.configured
                and verification_link_available(self.settings)
                and row["delivery_allowed"]
                and (
                    not getattr(who, "native_client", False)
                    or "security.write" in getattr(who, "email_scope", "")
                )
            ),
        }

    async def request_verification(self, who):
        async with self.db.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
            )
            await lock_mutation_identity(conn, who, require_admin=False)
            user = await (
                await conn.execute("SELECT * FROM users WHERE id=%s FOR UPDATE", (who.id,))
            ).fetchone()
            factor = await (
                await conn.execute("SELECT email_verified FROM identity_security WHERE user_id=%s", (who.id,))
            ).fetchone()
            if not user["email"]:
                raise HTTPException(400, "请先绑定邮箱")
            if factor and factor["email_verified"]:
                return {"ok": True, "verified": True}
            if not self.mail.configured or not verification_link_available(self.settings):
                raise HTTPException(503, "邮件服务或验证链接尚未配置")
            recent = await (
                await conn.execute(
                    "SELECT 1 FROM identity_mail_outbox WHERE user_id=%s AND kind='email-verification' AND created_at>clock_timestamp()-interval '60 seconds'",
                    (who.id,),
                )
            ).fetchone()
            if recent:
                raise HTTPException(429, "请在60秒后重试")
            daily = await (
                await conn.execute(
                    "SELECT count(*) AS n FROM identity_mail_outbox WHERE user_id=%s AND kind='email-verification' AND created_at>clock_timestamp()-interval '24 hours'",
                    (who.id,),
                )
            ).fetchone()
            if daily["n"] >= 10:
                raise HTTPException(429, "发送过于频繁，请稍后再试")
            token = secrets.token_urlsafe(32)
            await conn.execute(
                "DELETE FROM identity_challenges WHERE user_id=%s AND purpose='email-verification'", (who.id,)
            )
            row = await (
                await conn.execute(
                    "INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at) VALUES(%s,'email-verification',%s,%s,%s,clock_timestamp()+interval '30 minutes') RETURNING expires_at",
                    (
                        digest(token),
                        who.id,
                        self.settings.public_origin,
                        Jsonb(
                            {"email_hash": digest(user["email"]), "session_version": user["session_version"]}
                        ),
                    ),
                )
            ).fetchone()
            await self.mail.enqueue(
                conn,
                user_id=who.id,
                challenge_id=digest(token),
                kind="email-verification",
                recipient=user["email"],
                text="验证邮箱：" + self.settings.public_origin + "/verify-email#token=" + token,
                template_values={"url": self.settings.public_origin + "/verify-email#token=" + token, "minutes": 30, "nativeToken": token},
                expires_at=row["expires_at"],
            )
            return {"ok": True, "verified": False, "retryAfter": 60}

    async def confirm_verification(self, token, who=None):
        accepted = None
        async with self.db.connection() as conn, conn.transaction():
            candidate = await (
                await conn.execute(
                    "SELECT user_id FROM identity_challenges WHERE id=%s AND purpose='email-verification'",
                    (digest(token),),
                )
            ).fetchone()
            if candidate and (who is None or candidate["user_id"] == who.id):
                uid = candidate["user_id"]
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + uid,)
                )
                if who:
                    await lock_mutation_identity(conn, who, require_admin=False)
                user = await (
                    await conn.execute("SELECT * FROM users WHERE id=%s AND active FOR UPDATE", (uid,))
                ).fetchone()
                row = await (
                    await conn.execute(
                        "SELECT *,expires_at>clock_timestamp() AS valid FROM identity_challenges WHERE id=%s AND purpose='email-verification' FOR UPDATE",
                        (digest(token),),
                    )
                ).fetchone()
                if (
                    user
                    and row
                    and row["valid"]
                    and row["binding"] == self.settings.public_origin
                    and row["payload"]
                    == {"email_hash": digest(user["email"]), "session_version": user["session_version"]}
                ):
                    await conn.execute(
                        "INSERT INTO identity_security(user_id,email_verified,source_stamp) VALUES(%s,true,%s) ON CONFLICT(user_id) DO UPDATE SET email_verified=true",
                        (uid, await security_stamp(conn, user)),
                    )
                    await conn.execute("DELETE FROM identity_challenges WHERE id=%s", (row["id"],))
                    await conn.execute(
                        "INSERT INTO audit_events(actor_id,action) VALUES(%s,'identity.email.verified')",
                        (uid,),
                    )
                    accepted = uid
        if not accepted:
            raise HTTPException(400, "验证凭证错误或已失效")
        return accepted
