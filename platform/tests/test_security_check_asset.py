"""Old security-check image is a bundled SVG, public, and independent of uploads."""

import hashlib

import pytest
from alcor_api.system_asset_api import SECURITY_CHECK_SVG

SOURCE_SHA256 = "85f1df98b30383dcbdc98acbc4fbfef3e6c58ff67c3cddec874ffef4da27a8d5"


@pytest.mark.asyncio
async def test_security_check_serves_the_bundled_svg_without_a_login(client):
    assert hashlib.sha256(SECURITY_CHECK_SVG).hexdigest() == SOURCE_SHA256
    for path in (
        "/api/system-assets/security-check",
        "/api/system-assets/security-check?v=1",
    ):
        response = await client.get(path)
        assert response.status_code == 200, response.text
        assert response.content == SECURITY_CHECK_SVG
        assert response.headers["content-type"] == "image/svg+xml; charset=utf-8"
        assert response.headers["cache-control"] == "public, max-age=0, must-revalidate"
        assert response.headers["x-content-type-options"] == "nosniff"
    bearer = await client.get(
        "/api/system-assets/security-check",
        headers={"Authorization": "Bearer invalid"},
    )
    assert bearer.status_code == 200 and bearer.content == SECURITY_CHECK_SVG
    for path in ("/api/system-assets/passkey", "/api/system-assets/mail-banner"):
        missing = await client.get(path)
        assert missing.status_code == 200
        assert missing.headers["content-type"] == "image/png"
        assert missing.content.startswith(b"\x89PNG\r\n\x1a\n")
        assert "no-store" in missing.headers["cache-control"]
