"""Public country catalog frozen from the reviewed legacy Node/ICU result.

Runtime locale upgrades cannot silently rename or reorder the legacy catalog.
The bundled file contains no user state and does not consult a data provider.
"""

import hashlib
from pathlib import Path

from fastapi import Response

CATALOG_PATH = Path(__file__).with_name("data") / "country_catalog.json"
CATALOG_SHA256 = "e2d85f9e6b50f33da13f0eb381156d3c12ab7e34d06295b1d3960e5837349f80"


def mount_country_catalog(app):
    raw = CATALOG_PATH.read_bytes()
    if hashlib.sha256(raw).hexdigest() != CATALOG_SHA256:
        raise ValueError("country_catalog_digest_mismatch")

    @app.get("/api/countries", tags=["legacy-public-reference"])
    async def countries():
        return Response(raw, media_type="application/json")
