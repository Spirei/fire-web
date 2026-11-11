"""Use the existing approved source targets; no client URL or old-Web proxy."""

import asyncio
import ipaddress
import json
import os
import pwd
import sys
from dataclasses import asdict
from pathlib import Path
from urllib.parse import urlsplit

from .dividend_source_transport import fetch_page
from .dividend_sources import canonical, security
from .fx_provider_parser import approved_target
from .fx_provider_transport import resolve
from .market_contract import collection_purpose, installed_bar_semantics, installed_latest_semantics, installed_price_series_semantics


class Transport:
    fixture = False

    def __init__(self, db, targets=(), *, target_provider=None, controlled_http=None):
        self.db, self.targets, self.target_provider = (
            db,
            {target.id: target for target in targets},
            target_provider,
        )
        self.controlled_http = controlled_http or {}
        if self.controlled_http and db.settings.environment != "test":
            raise ValueError("controlled_source_outside_test")

    async def read(self, policy, query, cursor):
        if policy.fixture:
            if self.db.settings.environment != "test" or policy.id not in self.controlled_http:
                raise ValueError("fixture_source_unavailable")
            url, approval = self.controlled_http[policy.id]
            parsed = urlsplit(url)
            if (
                parsed.scheme != "http"
                or parsed.hostname not in {"127.0.0.1", "::1"}
                or not all(ipaddress.ip_address(address).is_loopback for address in approval["addresses"])
            ):
                raise ValueError("fixture_network_not_loopback")
            return await fetch_page(url, approval), "http_response_body"
        targets = (
            {target.id: target for target in self.target_provider()} if self.target_provider else self.targets
        )
        target = targets.get(policy.target_id)
        if target is None or target.fingerprint != policy.target_fingerprint:
            raise ValueError("source_target_unavailable")
        target.validate(self.db.settings.environment)
        if policy.source=='tencent':
            from .market_tencent_latest import VERSION,fetch,installed
            if policy.source_version!=VERSION or not installed(query)or 'latest'not in policy.purposes:raise ValueError('tencent_source_protocol_not_licensed')
            return await fetch(target,query,cursor)
        if policy.source=='coingecko':
            from .market_crypto_latest import VERSION,fetch,installed
            if (policy.source_version!=VERSION or not installed(query) or 'latest' not in policy.purposes
                    or 'ASSET' not in policy.markets):
                raise ValueError('crypto_source_protocol_not_installed')
            return await fetch(target,query,cursor)
        if policy.source == 'yahoo':
            from .market_yahoo_history import VERSION, fetch, installed
            if (policy.source_version != VERSION or not installed(query, policy)
                    or collection_purpose(query) not in policy.purposes or query.market not in policy.markets):
                raise ValueError('source_protocol_not_installed')
            return await fetch(target, query, cursor, policy)
        if target.source != 'futu':
            raise ValueError('source_target_unavailable')
        latest = installed_latest_semantics(query)
        history = (installed_bar_semantics(query) or installed_price_series_semantics(query)) and query.market in ("US", "HK", "CN")
        purpose = collection_purpose(query)
        if (
            policy.source != "futu"
            or not (latest or history)
            or (latest or history)
            and policy.source_version != "futu-sdk-records-v1"
            or not isinstance(policy.purposes, (tuple, list))
            or not isinstance(policy.markets, (tuple, list))
            or purpose not in policy.purposes
            or query.market not in policy.markets
        ):
            raise ValueError("source_protocol_not_installed")
        symbol = security("futu", query.market, query.code)
        approval = target.approval(symbol)
        url = f"{target.scheme}://{target.host}:{target.port}{target.path(symbol)}"
        approved_target(url, approval, approval["addresses"])
        pins = approved_target(url, approval, await resolve(target.host, target.port))
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-I",
            str(Path(__file__).with_name("market_futu_sdk.py")),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env={
                "PATH": "/usr/bin:/bin",
                "PYTHONIOENCODING": "utf-8",
                "HOME": pwd.getpwuid(os.getuid()).pw_dir,
            },
        )
        try:
            async with asyncio.timeout(12):
                payload = {
                    "action": "latest" if latest else "price_series" if query.kind == "price_series" else "history",
                    "host": pins[0],
                    "port": target.port,
                    "symbols": [symbol],
                    "query": asdict(query),
                    "cursor": cursor,
                }
                process.stdin.write(canonical(payload).encode())
                await process.stdin.drain()
                process.stdin.close()
                budget = 2 * 1024 * 1024 if query.kind == 'price_series' else 131072
                raw = await process.stdout.read(budget+1)
                if len(raw) > budget:
                    raise ValueError("sdk_response_too_large")
                await process.wait()
                if process.returncode != 0:
                    raise ValueError("sdk_unavailable_or_read_failed")
                json.loads(raw)
                return raw, "sdk_json_representation_not_wire_bytes"
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    async def diagnostic(self, policy, action):
        if (
            action not in {"futu.test", "futu.quota"}
            or policy.source != "futu"
            or policy.source_version != "futu-sdk-records-v1"
            or not isinstance(policy.purposes, (tuple, list))
            or action not in policy.purposes
        ):
            raise ValueError("diagnostic_purpose_not_approved")
        targets = (
            {target.id: target for target in self.target_provider()} if self.target_provider else self.targets
        )
        target = targets.get(policy.target_id)
        if target is None or target.source != "futu" or target.fingerprint != policy.target_fingerprint:
            raise ValueError("source_target_unavailable")
        target.validate(self.db.settings.environment)
        approval = target.approval("")
        url = f"{target.scheme}://{target.host}:{target.port}{target.path('')}"
        approved_target(url, approval, approval["addresses"])
        pins = approved_target(url, approval, await resolve(target.host, target.port))
        if (policy.fixture or target.fixture) and (
            self.db.settings.environment != "test"
            or any(not ipaddress.ip_address(address).is_loopback for address in pins)
        ):
            raise ValueError("diagnostic_fixture_not_loopback")
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-I",
            str(Path(__file__).with_name("market_futu_sdk.py")),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env={
                "PATH": "/usr/bin:/bin",
                "PYTHONIOENCODING": "utf-8",
                "HOME": pwd.getpwuid(os.getuid()).pw_dir,
            },
        )
        try:
            async with asyncio.timeout(30):
                process.stdin.write(
                    canonical({"action": action, "host": pins[0], "port": target.port,
                               "quoteProbe": action == "futu.test" and "latest" in policy.purposes and "US" in policy.markets}).encode()
                )
                await process.stdin.drain()
                process.stdin.close()
                raw = await process.stdout.read(65537)
                if len(raw) > 65536:
                    raise ValueError("diagnostic_response_too_large")
                await process.wait()
                if process.returncode != 0:
                    raise ValueError("sdk_unavailable_or_read_failed")
                current = (
                    {target.id: target for target in self.target_provider()}
                    if self.target_provider
                    else self.targets
                )
                if (
                    policy.target_id not in current
                    or current[policy.target_id].fingerprint != target.fingerprint
                ):
                    raise ValueError("source_target_changed")
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise TypeError("diagnostic_response_invalid")
                return value
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
