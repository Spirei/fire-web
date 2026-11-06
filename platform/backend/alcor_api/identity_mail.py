"""Durable identity mail. SMTP uncertainty never becomes automatic redelivery."""

import asyncio
import hashlib
import json
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr
from uuid import uuid4

from fastapi import HTTPException

from .connections import Vault


def mail_configured(settings):
    return bool(settings.mail_enabled and settings.mail_host and settings.mail_sender)


class DeliveryRejected(Exception):
    """The transport conclusively rejected the message before acceptance."""


def smtp_send(settings, payload, message_id):
    message = EmailMessage()
    message["From"] = formataddr((getattr(settings, "mail_from_name", ""), settings.mail_sender))
    message["To"] = payload["recipient"]
    message["Subject"] = payload["subject"]
    message["Message-ID"] = f"<{message_id}@alcor.invalid>"
    message.set_content(payload["text"])
    context = ssl.create_default_context()
    client = smtplib.SMTP_SSL if settings.mail_tls == "tls" else smtplib.SMTP
    try:
        options = {"timeout": settings.mail_timeout}
        if settings.mail_tls == "tls":
            options["context"] = context
        with client(settings.mail_host, settings.mail_port, **options) as smtp:
            if settings.mail_tls == "starttls":
                smtp.starttls(context=context)
            if settings.mail_username:
                smtp.login(
                    settings.mail_username.get_secret_value(), settings.mail_password.get_secret_value()
                )
            smtp.send_message(message)
    except (
        smtplib.SMTPAuthenticationError,
        smtplib.SMTPRecipientsRefused,
        smtplib.SMTPSenderRefused,
        smtplib.SMTPDataError,
    ):
        raise DeliveryRejected() from None


class IdentityMail:
    def __init__(self, settings, db, *, transport=None, dynamic=False):
        self._settings, self.db, self.dynamic = settings, db, dynamic
        self.vault = Vault(settings.connection_secret_dir)
        self.transport = transport

    @property
    def settings(self):
        return self.db.settings if self.dynamic else self._settings

    async def refresh(self):
        if self.dynamic:
            async with self.db.connection():
                pass

    @property
    def configured(self):
        return mail_configured(self.settings)

    async def enqueue(
        self, conn, *, user_id, challenge_id, kind, recipient, text, expires_at, template_values=None
    ):
        if not self.configured:
            raise HTTPException(503, "邮件服务尚未配置")
        if await (
            await conn.execute("SELECT 1 FROM restore_quarantine WHERE category='external_delivery_disabled'")
        ).fetchone():
            raise HTTPException(503, "恢复副本的邮件发送已隔离")
        subject = "Alcor 账号验证"
        if template_values is not None:
            from .mail_templates import render_configured

            template_id = {
                "email-registration": "registration",
                "password-reset": "password_reset",
                "email-verification": "email_verification",
                "email-change": "email_change",
            }.get(kind)
            if template_id is None:
                raise HTTPException(422, "邮件用途不支持模板")
            rendered = await render_configured(
                conn, template_id, {**template_values, "email": recipient, "siteName": "Alcor"}
            )
            subject, text = rendered["subject"], rendered["text"]
        identifier = uuid4()
        content = json.dumps({"recipient": recipient, "subject": subject, "text": text}, ensure_ascii=False)
        ciphertext = self.vault.encrypt(
            content, "identity-mail:" + str(identifier), self.settings.instance_id
        )
        await conn.execute(
            "INSERT INTO identity_mail_outbox(id,user_id,challenge_id,kind,ciphertext,expires_at) VALUES(%s,%s,%s,%s,%s,%s)",
            (identifier, user_id, challenge_id, kind, ciphertext, expires_at),
        )
        return identifier

    async def deliver_one(self, worker_id):
        async with self.db.connection() as conn, conn.transaction():
            # Recovery is observational: a lost SMTP reply cannot prove failure.
            lost = await (
                await conn.execute(
                    "UPDATE identity_mail_outbox SET status='unknown',error_code='delivery_outcome_unknown',finished_at=clock_timestamp(),ciphertext=NULL,lease_until=NULL WHERE status='sending' AND lease_until<clock_timestamp() RETURNING challenge_id"
                )
            ).fetchall()
            for item in lost:
                await conn.execute("DELETE FROM identity_challenges WHERE id=%s", (item["challenge_id"],))
            await conn.execute(
                "UPDATE identity_mail_outbox o SET status='cancelled',error_code='challenge_unavailable',finished_at=clock_timestamp(),ciphertext=NULL WHERE status='queued' AND (expires_at<=clock_timestamp() OR NOT EXISTS (SELECT 1 FROM identity_challenges c WHERE c.id=o.challenge_id AND c.expires_at>clock_timestamp()))"
            )
            if (
                not self.configured
                or await (
                    await conn.execute(
                        "SELECT 1 FROM restore_quarantine WHERE category='external_delivery_disabled'"
                    )
                ).fetchone()
            ):
                return None
            row = await (
                await conn.execute(
                    "SELECT o.* FROM identity_mail_outbox o JOIN identity_challenges c ON c.id=o.challenge_id "
                    "WHERE o.status='queued' AND o.expires_at>clock_timestamp() AND c.expires_at>clock_timestamp() "
                    "ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED FOR SHARE OF c SKIP LOCKED"
                )
            ).fetchone()
            if not row:
                return None
            await conn.execute(
                "UPDATE identity_mail_outbox SET status='sending',lease_owner=%s,lease_until=clock_timestamp()+interval '5 minutes',started_at=clock_timestamp() WHERE id=%s",
                (worker_id, row["id"]),
            )
        status, error = "sent", None
        try:
            payload = json.loads(
                self.vault.decrypt(
                    row["ciphertext"], "identity-mail:" + str(row["id"]), self.settings.instance_id
                )
            )
            if self.transport:
                await self.transport(payload, str(row["id"]))
            else:
                snapshot = self.settings.model_copy(deep=True)
                policy = getattr(snapshot, "mail_delivery_policy", {})
                if policy:
                    from .notification_provider_protocols import ProviderRejected
                    from .notification_smtp import Smtp

                    def signature(settings):
                        fields = {
                            "policy": settings.mail_delivery_policy, "enabled": settings.mail_enabled,
                            "sender": settings.mail_sender, "name": settings.mail_from_name,
                            "username": settings.mail_username.get_secret_value() if settings.mail_username else "",
                            "password": settings.mail_password.get_secret_value() if settings.mail_password else "",
                        }
                        return hashlib.sha256(json.dumps(fields, sort_keys=True).encode()).hexdigest()

                    approved = signature(snapshot)

                    async def authorize():
                        async with self.db.connection() as conn, conn.transaction():
                            if not self.configured or signature(self.settings) != approved:
                                return False
                            if await (await conn.execute(
                                "SELECT 1 FROM restore_quarantine WHERE category='external_delivery_disabled'"
                            )).fetchone():
                                return False
                            return bool(await (await conn.execute(
                                "SELECT 1 FROM identity_mail_outbox o JOIN identity_challenges c ON c.id=o.challenge_id "
                                "WHERE o.id=%s AND o.status='sending' AND o.lease_owner=%s "
                                "AND o.expires_at>clock_timestamp() AND c.expires_at>clock_timestamp()",
                                (row["id"], worker_id),
                            )).fetchone())

                    try:
                        await Smtp(policy, environment=snapshot.environment).perform(
                            {"fromEmail": snapshot.mail_sender, "fromName": snapshot.mail_from_name,
                             "username": snapshot.mail_username.get_secret_value() if snapshot.mail_username else "",
                             "password": snapshot.mail_password.get_secret_value() if snapshot.mail_password else "",
                             "subject": payload["subject"]},
                            payload["recipient"], payload["text"], authorize, str(row["id"]),
                        )
                    except ProviderRejected as exc:
                        raise DeliveryRejected() from exc
                else:
                    await asyncio.to_thread(smtp_send, snapshot, payload, str(row["id"]))
        except DeliveryRejected:
            status, error = "failed", "delivery_rejected"
        except Exception:  # noqa: BLE001 -- arbitrary transport failure has an unknown delivery outcome
            status, error = "unknown", "delivery_outcome_unknown"
        # Cancellation/process death leaves sending durable; next worker marks
        # unknown after the lease and never resends this UUID.
        async with self.db.connection() as conn, conn.transaction():
            changed = await (
                await conn.execute(
                    "UPDATE identity_mail_outbox SET status=%s,error_code=%s,finished_at=clock_timestamp(),ciphertext=NULL,lease_until=NULL WHERE id=%s AND status='sending' AND lease_owner=%s RETURNING id",
                    (status, error, row["id"], worker_id),
                )
            ).fetchone()
            if changed and status in ("failed", "unknown"):
                await conn.execute("DELETE FROM identity_challenges WHERE id=%s", (row["challenge_id"],))
        return {"id": str(row["id"]), "status": status if changed else "unknown"}
