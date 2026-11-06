import asyncio
import hashlib
from uuid import uuid4

import httpx
import pytest_asyncio
from alcor_api.cli import create_user
from alcor_api.resource_media import ResourceMedia

P = "/api/admin/shared-assets"
PNG = b"\x89PNG\r\n\x1a\nSYNTHETIC-ORIGINAL"
SVG = b'<?xml version="1.0"?><!-- by TradingView --><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'


@pytest_asyncio.fixture(autouse=True)
async def files(settings, tmp_path):
    settings.file_root = tmp_path.resolve() / "system-files"


async def upload(client, kind="asset", raw=PNG, name="file.png", revision=None, rid=None, **fields):
    revision = revision if revision is not None else (await client.get(P)).json()["revision"]
    data = {"kind": kind, "requestId": rid or str(uuid4()), "expectedRevision": str(revision), **fields}
    return await client.post(
        P + "/upload", data=data, files={"file": (name, raw, "application/octet-stream")}
    ), data


async def anonymous(app):
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app, raise_app_exceptions=False), base_url="http://testserver"
    )


async def test_all_five_real_legacy_cookie_uploads_public_prefixes_and_avatar_stays_private(
    client, admin, app
):
    async with (
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
            base_url="http://testserver",
            headers={"origin": "http://testserver"},
        ) as legacy,
        await anonymous(app) as public,
    ):
        assert (
            await legacy.post("/api/auth/login", json={"username": "AdminOne", "password": "Synthetic9Pass"})
        ).status_code == 200
        for kind in ("ico", "background", "logo", "login", "asset"):
            data = {
                "kind": kind,
                **(
                    {"folder": "stock", "market": "US", "code": "AAPL", "name": "Apple"}
                    if kind == "asset"
                    else {}
                ),
            }
            result = await legacy.post(
                "/api/upload", data=data, files={"file": ("source.png", PNG, "image/png")}
            )
            assert result.status_code == 200, result.text
            assert set(result.json()) == {"url"}
            url = result.json()["url"]
            assert url.startswith("/uploads/" + kind + "/")
            assert (await public.get(url)).content == PNG
            if kind == "asset":
                assert url == "/uploads/asset/stock/US/AAPL.png"
        avatar = await legacy.post("/api/upload", files={"file": ("avatar.png", PNG, "image/png")})
        assert avatar.status_code == 200, avatar.text
        assert avatar.json()["url"].startswith("/api/auth/avatar?")
        assert (await public.get(avatar.json()["url"])).status_code == 401
        assert (await public.get("/uploads/avatar/guessed.png")).status_code in (400, 404)


async def test_original_svg_normalization_immutable_history_uuid_and_public_private_isolation(
    client, admin, app, settings
):
    first, body = await upload(client, "asset", SVG, "icon.svg", folder="icon", code="Icon")
    assert first.status_code == 200, first.text
    one = first.json()
    assert one["originalSha256"] != one["sha256"]
    async with await anonymous(app) as public:
        read = await public.get(one["url"])
        assert read.content.startswith(b"<!-- by alcor -->\n<svg") and b"TradingView" not in read.content
        assert (await public.get(P + "/versions/" + one["version"] + "/original")).status_code == 401
        raw = await client.get(P + "/versions/" + one["version"] + "/original")
        assert raw.content == SVG
        second, _ = await upload(
            client, "asset", SVG.replace(b"M0 0", b"M1 1"), "icon.svg", folder="icon", code="Icon"
        )
        assert second.status_code == 200, second.text
        assert (await public.get(one["url"])).content == read.content
        assert (await public.get(one["legacyUrl"])).content == (
            await public.get(second.json()["url"])
        ).content
        assert (await public.get(one["legacyUrl"] + "?sha256=" + one["originalSha256"])).status_code == 404
        assert (await public.get(one["url"] + "&sha256=" + one["sha256"])).status_code == 400
        assert (await public.get(one["legacyUrl"] + "?sha256=invalid")).status_code == 400
        conditional = await public.get(one["url"], headers={"if-none-match": '"' + one["sha256"] + '"'})
        assert conditional.status_code == 304
        ranged = await public.get(one["url"], headers={"range": "bytes=-5"})
        assert ranged.status_code == 206 and ranged.content == read.content[-5:]
        assert (await public.get(one["url"], headers={"range": "bytes=999999-"})).status_code == 416
    repeated = await client.post(
        P + "/upload", data=body, files={"file": ("icon.svg", SVG, "application/octet-stream")}
    )
    assert repeated.json() == one
    assert (await client.get(P + "/operations/" + one["requestId"])).json() == one
    async with app.state.db.connection() as conn:
        await ResourceMedia(settings).reconcile_orphans(conn)
        assert (await (await conn.execute("SELECT count(*) n FROM resource_media_objects")).fetchone())[
            "n"
        ] == 0
        assert (await (await conn.execute("SELECT count(*) n FROM admin_attachment_entries")).fetchone())[
            "n"
        ] == 0
    assert (settings.file_root / "resource-media" / one["originalSha256"]).read_bytes() == SVG


async def test_nonadmin_bearer_csrf_unsafe_svg_and_cas_cannot_publish_private_bytes(
    client, admin, app, settings
):
    assert (await client.get(P, headers={"authorization": "Bearer no-cookie-fallback"})).status_code == 403
    assert (
        await client.post(
            P + "/upload",
            data={"kind": "ico", "requestId": str(uuid4()), "expectedRevision": "0"},
            files={"file": ("x.png", PNG)},
            headers={"x-csrf-token": "bad"},
        )
    ).status_code == 403
    await create_user(settings, "SystemAssetUser", "SyntheticOther9", role="user")
    async with await anonymous(app) as other:
        other.headers["origin"] = "http://testserver"
        login = await other.post(
            "/api/session/login", json={"login": "SystemAssetUser", "password": "SyntheticOther9"}
        )
        other.headers["x-csrf-token"] = login.json()["csrf"]
        assert (await other.get(P)).status_code == 403
        assert (
            await other.post(P + "/upload", data={"kind": "ico"}, files={"file": ("x.png", PNG)})
        ).status_code == 403
    bad, _ = await upload(client, "ico", b"<svg><script>alert(1)</script></svg>", "bad.svg")
    assert bad.status_code == 400 and bad.json()["state"] == "failed"
    first, _ = await upload(client, "ico")
    assert first.status_code == 200
    stale, fields = await upload(client, "ico", revision=0)
    assert stale.status_code == 409 and stale.json()["state"] == "failed"
    assert (await client.get(P + "/operations/" + fields["requestId"])).json() == stale.json()
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM system_asset_versions")).fetchone())[
            "n"
        ] == 1


async def test_actual_twenty_mib_card_contract_and_independent_kind_limits(client, admin, app):
    raw = b"GIF89a" + b"x" * (20 * 1024 * 1024 - 6)
    result, _ = await upload(client, "asset", raw, "card.gif", folder="card", code="SYNTHETIC")
    assert result.status_code == 200, result.text
    async with await anonymous(app) as public:
        read = await public.get(result.json()["url"])
        assert (
            len(read.content) == len(raw)
            and hashlib.sha256(read.content).digest() == hashlib.sha256(raw).digest()
        )
    too_large, _ = await upload(client, "asset", raw + b"x", "card.gif", folder="card", code="LARGE")
    assert too_large.status_code == 400
    logo, _ = await upload(client, "logo", b"GIF89a" + b"x" * (2 * 1024 * 1024 - 5), "logo.gif")
    assert logo.status_code == 400
    empty, _ = await upload(client, "background", b"", "empty.png")
    assert empty.status_code == 400


async def test_real_concurrent_original_uuid_and_scope_cas_publish_once(client, admin, app):
    rid = str(uuid4())
    responses = await asyncio.gather(
        upload(client, "ico", rid=rid, revision=0), upload(client, "ico", rid=rid, revision=0)
    )
    assert all(response.status_code == 200 for response, _ in responses)
    assert responses[0][0].json() == responses[1][0].json()
    attempts = await asyncio.gather(
        upload(client, "logo", revision=1), upload(client, "background", revision=1)
    )
    assert sorted(r.status_code for r, _ in attempts) == [200, 409]
    async with app.state.db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM system_asset_versions")).fetchone())[
            "n"
        ] == 2


async def test_cross_namespace_digest_contention_fails_atomically_without_waiting_second_lock(
    client, admin, app
):
    from alcor_api.system_asset_codec import image_bytes

    output, _ = image_bytes(SVG, "svg")
    sha = max(hashlib.sha256(SVG).hexdigest(), hashlib.sha256(output).hexdigest())
    async with app.state.db.connection() as peer, peer.transaction():
        await peer.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", ("resource-sha:" + sha,))
        result, body = await asyncio.wait_for(upload(client, "logo", SVG, "icon.svg"), timeout=5)
        assert result.status_code == 503 and result.json()["state"] == "failed", result.text
        assert (await client.get(P + "/operations/" + body["requestId"])).json() == result.json()
        assert (await client.get(P)).json()["revision"] == 0
        assert (await (await peer.execute("SELECT count(*) n FROM system_asset_versions")).fetchone())[
            "n"
        ] == 0
    next_result, _ = await upload(client, "logo", SVG, "icon.svg")
    assert next_result.status_code == 200, next_result.text
    assert (await client.get(P + "/operations/" + body["requestId"])).json()["state"] == "failed"


async def test_failed_audit_commit_never_changes_published_path_or_creates_false_receipt(client, admin, app):
    original, _ = await upload(client, "asset", folder="stock", market="US", code="ROLLBACK")
    assert original.status_code == 200
    async with app.state.db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION reject_synthetic_system_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$"
        )
        await conn.execute(
            "CREATE TRIGGER reject_synthetic_system_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_synthetic_system_audit()"
        )
    failed, body = await upload(
        client, "asset", PNG + b"replacement", folder="stock", market="US", code="ROLLBACK"
    )
    assert failed.status_code >= 500
    async with await anonymous(app) as public:
        assert (await public.get(original.json()["legacyUrl"])).content == PNG
    assert (await client.get(P + "/operations/" + body["requestId"])).status_code == 404
    assert (await client.get(P)).json()["revision"] == 1
