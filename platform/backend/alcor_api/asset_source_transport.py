"""Single pinned asset-provider GET. Caller owns durable admission and originals."""

import asyncio
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpcore

from .asset_source_protocol import ICON_LIMIT, LIMIT, Request, validate_request
from .fx_provider_parser import approved_target
from .fx_provider_transport import PinnedBackend, resolve


@dataclass(frozen=True)
class Response:
    raw: bytes
    status: int
    complete: bool
    representation: str
    url: str
    metadata: dict


class Transport:
    async def read(self, target, request: Request):
        """Exactly one IO after the caller has persisted admission; never retry."""
        validate_request(target, request)
        parsed = urlsplit(request.url)
        host = parsed.hostname
        approval = {
            "target": ["https", host, 443, parsed.path],
            "addresses": target["addresses"][host],
            "allow_plaintext": False,
        }
        approved_target(request.url, approval, approval["addresses"])
        headers = {
            "User-Agent": target.get("userAgent", "AlcorAssetSources/1"),
            "Accept-Encoding": "identity",
            "Accept": "image/*,application/octet-stream"
            if request.representation == "image_http_response_body"
            else "application/json,text/html;q=0.9,*/*;q=0.8",
        }
        if request.provider == "eastmoney":
            headers["Referer"] = "https://quote.eastmoney.com/"
        limit = ICON_LIMIT if request.representation == "image_http_response_body" else LIMIT
        async with asyncio.timeout(18):
            pins = approved_target(request.url, approval, await resolve(host, 443))
            async with (
                httpcore.AsyncConnectionPool(
                    network_backend=PinnedBackend(host, 443, pins[0]), retries=0, max_connections=1
                ) as pool,
                pool.stream(
                    "GET",
                    request.url,
                    headers=headers,
                    extensions={"timeout": {"connect": 5, "read": 10, "write": 5, "pool": 5}},
                ) as response,
            ):
                metadata = {
                    k.decode("ascii").lower(): v.decode("latin1")
                    for k, v in response.headers
                    if k.lower()
                    in {b"content-type", b"content-encoding", b"date", b"content-length", b"location"}
                }
                # Redirect locations are retained as evidence; no follow-up IO.
                raw = bytearray()
                async for chunk in response.aiter_stream():
                    remaining = limit - len(raw)
                    raw.extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        return Response(
                            bytes(raw), response.status, False, request.representation, request.url, metadata
                        )
                return Response(
                    bytes(raw),
                    response.status,
                    metadata.get("content-encoding", "identity") == "identity",
                    request.representation,
                    request.url,
                    metadata,
                )
