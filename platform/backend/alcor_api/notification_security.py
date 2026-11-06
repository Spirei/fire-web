"""Purpose-bound current-password/factor proofs and existing platform Vault authority."""

import hashlib
import hmac
import json
import os
import stat
from pathlib import Path
from uuid import UUID, uuid4

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException

from .connections import Vault
from .identity_passkeys import Passkeys
from .identity_service import IdentityService


def principal(who):
    return str(getattr(who, "grant_id", None) or "web:" + who.token_hash)


class NotificationSecurity:
    def __init__(self, db):
        self.db = db
        self.vault = Vault(db.settings.connection_secret_dir)
        self.factors = IdentityService(db.settings, db)
        self.passkeys = Passkeys(db.settings, db, self.factors)

    def existing_key(self):
        # GET/restore paths must not create a replacement key for ciphertext they cannot open.
        try:
            root = Path(self.db.settings.connection_secret_dir)
            if root.is_symlink() or root.stat().st_mode & 0o077:
                raise ValueError()
            descriptor = os.open(root / "connections.key", os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor, "rb") as file:
                info = os.fstat(file.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
                    raise ValueError()
                key = file.read(128)
                Fernet(key)
                return key
        except (OSError, TypeError, ValueError):
            raise HTTPException(503, "通知凭据密钥不可用，请重新核对配置") from None

    def mac(self, value, *, create=False):
        key = self.vault.key() if create else self.existing_key()
        return hmac.new(
            key,
            json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode(),
            hashlib.sha256,
        ).hexdigest()

    def encrypt(self, value, kind):
        return self.vault.encrypt(value, "business-notification:" + kind, self.db.settings.instance_id)

    def decrypt(self, ciphertext, kind):
        try:
            payload = json.loads(Fernet(self.existing_key()).decrypt(ciphertext.encode()))
            if payload["kind"] != "business-notification:" + kind or payload["instance"] != str(
                self.db.settings.instance_id
            ):
                raise ValueError()
            return payload["password"]
        except (InvalidToken, ValueError, TypeError, KeyError):
            raise HTTPException(503, "通知凭据与当前实例不匹配，请重新核对") from None

    async def identity_stamp(self, conn, who):
        row = await (
            await conn.execute(
                "SELECT u.password_hash,u.session_version,s.totp_enabled,s.totp_secret_ciphertext FROM users u LEFT JOIN identity_security s ON s.user_id=u.id WHERE u.id=%s",
                (who.id,),
            )
        ).fetchone()
        return self.mac(
            [
                who.id,
                row["password_hash"],
                row["session_version"],
                row["totp_enabled"],
                row["totp_secret_ciphertext"],
            ]
        )

    async def verify(self, who, raw):
        if (
            not isinstance(raw, dict)
            or raw.keys() != {"operation", "currentPassword", "code"}
            or not isinstance(raw["operation"], dict)
            or not isinstance(raw["currentPassword"], str)
            or not isinstance(raw["code"], str)
        ):
            raise HTTPException(400, "通知安全确认参数无效")
        if len(raw["currentPassword"]) > 128 or len(raw["code"]) > 64:
            raise HTTPException(400, "通知安全确认参数无效")
        async with self.db.connection() as conn, conn.transaction():
            await self.passkeys.serialize(conn, who)
            directory = self.db.settings.connection_secret_dir
            if directory is None:
                raise HTTPException(503, "凭据存储尚未配置")
            if not (Path(directory) / "connections.key").is_file():
                existing = await (
                    await conn.execute("""SELECT EXISTS(SELECT 1 FROM business_notification_provider_revisions)
                    OR EXISTS(SELECT 1 FROM identity_security WHERE COALESCE(totp_secret_ciphertext,'')<>'' OR COALESCE(backup_key_ciphertext,'')<>'')
                    OR EXISTS(SELECT 1 FROM connection_settings WHERE COALESCE(password_ciphertext,'')<>'')
                    OR EXISTS(SELECT 1 FROM identity_mail_outbox WHERE ciphertext IS NOT NULL) AS sealed""")
                ).fetchone()
                if existing["sealed"]:
                    raise HTTPException(503, "已有加密凭据的原密钥缺失，不能生成替代密钥")
            await self.passkeys.step_up(conn, who, raw["currentPassword"], raw["code"])
            operation_mac = self.mac(raw["operation"], create=True)
            identifier = uuid4()
            row = await (
                await conn.execute(
                    """INSERT INTO business_notification_security_proofs(id,owner_id,principal,operation_mac,identity_stamp,expires_at)
                VALUES(%s,%s,%s,%s,%s,clock_timestamp()+interval '5 minutes') RETURNING expires_at""",
                    (identifier, who.id, principal(who), operation_mac, await self.identity_stamp(conn, who)),
                )
            ).fetchone()
            await conn.execute(
                "INSERT INTO audit_events(actor_id,action,target_id) VALUES(%s,'notification.security.verified',%s)",
                (who.id, str(identifier)),
            )
            return {"proofId": str(identifier), "expiresAt": int(row["expires_at"].timestamp() * 1000)}

    async def consume(self, conn, who, operation, proof):
        try:
            proof = UUID(proof)
        except (TypeError, ValueError, AttributeError):
            raise HTTPException(428, "请确认当前密码及已启用的二次验证") from None
        row = await (
            await conn.execute(
                """SELECT * FROM business_notification_security_proofs WHERE id=%s AND owner_id=%s
            AND principal=%s AND used_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE""",
                (proof, who.id, principal(who)),
            )
        ).fetchone()
        if (
            not row
            or not hmac.compare_digest(row["operation_mac"], self.mac(operation))
            or not hmac.compare_digest(row["identity_stamp"], await self.identity_stamp(conn, who))
        ):
            raise HTTPException(409, "通知确认已变化、过期或不属于当前操作")
        await conn.execute(
            "UPDATE business_notification_security_proofs SET used_at=clock_timestamp() WHERE id=%s", (proof,)
        )
