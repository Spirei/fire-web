import hashlib
import json
from pathlib import Path

import httpx
import test_personal_fonts as font_support
from alcor_api.font_codec import font_name
from font_fixtures import font_bytes
from test_personal_fonts import P

files = font_support.files

VECTORS = json.loads((Path(__file__).parent / "personal_font_candidate/legacy-golden.json").read_text())


def test_actual_old_ts_29_font_names_hashes_envelopes_and_quota_vectors():
    assert len(VECTORS) == 29
    for vector in VECTORS:
        raw = font_bytes(vector["extension"], vector["seed"])
        assert hashlib.sha256(raw).hexdigest() == vector["sha256"]
        ext, name = font_name(vector["filename"])
        assert ext == vector["extension"]
        if vector["oldStatus"] == 200:
            font = vector["oldBody"]["font"]
            assert font["id"] == "custom-7-" + vector["sha256"] + "." + ext
            if vector["key"] != "duplicate":
                assert name == font["name"]
        else:
            assert vector["key"] == "quota-20" and vector["oldBody"] == {"error": "最多上传 20 款字体"}


async def test_actual_legacy_cookie_four_formats_exact_shapes_and_generated_uuid_recovery(client, admin, app):
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as old:
        assert (
            await old.post("/api/auth/login", json={"username": "AdminOne", "password": "Synthetic9Pass"})
        ).status_code == 200
        for vector in VECTORS[:4]:
            raw = font_bytes(vector["extension"])
            response = await old.post(
                "/api/fonts", files={"file": (vector["filename"], raw, "application/octet-stream")}
            )
            assert response.status_code == vector["oldStatus"], response.text
            assert set(response.json()) == {"font"} and set(response.json()["font"]) == {"id", "name"}
            font = response.json()["font"]
            assert font["name"] == vector["oldBody"]["font"]["name"]
            assert font["id"].endswith("-" + vector["sha256"] + "." + vector["extension"])
            assert response.headers["x-alcor-request-id-mode"] == "generated_legacy"
            original = await client.get(P + "/operations/" + response.headers["x-alcor-request-id"])
            assert original.status_code == 200 and original.json()["font"]["id"] == font["id"]
            assert (await old.get("/uploads/fonts/" + font["id"])).content == raw
        listing = (await old.get("/api/fonts")).json()
        assert set(listing) == {"fonts"} and len(listing["fonts"]) == 4
        assert all(set(f) == {"id", "name"} for f in listing["fonts"])
        before = (await client.get(P)).json()["revision"]
        response = await old.post("/api/fonts", files={"file": ("无效.ttf", b"not-a-font")})
        assert response.status_code == 400 and set(response.json()) == {"error"}
        original = await client.get(P + "/operations/" + response.headers["x-alcor-request-id"])
        assert original.json()["state"] == "failed" and original.json()["revision"] == before
        denied = await old.get("/api/fonts", headers={"authorization": "Bearer invalid"})
        assert denied.status_code == 403 and set(denied.json()) == {"error"}
