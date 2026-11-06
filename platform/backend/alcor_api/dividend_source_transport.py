"""Explicit read-only network boundaries; no settings, accounts, retries or redirects."""

import asyncio
import json
import os
import pwd
import sys
from pathlib import Path
from urllib.parse import urlsplit

import httpcore

from .dividend_sources import LIMIT, canonical, request
from .fx_provider_parser import approved_target
from .fx_provider_transport import PinnedBackend, resolve


class ResponseFailure(ValueError):
    def __init__(self, raw, status, complete=True):
        super().__init__("provider_http_or_size_error")
        self.raw, self.status, self.complete = raw, status, complete


async def fetch_page(url, approval):
    """Pinned origin, no redirect or automatic retry; retain bounded non-200 bytes."""
    parsed = urlsplit(url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    approved_target(url, approval, approval["addresses"])
    async with asyncio.timeout(15):
        pins = approved_target(url, approval, await resolve(parsed.hostname, port))
        backend = PinnedBackend(parsed.hostname, port, pins[0])
        async with (
            httpcore.AsyncConnectionPool(network_backend=backend, retries=0, max_connections=1) as pool,
            pool.stream(
                "GET", url, extensions={"timeout": {"connect": 5, "read": 5, "write": 5, "pool": 5}}
            ) as response,
        ):
            raw = bytearray()
            async for chunk in response.aiter_stream():
                raw.extend(chunk)
                if len(raw) > LIMIT:
                    raise ResponseFailure(bytes(raw[:LIMIT]), response.status, False)
            if response.status != 200:
                raise ResponseFailure(bytes(raw), response.status)
            return bytes(raw)


class Transport:
    async def read(self, target, config, cursor):
        payload = request(target, config, cursor)
        if target.source != "futu":
            return await fetch_page(payload["url"], payload["approval"]), "http_response_body"
        # Validate every DNS result then pass only an approved IP to the SDK child.
        approval = target.approval(payload["symbol"])
        address_url = f"{target.scheme}://{target.host}:{target.port}{target.path(payload['symbol'])}"
        approved_target(address_url, approval, approval["addresses"])
        pins = approved_target(address_url, approval, await resolve(target.host, target.port))
        # The SDK speaks the OpenD native protocol, not HTTP. Its representation is labeled accurately.
        # A process boundary is used so a hung SDK can be killed, rather than leaving a thread connected.
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-I",
            str(Path(__file__).with_name("dividend_futu_sdk.py")),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env={"PATH": "/usr/bin:/bin", "PYTHONIOENCODING": "utf-8", "HOME": pwd.getpwuid(os.getuid()).pw_dir},
        )
        try:
            async with asyncio.timeout(12):
                proc.stdin.write(
                    canonical({"host": pins[0], "port": target.port, "symbol": payload["symbol"]}).encode()
                )
                await proc.stdin.drain()
                proc.stdin.close()
                raw = await proc.stdout.read(LIMIT + 1)
                if len(raw) > LIMIT:
                    raise ValueError("response_too_large")
                await proc.wait()
                if proc.returncode != 0:
                    raise ValueError("futu_sdk_unavailable_or_failed")
                # JSON validation also refuses SDK logs mixed into stdout.
                json.loads(raw)
                return raw, "sdk_json_representation_not_wire_bytes"
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()


def safe_error(exc):
    # Never place exception text, vendor bodies, URLs or SDK logs into public receipts.
    if isinstance(exc, TimeoutError):
        return "source_timeout"
    if isinstance(exc, ValueError) and str(exc) in {
        "target_approval_revoked",
        "source_access_unapproved",
        "source_rate_budget",
        "source_pagination_changed",
        "source_pagination_count_mismatch",
        "source_duplicates",
        "source_config_changed",
        "source_disabled",
        "restore_quarantined",
    }:
        return str(exc)
    return "source_transport_or_contract_failed"
