"""Instance-installed exact origins/IP pins; no URL can be introduced by an owner request."""

import asyncio
import json
from dataclasses import dataclass
from urllib.parse import urlencode

import httpcore

from .fx_provider_parser import approved_target, unique
from .fx_provider_transport import PinnedBackend, resolve
from .notification_provider_protocols import ProviderRejected


@dataclass(frozen=True)
class Origin:
    scheme: str
    host: str
    port: int
    addresses: tuple
    allowed_prefixes: tuple
    allow_plaintext: bool = False


class JsonResponse(dict):
    def __init__(self, value, raw):
        super().__init__(value)
        self.raw = raw


class Wire:
    def __init__(self, origins):
        self.origins = origins

    async def call(self, label, method, path, *, json_body=None, headers=None, query=None):
        origin = self.origins.get(label)
        if (
            origin is None
            or method not in {"GET", "POST"}
            or not path.startswith("/")
            or "?" in path
            or "#" in path
            or not any(path.startswith(prefix) for prefix in origin.allowed_prefixes)
        ):
            raise ProviderRejected("target_not_approved")
        authority = (
            origin.host
            if origin.port == (443 if origin.scheme == "https" else 80)
            else f"{origin.host}:{origin.port}"
        )
        url = f"{origin.scheme}://{authority}{path}" + ("?" + urlencode(query) if query else "")
        approval = {
            "target": [origin.scheme, origin.host, origin.port, path],
            "addresses": list(origin.addresses),
            "allow_plaintext": origin.allow_plaintext,
        }
        approved_target(url, approval, approval["addresses"])
        async with asyncio.timeout(15):
            pins = approved_target(url, approval, await resolve(origin.host, origin.port))
            backend = PinnedBackend(origin.host, origin.port, pins[0])
            payload = (
                json.dumps(json_body, ensure_ascii=True, allow_nan=False).encode()
                if json_body is not None
                else None
            )
            if payload is not None and len(payload) > 16384:
                raise ValueError("provider_payload_too_large")
            request_headers = {"Content-Type": "application/json", **(headers or {})}
            async with (
                httpcore.AsyncConnectionPool(network_backend=backend, retries=0, max_connections=1) as pool,
                pool.stream(
                    method,
                    url,
                    headers=request_headers,
                    content=payload,
                    extensions={"timeout": {"connect": 5, "read": 5, "write": 5, "pool": 5}},
                ) as response,
            ):
                # A redirect never expands the approved target. Ambiguous server failures stay unknown.
                if 400 <= response.status < 500:
                    raise ProviderRejected("provider_rejected")
                if response.status != 200:
                    raise ValueError("provider_outcome_unconfirmed")
                raw = bytearray()
                async for chunk in response.aiter_stream():
                    raw.extend(chunk)
                    if len(raw) > 65536:
                        raise ValueError("provider_response_too_large")
                result = json.loads(raw, object_pairs_hook=unique)
                if not isinstance(result, dict):
                    raise ValueError("provider_response_invalid")  # noqa: TRY004
                return JsonResponse(result, bytes(raw))
