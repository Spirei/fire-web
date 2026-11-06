"""Actual loopback HTTP/SMTP with synthetic recipients; no provider or real mailbox access."""

import json
import smtplib
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import ClassVar

import pytest
from alcor_api.notification_provider_protocols import ProviderRejected, send
from alcor_api.notification_provider_wire import Origin, Wire
from alcor_api.notification_smtp import Smtp


@pytest.fixture
def http_provider():
    class Handler(BaseHTTPRequestHandler):
        status = 200
        requests: ClassVar[list] = []

        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            self.requests.append((self.path, json.loads(body)))
            payload = json.dumps({"ok": True, "result": {"message_id": 123}}).encode()
            self.send_response(self.status)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Location", "https://unapproved.example/")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_port, Handler
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


async def permit():
    return True


async def test_pinned_real_http_receipt_and_no_paid_broadcast(http_provider):
    port, handler = http_provider
    wire = Wire({"api": Origin("http", "127.0.0.1", port, ("127.0.0.1",), ("/bot",), True)})
    receipt = await send(
        "telegram", {"botToken": "123456:" + "x" * 30}, "123456", "Synthetic isolated message", permit, wire
    )
    assert receipt.id == "123" and len(handler.requests) == 1
    assert handler.requests[0][1]["allow_paid_broadcast"] is False


async def test_http_redirect_never_opens_unapproved_origin(http_provider):
    port, handler = http_provider
    handler.status = 302
    wire = Wire({"api": Origin("http", "127.0.0.1", port, ("127.0.0.1",), ("/bot",), True)})
    with pytest.raises(ValueError, match="unconfirmed"):
        await send("telegram", {"botToken": "123456:" + "x" * 30}, "123456", "Synthetic", permit, wire)
    assert len(handler.requests) == 1


async def test_dns_pin_mismatch_is_rejected_before_http_connection(http_provider):
    port, handler = http_provider
    wire = Wire({"api": Origin("http", "127.0.0.1", port, ("192.0.2.20",), ("/bot",), True)})
    with pytest.raises(ValueError, match="address_not_approved"):
        await send("telegram", {"botToken": "123456:" + "x" * 30}, "123456", "Synthetic", permit, wire)
    assert handler.requests == []


@pytest.fixture
def smtp_provider():
    class Handler(socketserver.StreamRequestHandler):
        messages: ClassVar[list] = []
        commands: ClassVar[list] = []
        lose_acceptance = False
        reject_recipient = False

        def handle(self):
            self.wfile.write(b"220 isolated.smtp.test ESMTP\r\n")
            while True:
                raw = self.rfile.readline(65536)
                if not raw:
                    return
                command = raw.decode().strip()
                self.commands.append(command.split(" ", 1)[0])
                upper = command.upper()
                if upper.startswith("EHLO"):
                    self.wfile.write(b"250-isolated.smtp.test\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 65536\r\n")
                elif upper.startswith("AUTH"):
                    self.wfile.write(b"235 authenticated\r\n")
                elif upper.startswith("MAIL"):
                    self.wfile.write(b"250 sender accepted\r\n")
                elif upper.startswith("RCPT"):
                    self.wfile.write(
                        b"550 rejected\r\n" if self.reject_recipient else b"250 recipient accepted\r\n"
                    )
                elif upper == "DATA":
                    self.wfile.write(b"354 send message\r\n")
                    content = bytearray()
                    while True:
                        line = self.rfile.readline(65536)
                        if line == b".\r\n" or not line:
                            break
                        content.extend(line)
                    self.messages.append(bytes(content))
                    if self.lose_acceptance:
                        return
                    self.wfile.write(b"250 queued synthetic\r\n")
                elif upper == "QUIT":
                    self.wfile.write(b"221 bye\r\n")
                    return
                else:
                    self.wfile.write(b"250 reset\r\n")

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    server = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_address[1], Handler
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def smtp(port):
    return Smtp(
        {"host": "127.0.0.1", "port": port, "addresses": ["127.0.0.1"], "mode": "plain"},
        fixture=True,
        environment="test",
    )


SMTP = {"username": "synthetic-user", "password": "synthetic-secret", "fromEmail": "sender@example.test"}


async def test_actual_smtp_auth_probe_sends_no_message_then_acceptance_is_precise(smtp_provider):
    port, handler = smtp_provider
    provider = smtp(port)
    assert (await provider.perform(SMTP))["authenticated"]
    assert handler.messages == [] and "AUTH" in handler.commands
    receipt = await provider.perform(
        SMTP, "owner@example.test", "Synthetic isolated message", permit, "original-delivery-uuid"
    )
    assert receipt.id == "original-delivery-uuid" and len(handler.messages) == 1
    assert b"Message-ID: <original-delivery-uuid@alcor.invalid>" in handler.messages[0]


async def test_smtp_lost_acceptance_is_unknown_and_never_automatic_resend(smtp_provider):
    port, handler = smtp_provider
    handler.lose_acceptance = True
    with pytest.raises(smtplib.SMTPServerDisconnected):
        await smtp(port).perform(
            SMTP, "owner@example.test", "Synthetic isolated", permit, "one-delivery-only"
        )
    assert len(handler.messages) == 1


async def test_smtp_revoked_after_auth_sends_no_data(smtp_provider):
    port, handler = smtp_provider

    async def revoked():
        return False

    with pytest.raises(ProviderRejected):
        await smtp(port).perform(SMTP, "owner@example.test", "Synthetic isolated", revoked, "cancelled")
    assert handler.messages == [] and "MAIL" not in handler.commands


def test_plaintext_smtp_is_never_a_production_fallback():
    with pytest.raises(ValueError, match="plaintext"):
        Smtp({"host": "provider.example", "port": 25, "addresses": ["192.0.2.20"], "mode": "plain"})


async def test_pinned_json_preserves_original_utf16_boundary_surrogate_without_invalid_utf8(http_provider):
    port,handler=http_provider
    wire=Wire({'api':Origin('http','127.0.0.1',port,('127.0.0.1',),('/bot',),True)})
    # Actual JS .slice(0,1800) can end on this high surrogate; JSON escapes it.
    text='a'*1799+'\ud83d'
    result=await wire.call('api','POST','/botfixture',json_body={'content':text})
    assert result['ok']is True and handler.requests[0][1]['content']==text
