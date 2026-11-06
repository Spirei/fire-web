"""Legacy clipboard route over explicit owner-installed host capability."""

import json
from uuid import UUID, uuid4

from fastapi import HTTPException, Request

from .card_preferences_protocol import card_member, wire_response
from .fx_provider_parser import unique
from .legacy_optional_credentials import credentials_present
from .local_host_clipboard import LocalHostClipboard
from .profile_http import bounded_body
from .security import COOKIE, digest, identity


def mount_local_host_clipboard(app, db):
    service = LocalHostClipboard(db)
    app.state.local_host_clipboard = service

    async def resolve_member(request):
        credentials_present(request, platform=True)
        # Explicit Authorization retains legacy priority; it cannot inherit a
        # separate browser cookie's host approval.
        if "authorization" in request.headers:
            return await card_member(request, db)
        if COOKIE in request.cookies:
            return await identity(request)
        return await card_member(request, db)

    async def member(request):
        try:
            return await resolve_member(request)
        except HTTPException as exc:
            if exc.status_code in (401,403):
                exc.headers={**(exc.headers or {}),"X-Alcor-Retire-Context":"true","Cache-Control":"no-store, private"}
            raise

    @app.get("/api/clipboard/capabilities", tags=["clipboard"])
    async def capabilities(request: Request):
        return wire_response(await service.capabilities(await member(request)),
            {"Cache-Control": "no-store, private", "Vary": "Cookie, Authorization"})

    @app.get("/api/clipboard/operations/{identifier}", tags=["clipboard"])
    async def receipt(identifier: UUID, request: Request):
        return wire_response(await service.receipt(await member(request), identifier),
            {"Cache-Control": "no-store, private", "Vary": "Cookie, Authorization"})

    @app.post("/api/clipboard", tags=["clipboard"])
    async def copy(request: Request):
        headers = {"Cache-Control": "no-store, private", "Vary": "Cookie, Authorization"}
        try:
            who = await member(request)
            address = request.client.host if request.client else "unknown"
            for key, maximum in (("clipboard:" + address, 10), ("clipboard-global", 30)):
                if not await app.state.rate_limit(db, digest(key), maximum, window_seconds=60):
                    raise HTTPException(429, "操作过于频繁，请稍后再试")

            def reject(_):
                raise ValueError("nonfinite")

            raw = json.loads(await bounded_body(request, 12 * 1024 * 1024 + 65536), parse_constant=reject, object_pairs_hook=unique)
            if not isinstance(raw, dict) or set(raw) - {"requestId", "image"}:
                raise HTTPException(400, "复制请求字段无效")
            generated = not raw.get("requestId")
            rid = UUID(raw["requestId"]) if not generated else uuid4()
            result = await service.copy(who, rid, raw.get("image"))
            return wire_response({**result, "legacyClientIdempotency": not generated}, headers)
        except (ValueError, TypeError, UnicodeError):
            return wire_response({"error": "复制请求格式无效"}, headers, 400)
        except HTTPException as exc:
            if exc.status_code in (401, 403):
                headers["X-Alcor-Retire-Context"] = "true"
            return wire_response({"error": str(exc.detail)}, headers, exc.status_code)
