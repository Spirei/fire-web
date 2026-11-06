"""Public recovery proofs: verified mail or an existing factor, never current holdings."""

import asyncio
import hmac
import re
import secrets
from types import SimpleNamespace

from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .account_credentials import apply_password_locked
from .identity_service import IdentityService
from .native_app_auth import security_stamp
from .passwords import hash_password, password_error
from .security import digest


class IdentityRecovery:
    def __init__(self, settings, db, mail, rate_limit):
        self.settings, self.db, self.mail, self.rate_limit = settings, db, mail, rate_limit
        self.factors = IdentityService(settings, db)

    async def stamp(self, conn, user, method):
        return {
            "email_hash": digest(user["email"]),
            "security_stamp": await security_stamp(conn, user),
            "session_version": user["session_version"],
            "method": method,
        }

    async def request(self, login, method="email", supplied="", self_id=None):
        token = secrets.token_urlsafe(32)
        requester_is_owner = False
        try:
            async with self.db.connection() as conn, conn.transaction():
                candidate = await (
                    await conn.execute(
                        "SELECT id FROM users WHERE active AND (lower(username)=lower(%s) OR lower(email)=lower(%s))",
                        (login, login),
                    )
                ).fetchone()
                if not candidate:
                    return token
                uid = candidate["id"]
                requester_is_owner = self_id == uid
                await conn.execute(
                    "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + uid,)
                )
                user = await (
                    await conn.execute("SELECT * FROM users WHERE id=%s AND active FOR UPDATE", (uid,))
                ).fetchone()
                if not user:
                    return token
                factor = await self.factors.factor(conn, uid)
                if method == "email":
                    if self_id == uid:
                        if not user["email"]:
                            raise HTTPException(400, "请先在个人信息中绑定邮箱")
                        if not factor or not factor["email_verified"]:
                            raise HTTPException(400, "请先在个人信息中验证邮箱")
                        if not self.mail.configured:
                            raise HTTPException(503, "邮件服务尚未配置")
                    eligible = bool(
                        user["email"] and factor and factor["email_verified"] and self.mail.configured
                    )
                else:
                    eligible = bool(factor and factor["totp_enabled"])
                if not eligible:
                    return token
                purpose = "recovery-" + method
                recent = await (
                    await conn.execute(
                        "SELECT id FROM identity_challenges WHERE user_id=%s AND purpose=%s AND expires_at>clock_timestamp()+make_interval(secs=>%s)",
                        (uid, purpose, 1740 if method == "email" else 240),
                    )
                ).fetchone()
                if recent:
                    return (
                        supplied
                        if re.fullmatch(r"[A-Za-z0-9_-]{43}", supplied) and digest(supplied) == recent["id"]
                        else token
                    )
                if method == "email":
                    # Owner budget is separate from anonymous IP budgets and survives
                    # failed sends/challenge invalidation; aliases cannot bypass it.
                    recent_mail = await (
                        await conn.execute(
                            "SELECT 1 FROM identity_mail_outbox WHERE user_id=%s AND kind='password-reset' AND created_at>clock_timestamp()-interval '60 seconds'",
                            (uid,),
                        )
                    ).fetchone()
                    daily = await (
                        await conn.execute(
                            "SELECT count(*) AS n FROM identity_mail_outbox WHERE user_id=%s AND kind='password-reset' AND created_at>clock_timestamp()-interval '24 hours'",
                            (uid,),
                        )
                    ).fetchone()
                    if recent_mail or daily["n"] >= 10:
                        return token
                    if await (
                        await conn.execute(
                            "SELECT 1 FROM restore_quarantine WHERE category='external_delivery_disabled'"
                        )
                    ).fetchone():
                        return token
                code = f"{secrets.randbelow(1000000):06d}"
                payload = await self.stamp(conn, user, method)
                if method == "email":
                    payload["code_hash"] = digest(token + ":" + code)
                await conn.execute(
                    "DELETE FROM identity_challenges WHERE user_id=%s AND purpose IN (%s,'recovery-proof')",
                    (uid, purpose),
                )
                row = await (
                    await conn.execute(
                        "INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at) VALUES(%s,%s,%s,%s,%s,clock_timestamp()+make_interval(secs=>%s)) RETURNING expires_at",
                        (
                            digest(token),
                            purpose,
                            uid,
                            self.settings.public_origin,
                            Jsonb(payload),
                            1800 if method == "email" else 300,
                        ),
                    )
                ).fetchone()
                if method == "email":
                    await self.mail.enqueue(
                        conn,
                        user_id=uid,
                        challenge_id=digest(token),
                        kind="password-reset",
                        recipient=user["email"],
                        text="重置密码验证码：" + code + "。30分钟内有效。",
                    template_values={"code": code, "minutes": 30},
                        expires_at=row["expires_at"],
                    )
        except HTTPException as exc:
            if exc.status_code >= 500 and not requester_is_owner:
                return token
            raise
        return token

    async def state(self, conn, token, purpose):
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            return None, None
        candidate = await (
            await conn.execute(
                "SELECT user_id FROM identity_challenges WHERE id=%s AND purpose=%s", (digest(token), purpose)
            )
        ).fetchone()
        if not candidate:
            return None, None
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
            ("identity-management:" + candidate["user_id"],),
        )
        user = await (
            await conn.execute(
                "SELECT * FROM users WHERE id=%s AND active FOR UPDATE", (candidate["user_id"],)
            )
        ).fetchone()
        row = await (
            await conn.execute(
                "SELECT *,expires_at>clock_timestamp() AS valid FROM identity_challenges WHERE id=%s AND purpose=%s FOR UPDATE",
                (digest(token), purpose),
            )
        ).fetchone()
        if (
            not user
            or not row
            or not row["valid"]
            or row["attempts"] >= 5
            or row["binding"] != self.settings.public_origin
        ):
            return None, None
        expected = await self.stamp(conn, user, row["payload"]["method"])
        if any(row["payload"].get(key) != value for key, value in expected.items()):
            return None, None
        factor = await self.factors.factor(conn, user["id"])
        if (
            not factor
            or not factor["email_verified" if row["payload"]["method"] == "email" else "totp_enabled"]
        ):
            return None, None
        return user, row

    async def verify(self, challenge, code, method="email"):
        result = None
        async with self.db.connection() as conn, conn.transaction():
            user, row = await self.state(conn, challenge, "recovery-" + method)
            if row:
                await conn.execute(
                    "UPDATE identity_challenges SET attempts=attempts+1 WHERE id=%s", (row["id"],)
                )
                valid = (
                    (
                        bool(re.fullmatch(r"\d{6}", code))
                        and hmac.compare_digest(row["payload"]["code_hash"], digest(challenge + ":" + code))
                    )
                    if method == "email"
                    else await self.factors.consume(conn, user["id"], code)
                )
                if valid:
                    token = secrets.token_urlsafe(32)
                    await conn.execute(
                        "DELETE FROM identity_challenges WHERE user_id=%s AND purpose='recovery-proof'",
                        (user["id"],),
                    )
                    await conn.execute("DELETE FROM identity_challenges WHERE id=%s", (row["id"],))
                    saved = await (
                        await conn.execute(
                            "INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at) VALUES(%s,'recovery-proof',%s,%s,%s,clock_timestamp()+interval '5 minutes') RETURNING expires_at",
                            (
                                digest(token),
                                user["id"],
                                self.settings.public_origin,
                                Jsonb(await self.stamp(conn, user, method)),
                            ),
                        )
                    ).fetchone()
                    result = {
                        "ok": True,
                        "token": token,
                        "expiresAt": int(saved["expires_at"].timestamp() * 1000),
                    }
        if not result:
            raise HTTPException(400, "验证码错误或已失效")
        return result

    async def confirm(self, token, password, request_id):
        if error := password_error(password):
            raise HTTPException(400, error)
        hashed = await asyncio.to_thread(hash_password, password)
        async with self.db.connection() as conn, conn.transaction():
            user, row = await self.state(conn, token, "recovery-proof")
            if not row:
                raise HTTPException(400, "验证凭证错误或已失效")
            await apply_password_locked(
                conn, SimpleNamespace(id=user["id"], token_hash=""), hashed, request_id
            )
        return {"ok": True, "reauthenticationRequired": True}
