"""Pinned SMTP with the platform's acceptance/unknown semantics, separate business payloads."""

import asyncio
import smtplib
import socket
import ssl
import threading
from email.message import EmailMessage
from email.utils import formataddr

from .fx_provider_transport import resolve
from .notification_provider_protocols import ProviderReceipt, ProviderRejected, recipient


class Smtp:
    def __init__(self, policy, *, fixture=False, environment="production", factory=None):
        self.policy, self.factory = policy, factory
        if factory is not None and environment != "test":
            raise ValueError("fixture_smtp_factory_outside_test")
        if policy.get("mode") not in {"tls", "starttls", "plain"} or not policy.get("addresses"):
            raise ValueError("smtp_policy_invalid")
        if policy["mode"] == "plain" and not (fixture and environment == "test"):
            raise ValueError("plaintext_smtp_not_approved")

    async def perform(self, config, destination=None, content=None, authorize=None, request_id=None):
        host, port = self.policy["host"], self.policy["port"]
        pins = await resolve(host, port)
        if not pins or not set(pins) <= set(self.policy["addresses"]):
            raise ProviderRejected("smtp_address_not_approved")
        if destination is not None and (
            not recipient("email", destination) or not recipient("email", config["fromEmail"])
        ):
            raise ProviderRejected("smtp_recipient_invalid")
        loop, cancelled = asyncio.get_running_loop(), threading.Event()
        policy, mode = self.policy, self.policy["mode"]
        context = ssl.create_default_context()

        class Plain(smtplib.SMTP):
            def _get_socket(self, actual_host, actual_port, timeout):
                if (actual_host, actual_port) != (host, port):
                    raise ProviderRejected("smtp_target_changed")
                return socket.create_connection((pins[0], port), timeout)

        class Secure(smtplib.SMTP_SSL):
            def _get_socket(self, actual_host, actual_port, timeout):
                if (actual_host, actual_port) != (host, port):
                    raise ProviderRejected("smtp_target_changed")
                return context.wrap_socket(
                    socket.create_connection((pins[0], port), timeout), server_hostname=host
                )

        def run():
            factory = self.factory or (Secure if mode == "tls" else Plain)
            with factory(host, port, timeout=10) as smtp:
                smtp.ehlo()
                if mode == "starttls":
                    smtp.starttls(context=context)
                    smtp.ehlo()
                if config["username"]:
                    smtp.login(config["username"], config["password"])
                if destination is None:
                    return {"authenticated": True, "mode": policy["mode"]}
                if (
                    cancelled.is_set()
                    or authorize is None
                    or not asyncio.run_coroutine_threadsafe(authorize(), loop).result(timeout=5)
                ):
                    raise ProviderRejected("authorization_revoked")
                message = EmailMessage()
                message["From"], message["To"] = formataddr((config.get("fromName", ""), config["fromEmail"])), destination
                message["Subject"] = config.get("subject", "Alcor 通知")
                message["Message-ID"] = "<" + str(request_id) + "@alcor.invalid>"
                message.set_content(content)
                refused = smtp.send_message(message, from_addr=config["fromEmail"], to_addrs=[destination])
                if refused:
                    raise ProviderRejected("smtp_recipient_rejected")
                return ProviderReceipt(str(request_id), "smtp")

        try:
            async with asyncio.timeout(25):
                return await asyncio.to_thread(run)
        except (
            smtplib.SMTPAuthenticationError,
            smtplib.SMTPRecipientsRefused,
            smtplib.SMTPSenderRefused,
            smtplib.SMTPDataError,
        ):
            raise ProviderRejected("smtp_rejected") from None
        finally:
            cancelled.set()
