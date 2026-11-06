import base64
import io
import secrets
from urllib.parse import quote, urlencode
from uuid import uuid4

import qrcode
from fastapi import HTTPException
from psycopg.types.json import Jsonb

from .native_identity import backup_hash, verify_totp
from .security import digest, lock_mutation_identity


class IdentityManagement:
    def __init__(self, settings, db, factors, passkeys):
        self.settings, self.db, self.factors, self.passkeys = settings, db, factors, passkeys

    async def status(self, who):
        async with self.db.connection() as conn:
            row = await (
                await conn.execute(
                    "SELECT totp_enabled,device_name,backup_codes FROM identity_security WHERE user_id=%s",
                    (who.id,),
                )
            ).fetchone()
        return {
            "enabled": bool(row and row["totp_enabled"]),
            "name": row["device_name"] if row and row["totp_enabled"] else "",
            "backupCodesRemaining": len(row["backup_codes"]) if row else 0,
        }

    def binding(self, who):
        # Native challenges survive token rotation but never cross grants.
        return "grant:" + who.grant_id if getattr(who, "native_client", False) else who.token_hash

    async def serialize(self, conn, who):
        await conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("identity-management:" + who.id,)
        )

    async def setup_identity(self, conn, who, password, *, stage_only=False, recent_allowed=False):
        await lock_mutation_identity(conn, who, require_admin=False)
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s FOR UPDATE", (who.id,))).fetchone()
        if stage_only:
            return user
        if recent_allowed:
            recent = await (
                await conn.execute(
                    "SELECT 1 FROM sessions WHERE token_hash=%s AND user_id=%s AND created_at>clock_timestamp()-interval '15 minutes' AND created_at<=clock_timestamp()",
                    (who.token_hash, who.id),
                )
            ).fetchone()
            if recent:
                return user
            if not password:
                raise HTTPException(403, "请重新验证身份", headers={"X-Alcor-Reauthentication": "required"})
        try:
            return await self.passkeys.step_up(conn, who, password, "")
        except HTTPException as exc:
            if recent_allowed and exc.status_code == 403:
                raise HTTPException(403, "请重新验证身份", headers={"X-Alcor-Reauthentication": "required"}) from None
            raise

    async def setup(self, data, who, *, stage_only=False):
        async with self.db.connection() as conn, conn.transaction():
            await self.serialize(conn, who)
            user = await self.setup_identity(conn, who, data.password, stage_only=stage_only)
            factor = await self.factors.factor(conn, who.id)
            if factor and factor["totp_enabled"]:
                raise HTTPException(409, "已经开启二次验证")
            secret = base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")
            token = secrets.token_urlsafe(24)
            await conn.execute(
                "DELETE FROM identity_challenges WHERE user_id=%s AND purpose='totp-setup'", (who.id,)
            )
            expiry = await (
                await conn.execute(
                    "INSERT INTO identity_challenges(id,purpose,user_id,binding,payload,expires_at) VALUES(%s,'totp-setup',%s,%s,%s,clock_timestamp()+interval '10 minutes') RETURNING expires_at",
                    (
                        digest(token),
                        who.id,
                        self.binding(who),
                        Jsonb(
                            {
                                "secret": self.factors.vault.encrypt(
                                    secret, "totp:" + who.id, self.settings.instance_id
                                ),
                                "password_stamp": digest(user["password_hash"]),
                                "session_version": user["session_version"],
                            }
                        ),
                    ),
                )
            ).fetchone()
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action) VALUES(%s,'identity.totp.setup')", (who.id,)
            )
        uri = (
            "otpauth://totp/"
            + quote("Alcor", safe="")
            + ":"
            + quote(who.username, safe="")
            + "?"
            + urlencode({"secret": secret, "issuer": "Alcor", "digits": 6, "period": 30})
        )
        output = io.BytesIO()
        qrcode.make(uri).save(output, format="PNG")
        return {
            "challengeId": token,
            "secret": secret,
            "otpauthUrl": uri,
            "qrPng": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode(),
            "expiresAt": int(expiry["expires_at"].timestamp() * 1000),
        }

    async def invalidate_others(self, conn, who):
        from .broker_position_transfers import purge_broker_position_transfer_previews
        await purge_broker_position_transfer_previews(conn, who.id)
        from .fund_sources import purge_fund_source_previews
        await purge_fund_source_previews(conn, who.id)
        await conn.execute(
            "DELETE FROM sessions WHERE user_id=%s AND token_hash<>%s", (who.id, who.token_hash)
        )
        await conn.execute(
            "UPDATE client_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE owner_id=%s",
            (who.id,),
        )
        await conn.execute(
            "DELETE FROM identity_challenges WHERE user_id=%s AND purpose='password-login'", (who.id,)
        )
        await conn.execute(
            "UPDATE identity_app_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE user_id=%s",
            (who.id,),
        )
        await conn.execute("UPDATE users SET revision=%s WHERE id=%s", (uuid4(), who.id))

    def codes(self):
        codes = [
            "-".join(value[i : i + 4] for i in range(0, 16, 4))
            for value in [secrets.token_hex(8) for _ in range(8)]
        ]
        key = secrets.token_bytes(32)
        return codes, key, [backup_hash(code, key) for code in codes]

    async def confirm(self, data, who, *, recent_allowed=False):
        result = None
        challenge_valid = False
        async with self.db.connection() as conn, conn.transaction():
            await self.serialize(conn, who)
            user = await self.setup_identity(conn, who, data.password, recent_allowed=recent_allowed)
            factor = await self.factors.factor(conn, who.id)
            if factor and factor["totp_enabled"]:
                raise HTTPException(409, "已经开启二次验证")
            pending = await (
                await conn.execute(
                    "SELECT *,expires_at>clock_timestamp() AS valid FROM identity_challenges WHERE id=%s AND purpose='totp-setup' AND user_id=%s AND binding=%s FOR UPDATE",
                    (digest(data.challengeId), who.id, self.binding(who)),
                )
            ).fetchone()
            if (
                pending
                and pending["valid"]
                and pending["attempts"] < 8
                and pending["payload"]["password_stamp"] == digest(user["password_hash"])
                and pending["payload"]["session_version"] == user["session_version"]
            ):
                challenge_valid = True
                await conn.execute(
                    "UPDATE identity_challenges SET attempts=attempts+1 WHERE id=%s",
                    (digest(data.challengeId),),
                )
                secret = self.factors.vault.decrypt(
                    pending["payload"]["secret"], "totp:" + who.id, self.settings.instance_id
                )
                step = verify_totp(secret, data.code)
                if step is not None:
                    codes, key, hashes = self.codes()
                    await conn.execute(
                        """INSERT INTO identity_security(user_id,totp_enabled,totp_secret_ciphertext,totp_last_step,backup_codes,backup_key_ciphertext,device_name) VALUES(%s,true,%s,%s,%s,%s,%s)
                        ON CONFLICT(user_id) DO UPDATE SET totp_enabled=true,totp_secret_ciphertext=excluded.totp_secret_ciphertext,totp_last_step=excluded.totp_last_step,backup_codes=excluded.backup_codes,backup_key_ciphertext=excluded.backup_key_ciphertext,device_name=excluded.device_name,source_stamp=NULL""",
                        (
                            who.id,
                            pending["payload"]["secret"],
                            step,
                            Jsonb(hashes),
                            self.factors.vault.encrypt(
                                key.hex(), "backup-key:" + who.id, self.settings.instance_id
                            ),
                            data.name,
                        ),
                    )
                    await conn.execute(
                        "DELETE FROM identity_challenges WHERE id=%s", (digest(data.challengeId),)
                    )
                    await self.invalidate_others(conn, who)
                    await conn.execute(
                        "UPDATE sessions SET auth_method='totp' WHERE token_hash=%s", (who.token_hash,)
                    )
                    await conn.execute(
                        "INSERT INTO audit_events(actor_id,action) VALUES(%s,'identity.totp.enabled')",
                        (who.id,),
                    )
                    result = {"ok": True, "enabled": True, "backupCodes": codes}
        if not result:
            if getattr(who, "native_client", False) and not challenge_valid:
                raise HTTPException(409, "设置已过期，请重新开始")
            raise HTTPException(400, "验证码不正确，或设置已过期")
        return result

    async def disable(self, data, who):
        async with self.db.connection() as conn, conn.transaction():
            await self.serialize(conn, who)
            await self.passkeys.step_up(conn, who, data.password, data.code)
            factor = await self.factors.factor(conn, who.id)
            if not factor or not factor["totp_enabled"]:
                raise HTTPException(409, "尚未开启二次验证")
            await conn.execute(
                "UPDATE identity_security SET totp_enabled=false,totp_secret_ciphertext=NULL,totp_last_step=-1,backup_codes='[]'::jsonb,backup_key_ciphertext=NULL,device_name='',source_stamp=NULL WHERE user_id=%s",
                (who.id,),
            )
            await conn.execute(
                "DELETE FROM identity_challenges WHERE user_id=%s AND purpose='totp-setup'", (who.id,)
            )
            await self.invalidate_others(conn, who)
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action) VALUES(%s,'identity.totp.disabled')", (who.id,)
            )
        return {"ok": True, "enabled": False}

    async def regenerate(self, data, who):
        async with self.db.connection() as conn, conn.transaction():
            await self.serialize(conn, who)
            await self.passkeys.step_up(conn, who, data.password, data.code)
            factor = await self.factors.factor(conn, who.id)
            if not factor or not factor["totp_enabled"]:
                raise HTTPException(409, "尚未开启二次验证")
            codes, key, hashes = self.codes()
            await conn.execute(
                "UPDATE identity_security SET backup_codes=%s,backup_key_ciphertext=%s WHERE user_id=%s",
                (
                    Jsonb(hashes),
                    self.factors.vault.encrypt(key.hex(), "backup-key:" + who.id, self.settings.instance_id),
                    who.id,
                ),
            )
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action) VALUES(%s,'identity.backup_codes.regenerated')",
                (who.id,),
            )
        return {"ok": True, "backupCodes": codes}
