"""Bound request memory before multipart or JSON parsing."""

import re

from fastapi import HTTPException


async def bounded_body(request, limit):
    chunks = []
    length = 0
    async for chunk in request.stream():
        length += len(chunk)
        if length > limit:
            raise HTTPException(413, "请求过大")
        chunks.append(chunk)
    request._body = b"".join(chunks)
    return request._body


def body_budget(path):
    if path == "/api/auth/personal-home":
        return 8 * 1024 * 1024 + 65536
    if path.startswith("/api/agent-runtime/"):
        return 1048576
    if path in {'/api/simple-app/tool/import', '/api/account/simple-ledger/tool/import'}:
        return 10 * 1024 * 1024 + 256 * 1024
    if path in {'/api/v1/simple-ledger', '/api/v2/simple-ledger', '/api/account/simple-ledger',
                '/api/simple-app/tool/export', '/api/account/simple-ledger/tool/export'}:
        return 2 * 1024 * 1024
    if path in {'/api/feed/profile/avatar', '/api/v1/feed/profile/avatar', '/api/v2/feed/profile/avatar'}:
        return 2 * 1024 * 1024 + 65536
    if path in {'/api/portfolio/record-imports/sources', '/api/records/import-image'}:
        return 16 * 1024 * 1024 + 65536
    if path in {'/api/v1/data/import', '/api/personal-data-transfer/preview'}:
        return 6 * 10 * 1024 * 1024 + 65536
    if path in {'/api/portfolio/record-imports/previews', '/api/records/import-apply'}:
        return 1024 * 1024
    if path == '/api/portfolio/record-imports/submissions':
        return 16384
    if path in {'/api/v1/orders/import','/api/trading/history/import/preview'}:
        return 16 * 1024 * 1024 + 65536
    if path == '/api/trading/history/import/submissions':
        return 16384
    if re.fullmatch(r"/api/v[12]/broker-accounts/ba-[a-f0-9]{24}/(?:bindings|unbindings)", path):
        return 512 * 1024
    if path in {"/api/account/broker-bindings/preview", "/api/client/broker-bindings/preview",
                "/api/account/broker-bindings/operations", "/api/client/broker-bindings/operations"}:
        return 512 * 1024
    if re.fullmatch(r"/api/(?:account|client)/broker-icons/ba-[a-f0-9]{24}", path) or re.fullmatch(
        r"/api/v[12]/broker-accounts/ba-[a-f0-9]{24}/icon", path
    ):
        return 2 * 1024 * 1024 + 16384
    if re.fullmatch(r"/api/v[12]/broker-accounts/ba-[a-f0-9]{24}/statements/preview", path):
        return 8 * 1024 * 1024 + 16384
    if path in {"/api/account/broker-statements/preview", "/api/client/broker-statements/preview"}:
        # XML is independently limited to 8MiB; JSON may escape every source byte.
        return 6 * 8 * 1024 * 1024 + 4096
    if path == "/api/admin/site-settings":
        return 65536
    if path in {'/api/admin/card-catalog/preview', '/api/admin/card-catalog/imports'}:
        return 12 * 1024 * 1024 + 65536
    if path in {"/api/financial-reports", "/api/v1/financial-reports"}:
        return 50 * 1024 * 1024 + 65536
    if path in {'/api/cards/tags', '/api/cards/holdings', '/api/cards/custom', '/api/account/card-catalog/custom'}:
        return 10 * 1024 * 1024 + 1
    if path == "/api/api-docs":
        return 512 * 1024 * 6 + 1024
    if path in {"/api/fonts", "/api/personal-fonts"}:
        return 10 * 1024 * 1024 + 65536
    if re.fullmatch(r"/api/(?:v[12]/)?watch-groups/[^/]+/icon", path):
        return 2 * 1024 * 1024 + 65536
    if path in {"/api/upload", "/api/admin/shared-assets/upload"}:
        return 21 * 1024 * 1024
    if path in {"/api/fire-settings", "/api/v1/fire-settings", "/api/v2/fire-settings"}:
        return 256 * 1024 + 4096
    if path in {"/api/admin/attachments", "/api/attachments"}:
        return 50 * 1024 * 1024 + 1024 * 1024
    # Exact upload paths only; JSON and unrelated routes retain the 64KiB ceiling.
    if path in {"/api/upload", "/api/v1/upload", "/api/v2/upload", "/api/client/profile/avatar"}:
        return 5 * 1024 * 1024 + 65536
    if path in {
        "/api/v1/personal-profile/background",
        "/api/v2/personal-profile/background",
        "/api/client/personal-profile/background",
        "/api/account/personal-profile/background",
    }:
        return 8 * 1024 * 1024 + 16384
    if path in {"/api/resource-library/files", "/api/client/resource-library/files", "/api/v1/resource-library/files", "/api/v2/resource-library/files"}:
        return 50 * 1024 * 1024 + 65536
    if path in {"/api/v2/app-state", "/api/client/account/state", "/api/account/state"}:
        return 1024 * 1024
    return 65536


async def profile_limits(request, db, who, rate_limit):
    from .security import digest

    address = request.client.host if request.client else "unknown"
    for key, maximum in (
        (digest("profile:" + address + ":" + who.id), 30),
        ("profile-account:" + who.id, 30),
        ("profile-global", 300),
    ):
        if not await rate_limit(db, key, maximum, window_seconds=3600):
            raise HTTPException(429, "操作过于频繁，请稍后再试")
