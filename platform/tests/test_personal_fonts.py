import asyncio
import hashlib
import struct
from uuid import uuid4

import httpx
import pytest
import pytest_asyncio
from alcor_api.cli import create_user
from alcor_api.font_codec import LIMIT
from alcor_api.resource_media import ResourceMedia
from font_fixtures import font_bytes

P = "/api/personal-fonts"


@pytest_asyncio.fixture(autouse=True)
async def files(settings, tmp_path):
    settings.file_root = tmp_path / "personal-fonts"
    settings.asset_root = None
    settings.legacy_source_registry_path = None
    settings.resource_import_registry_path = None
    settings.attachment_import_registry_path = None
    settings.watch_group_import_registry_path = None
    settings.watch_group_icon_import_registry_path = None


async def upload(client, raw=None, name="Fixture.ttf", revision=None, rid=None, path=P):
    revision = (await client.get(P)).json()["revision"] if revision is None else revision
    body = {"requestId": rid or str(uuid4()), "expectedRevision": str(revision)}
    response = await client.post(
        path,
        data=body,
        files={"file": (name, font_bytes() if raw is None else raw, "application/octet-stream")},
    )
    return response, body


@pytest.mark.parametrize("ext", ["ttf", "otf", "woff", "woff2"])
async def test_four_real_decoded_formats_private_original_range_receipt_and_dedup_first_name(
    client, admin, app, settings, ext
):
    raw = font_bytes(ext)
    response, body = await upload(client, raw, "首名." + ext)
    assert response.status_code == 200, response.text
    value = response.json()
    font = value["font"]
    assert font["sha256"] == hashlib.sha256(raw).hexdigest()
    assert font["mediaType"] == "font/" + ext
    assert font["id"].startswith("custom-") and font["id"].endswith("-" + font["sha256"] + "." + ext)
    for path in [
        font["contentPath"],
        font["originalPath"],
        "/uploads/fonts/" + font["id"],
        "/api/upload-files/fonts/" + font["id"],
    ]:
        served = await client.get(path)
        assert served.status_code == 200 and served.content == raw
        assert "no-store" in served.headers["cache-control"]
        assert served.headers["etag"] == '"' + font["sha256"] + '"'
        assert (await client.get(path, headers={"range": "bytes=-17"})).content == raw[-17:]
        assert (await client.get(path, headers={"range": "bytes=0-3"})).content == raw[:4]
        assert (await client.get(path, headers={"range": "bytes=99999999-"})).status_code == 416
    assert (await client.get(font["originalPath"])).headers["content-type"] == "application/octet-stream"
    repeat, _ = await upload(
        client, raw, "首名." + ext, revision=int(body["expectedRevision"]), rid=body["requestId"]
    )
    assert repeat.json() == value
    other, _ = await upload(client, raw, "不替换首名." + ext)
    assert other.status_code == 200 and other.json()["font"]["name"] == "首名"
    assert other.json()["deduplicated"] is True and other.json()["revision"] == value["revision"]
    assert (await client.get(P + "/operations/" + body["requestId"])).json() == value
    conflict, _ = await upload(
        client, raw, "其他名." + ext, revision=int(body["expectedRevision"]), rid=body["requestId"]
    )
    assert conflict.status_code == 409
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as anonymous:
        for path in [font["contentPath"], "/uploads/fonts/" + font["id"]]:
            assert (await anonymous.get(path)).status_code == 401
    async with app.state.db.connection() as conn:
        assert (
            await (
                await conn.execute("SELECT count(*) n FROM personal_fonts WHERE owner_id=%s", (admin,))
            ).fetchone()
        )["n"] == 1
        assert (await (await conn.execute("SELECT count(*) n FROM admin_attachment_objects")).fetchone())[
            "n"
        ] == 0
        assert (await (await conn.execute("SELECT count(*) n FROM resource_files")).fetchone())["n"] == 0
        await ResourceMedia(settings).reconcile_orphans(conn)
    assert (settings.file_root / "resource-media" / font["sha256"]).read_bytes() == raw


async def test_owner_role_csrf_session_and_test_uid_boundaries(client, admin, app, settings):
    first, _ = await upload(client)
    font = first.json()["font"]
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as other:
        await create_user(settings, "FontMember", "OtherSynthetic9", role="user")
        login = await other.post(
            "/api/session/login", json={"login": "FontMember", "password": "OtherSynthetic9"}
        )
        other.headers["x-csrf-token"] = login.json()["csrf"]
        for path in [
            font["contentPath"],
            font["originalPath"],
            "/uploads/fonts/" + font["id"],
            P + "/operations/" + first.json()["requestId"],
        ]:
            assert (await other.get(path)).status_code == 404
        assert (await other.get(P)).json()["fonts"] == []
        own, _ = await upload(other)
        assert own.status_code == 200 and own.json()["font"]["id"] != font["id"]
        denied, _ = await upload(other, name="Bad.ttf", path=P + "?ignored=1")
        assert denied.status_code == 400
        assert (await other.get(P, headers={"authorization": "Bearer invalid"})).status_code == 403
        assert (await other.get(font["contentPath"], headers={"x-csrf-token": "foreign"})).status_code == 403
        response = await other.post(
            P,
            data={"requestId": str(uuid4()), "expectedRevision": "1"},
            files={"file": ("Bad.ttf", font_bytes())},
            headers={"x-csrf-token": "invalid"},
        )
        assert response.status_code == 403
    await create_user(settings, "FontNoUid", "OtherSynthetic9", role="user", is_test=True)
    login = await client.post(
        "/api/session/login", json={"login": "FontNoUid", "password": "OtherSynthetic9"}
    )
    client.headers["x-csrf-token"] = login.json()["csrf"]
    blocked, _ = await upload(client)
    assert blocked.status_code == 409 and "UID" in blocked.text
    assert (await client.get(P)).json()["fonts"] == []


async def test_cas_concurrency_quota_and_explicit_original_close(client, admin, app):
    raw = font_bytes()
    a, b = await asyncio.gather(
        upload(client, raw, revision=0), upload(client, font_bytes(seed=1), revision=0)
    )
    assert sorted([a[0].status_code, b[0].status_code]) == [200, 409]
    for response, body in [a, b]:
        assert (await client.get(P + "/operations/" + body["requestId"])).json() == response.json()
    before = (await client.get(P)).json()
    identifier = str(uuid4())
    assert (await client.get(P + "/operations/" + identifier)).status_code == 404
    closed = await client.post(P + "/operations/" + identifier + "/close", json={"expectedKind": "upload"})
    assert closed.status_code == 200 and closed.json()["canceled"]
    late, _ = await upload(client, font_bytes(seed=3), rid=identifier, revision=before["revision"])
    assert late.json() == closed.json() and late.status_code == 409
    assert (await client.get(P)).json() == before
    successful = a if a[0].status_code == 200 else b
    completed = await client.post(
        P + "/operations/" + successful[1]["requestId"] + "/close", json={"expectedKind": "upload"}
    )
    assert completed.json() == successful[0].json()
    for seed in range(10, 29):
        response, _ = await upload(client, font_bytes(seed=seed))
        assert response.status_code == 200, response.text
    assert len((await client.get(P)).json()["fonts"]) == 20
    rejected, body = await upload(client, font_bytes(seed=30))
    assert rejected.status_code == 400 and "20" in rejected.text
    assert (await client.get(P + "/operations/" + body["requestId"])).json() == rejected.json()
    duplicate = successful[0].json()["font"]
    response, _ = await upload(client, raw if successful is a else font_bytes(seed=1), name="same.ttf")
    assert response.status_code == 200 and response.json()["font"] == duplicate
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM personal_fonts")).fetchone())["n"] == 20


async def test_exact_ten_mib_actual_font_rejects_extension_spoof_truncation_bombs_and_records_failure(
    client, admin
):
    raw = font_bytes(size=LIMIT)
    response, _ = await upload(client, raw)
    assert response.status_code == 200, response.text
    assert (await client.get(response.json()["font"]["originalPath"])).content == raw
    over, body = await upload(client, raw + b"x")
    assert over.status_code == 413
    assert (await client.get(P + "/operations/" + body["requestId"])).json() == over.json()
    for raw, name in [
        (font_bytes(), "fake.otf"),
        (font_bytes("woff2")[:-2], "truncated.woff2"),
        (b"\x00\x01\x00\x00" + bytes(60), "header.ttf"),
    ]:
        invalid, body = await upload(client, raw, name)
        assert invalid.status_code == 400
        assert (await client.get(P + "/operations/" + body["requestId"])).json() == invalid.json()
    glyph = bytearray(font_bytes())
    from fontTools.ttLib.sfnt import calcChecksum

    for i in range(struct.unpack_from(">H", glyph, 4)[0]):
        pos = 12 + i * 16
        if glyph[pos : pos + 4] == b"glyf":
            offset, length = struct.unpack_from(">II", glyph, pos + 8)
            struct.pack_into(">h", glyph, offset, 32767)
            struct.pack_into(">I", glyph, pos + 4, calcChecksum(glyph[offset : offset + length]))
            break
    malformed, _ = await upload(client, bytes(glyph), "bad-glyph.ttf")
    assert malformed.status_code == 400
    import zlib

    import brotli

    for ext, compressor, metadata_at in [("woff", zlib.compress, 24), ("woff2", brotli.compress, 28)]:
        raw = bytearray(font_bytes(ext))
        offset = len(raw)
        bomb = compressor(bytes(2097152))
        raw.extend(bomb)
        struct.pack_into(">I", raw, 8, len(raw))
        struct.pack_into(">III", raw, metadata_at, offset, len(bomb), 1)
        invalid, body = await upload(client, bytes(raw), "metadata." + ext)
        assert invalid.status_code == 400, invalid.text
        assert (await client.get(P + "/operations/" + body["requestId"])).json() == invalid.json()
    assert len((await client.get(P)).json()["fonts"]) == 1
