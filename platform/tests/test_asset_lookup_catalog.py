import hashlib
import json
import subprocess
from pathlib import Path
from uuid import uuid4

import httpx
import pytest_asyncio
from alcor_api.asset_lookup_contract import image_key, lookup_codes, parse_lookup
from alcor_api.cli import create_user
from fastapi import HTTPException
from test_account_admin import login
from test_system_assets import SVG, upload

P = "/api/admin/asset-catalog"


@pytest_asyncio.fixture(autouse=True)
async def files(settings, tmp_path):
    settings.file_root = tmp_path / "asset-lookup-files"


def test_actual_old_parser_and_market_fallback_goldens():
    fixture = Path(__file__).parent / "fixtures/asset-lookup-source"
    for name, digest in json.loads((fixture / "source.json").read_text()).items():
        assert hashlib.sha256((fixture / name).read_bytes()).hexdigest() == digest
    key = lambda market, code: {"type": "stock", "market": market, "code": code}
    vectors = [
        None,
        "bad",
        "null",
        "{}",
        "[]",
        json.dumps(
            [
                key("US", "demo.oq"),
                key("US", "DEMO"),
                key("HK", "9992"),
                key("HK", "00000"),
                key("CN", "1"),
                key("JP", "1234.t"),
                key("KR", "123456.kq"),
            ]
        ),
        json.dumps([key("US", "X")] * 50),
        json.dumps([key("US", "X")] * 51),
        json.dumps([key("", "X")]),
        json.dumps(
            [
                {"type": "market", "market": "", "code": "us"},
                {"type": "crypto", "market": "ASSET", "code": "btc"},
                {"type": "metal", "market": "", "code": "gold"},
            ]
        ),
        json.dumps([key("US", "X")], ensure_ascii=False) + " " * 10000,
        json.dumps([{**key("US", "X"), "ignored": "😀" * 4900}], ensure_ascii=False),
        json.dumps([{**key("US", "X"), "ignored": "😀" * 5000}], ensure_ascii=False),
        json.dumps([key("HK", "\ufeff09992\ufeff")]),
        json.dumps([key("US", "\u0085X")]),
        json.dumps([key("ß", "X")]),
    ]
    output = subprocess.run(
        [
            "node",
            "--experimental-vm-modules",
            str(Path(__file__).with_name("asset_lookup_source.cjs")),
            str(fixture),
        ],
        input=json.dumps(vectors),
        text=True,
        capture_output=True,
        check=True,
        timeout=10,
    )
    actual = []
    for raw in vectors:
        try:
            actual.append([{"key": key, "codes": lookup_codes(key)} for key in parse_lookup(raw)])
        except HTTPException:
            actual.append(None)
    assert actual == json.loads(output.stdout)


def entry(identifier="stock:US:DEMO", **extra):
    return {
        "id": identifier,
        "type": "stock",
        "market": "US",
        "code": "DEMO",
        "name": "Synthetic public company",
        **extra,
    }


async def capture(client, entries, revision=None, request=None):
    text = json.dumps({"version": 1, "publicMetadataConfirmed": True, "entries": entries}, ensure_ascii=False)
    source = {"manifestText": text, "sourceLabel": "Synthetic public metadata"}
    preview = await client.post(P + "/preview", json=source)
    assert preview.status_code == 200, preview.text
    return (
        await client.post(
            P + "/imports",
            json={
                **source,
                "requestId": str(request or uuid4()),
                "expectedRevision": preview.json()["revision"] if revision is None else revision,
                "expectedSha256": preview.json()["sha256"],
            },
        ),
        preview.json(),
        source,
    )


async def test_metadata_only_import_is_not_an_image_or_market_observation(client, admin, app, db):
    identifier = uuid4()
    saved, preview, source = await capture(client, [entry()], request=identifier)
    assert saved.status_code == 200, saved.text
    result = saved.json()
    original = await client.get(P + "/sources/" + result["sourceId"])
    assert original.status_code == 200 and original.json()["manifestText"] == source["manifestText"]
    assert original.json()["result"] == result
    assert result["entries"][0]["materialState"]["light"] == "metadata-only"
    assert preview["coverage"] == "captured-metadata-only" and preview["historicalCoverageKnown"] is False
    retried = await client.post(
        P + "/imports",
        json={
            **source,
            "requestId": str(identifier),
            "expectedRevision": 0,
            "expectedSha256": preview["sha256"],
        },
    )
    assert retried.json() == result
    assert (await client.get(P + "/operations/" + str(identifier))).json() == result
    keys = json.dumps([{"type": "stock", "market": "us", "code": "DEMO.OQ"}])
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as public:
        lookup = await public.get("/api/v1/assets/lookup", params={"keys": keys})
        assert lookup.status_code == 200
        asset = lookup.json()["data"][0]
        assert asset["imageUrl"] == asset["url"] == ""
        assert asset["marketCap"] is None and asset["price"] is None and asset["changePct"] is None
        assert (await public.get("/api/asset-image/" + image_key(entry()["id"]))).status_code == 404
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM system_asset_versions")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM market_facts")).fetchone()


async def test_registered_image_stable_key_alias_range_and_real_missing_state(
    client, admin, app, settings, db
):
    uploaded, _ = await upload(client, raw=SVG, name="logo.svg", folder="stock", market="US", code="DEMO")
    assert uploaded.status_code == 200, uploaded.text
    version = uploaded.json()["version"]
    alias = "/uploads/asset/stock/US/old-demo.svg"
    saved, _, _ = await capture(client, [entry(imageVersion=version, aliases=[alias])])
    assert saved.status_code == 200
    keys = json.dumps([{"type": "stock", "market": "US", "code": "DEMO"}])
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as public:
        asset = (await public.get("/api/v1/assets/lookup", params={"keys": keys})).json()["data"][0]
        image = await public.get(asset["imageUrl"])
        assert image.status_code == 200 and image.content
        assert image.headers["cache-control"] == "public, no-cache"
        assert (
            await public.get(asset["imageUrl"], headers={"if-none-match": image.headers["etag"]})
        ).status_code == 304
        part = await public.get(
            asset["imageUrl"], headers={"range": "bytes=0-9", "if-none-match": image.headers["etag"]}
        )
        assert part.status_code == 206 and part.content == image.content[:10]
        resolved = (await public.get("/api/asset-catalog/alias", params={"url": alias})).json()
        assert resolved["imageUrl"] == "/api/asset-image/" + image_key(entry()["id"])
        assert (await public.get(resolved["imageUrl"])).content == image.content
        (settings.file_root / "resource-media" / uploaded.json()["sha256"]).unlink()
        missing = (await public.get("/api/v1/assets/lookup", params={"keys": keys})).json()["data"][0]
        assert (
            missing["imageUrl"] == "" and missing["materialState"]["light"] == "missing-or-unverified-bytes"
        )
        assert (await public.get(asset["imageUrl"])).status_code == 503


async def test_alias_conflict_partial_result_and_identity_are_not_silently_overwritten(client, admin, db):
    alias = "/uploads/asset/stock/US/shared.svg"
    first, _, _ = await capture(client, [entry(aliases=[alias])])
    assert first.status_code == 200
    second, _, _ = await capture(
        client,
        [
            entry("stock:US:OTHER", code="OTHER", aliases=[alias]),
            entry("stock:HK:9992", market="HK", code="9992"),
        ],
    )
    assert [row["state"] for row in second.json()["entries"]] == ["rejected", "applied"]
    assert second.json()["entries"][0]["error"] == "alias-conflict"
    changed, _, _ = await capture(client, [entry(code="DIFFERENT")])
    assert changed.json()["entries"][0]["error"] == "identity-conflict"
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM asset_catalog_entries")).fetchone())[
            "n"
        ] == 2


async def test_v2_optional_credential_origin_and_admin_ownership(client, admin, app, settings):
    keys = json.dumps([])
    assert (
        await client.get("/api/v1/assets/lookup", params={"keys": keys}, headers={"authorization": "ignored"})
    ).status_code == 200
    assert (await client.get("/api/v2/assets/lookup", params={"keys": keys})).status_code == 200
    invalid = await client.get(
        "/api/v2/assets/lookup", params={"keys": keys}, headers={"authorization": "Bearer invalid"}
    )
    assert invalid.status_code == 401 and invalid.json()["code"] == 40101
    expired = await client.get(
        "/api/v2/assets/lookup", params={"keys": keys}, headers={"authorization": "Bearer fat_" + "a" * 43}
    )
    assert expired.status_code == 401 and expired.json()["code"] == 40102
    assert (
        await client.get(
            "/api/v2/assets/lookup", params={"keys": keys}, headers={"origin": "https://other.invalid"}
        )
    ).status_code == 403
    saved, _, _ = await capture(client, [entry()])
    await create_user(settings, "CatalogPeer", "Synthetic9Pass", role="admin")
    peer = await login(app, "CatalogPeer")
    try:
        assert (await peer.get(P + "/operations/" + saved.json()["requestId"])).status_code == 404
    finally:
        await peer.aclose()
    assert (
        await client.post(
            P + "/preview",
            json={"manifestText": "{}", "sourceLabel": "invalid"},
            headers={"x-csrf-token": ""},
        )
    ).status_code == 403


async def test_audit_failure_rolls_back_source_aliases_catalog_and_original_uuid(client, admin, db):
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION asset_catalog_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='asset-catalog.source.imported' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$; CREATE TRIGGER asset_catalog_audit_fail BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION asset_catalog_audit_fail()",
            prepare=False,
        )
    identifier = uuid4()
    failed, preview, source = await capture(
        client, [entry(aliases=["/uploads/asset/stock/US/synthetic.svg"])], request=identifier
    )
    assert failed.status_code == 503, failed.text
    async with db.connection() as conn:
        for table in (
            "asset_catalog_sources",
            "asset_catalog_aliases",
            "asset_catalog_entries",
            "asset_catalog_operations",
        ):
            assert not await (await conn.execute("SELECT 1 FROM " + table)).fetchone()
        await conn.execute(
            "DROP TRIGGER asset_catalog_audit_fail ON audit_events; DROP FUNCTION asset_catalog_audit_fail()",
            prepare=False,
        )
    retry = await client.post(
        P + "/imports",
        json={
            **source,
            "requestId": str(identifier),
            "expectedRevision": 0,
            "expectedSha256": preview["sha256"],
        },
    )
    assert retry.status_code == 200, retry.text


async def test_public_confirmation_and_registered_originals_cannot_be_bypassed_by_alias(
    client, admin, app, db
):
    image, _ = await upload(client, raw=SVG, name="public.svg", folder="stock", market="US", code="DEMO")
    text = json.dumps(
        {
            "version": 1,
            "publicMetadataConfirmed": False,
            "entries": [
                entry(
                    imageVersion=image.json()["version"],
                    aliases=["/uploads/asset/stock/US/not-confirmed.svg"],
                )
            ],
        }
    )
    rejected = await client.post(P + "/preview", json={"manifestText": text, "sourceLabel": "Synthetic"})
    assert rejected.status_code == 400
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as public:
        assert (await public.get("/api/asset-image/" + image_key(entry()["id"]))).status_code == 404
        assert (
            await public.get(
                "/api/asset-catalog/alias", params={"url": "/uploads/asset/stock/US/not-confirmed.svg"}
            )
        ).json() == {"imageUrl": None, "state": "missing"}
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM asset_catalog_entries")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM asset_catalog_aliases")).fetchone()


async def test_late_revocation_and_close_original_cannot_create_an_import(client, admin, db, monkeypatch):
    identifier = uuid4()
    closed = await client.post(P + "/operations/" + str(identifier) + "/close", json={})
    assert closed.json() == {"requestId": str(identifier), "state": "closed"}
    late, _, _ = await capture(client, [entry()], request=identifier)
    assert late.status_code == 409
    import alcor_api.asset_lookup_api as module

    original = module.bounded_body

    async def revoke(*args):
        raw = await original(*args)
        async with db.connection() as conn:
            await conn.execute("DELETE FROM sessions WHERE user_id=%s", (admin,))
        return raw

    monkeypatch.setattr(module, "bounded_body", revoke)
    text = json.dumps({"version": 1, "publicMetadataConfirmed": True, "entries": [entry()]})
    blocked = await client.post(P + "/preview", json={"manifestText": text, "sourceLabel": "Synthetic"})
    assert blocked.status_code == 401
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM asset_catalog_sources")).fetchone()


async def test_real_pg_exact_lookup_uses_market_suffix_fallbacks_not_symbol_guessing(client, admin):
    records = [
        entry("stock:US:DEMO.OQ", code="DEMO.OQ"),
        entry("stock:HK:9992", market="HK", code="9992"),
        entry("stock:CN:000001", market="CN", code="000001"),
        entry("stock:JP:1234.T", market="JP", code="1234.T"),
        entry("stock:KR:005930.KS", market="KR", code="005930.KS"),
        entry("market:HK", type="market", market="HK", code="HONGKONG"),
        entry("crypto:BTC", type="crypto", market="ASSET", code="BTC"),
    ]
    assert (await capture(client, records))[0].status_code == 200
    keys = [
        {"type": "stock", "market": market, "code": code}
        for market, code in [("US", "DEMO"), ("HK", "09992"), ("CN", "1"), ("JP", "1234"), ("KR", "005930")]
    ]
    keys.extend(
        [
            {"type": "market", "market": "", "code": "HK"},
            {"type": "crypto", "market": "IGNORED", "code": "BTC"},
        ]
    )
    value = (await client.get("/api/v1/assets/lookup", params={"keys": json.dumps(keys)})).json()["data"]
    assert [row["id"] for row in value] == [row["id"] for row in records]
    missing = (
        await client.get(
            "/api/asset-catalog/lookup",
            params={"keys": json.dumps([{"type": "stock", "market": "US", "code": "UNKNOWN"}])},
        )
    ).json()
    assert missing["assets"] == [] and missing["missingKeys"] == [
        {"type": "stock", "market": "US", "code": "UNKNOWN"}
    ]


async def test_public_directory_projects_original_card_index_without_duplicate_authority(client, app, db):
    from test_card_catalog import card, imported, sign_in

    await sign_in(client)
    assert (await imported(client))[0].status_code == 200
    created = await client.post("/api/cards/custom", json=card(name="Synthetic shared card"))
    assert created.status_code == 200, created.text
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as public:
        directory = (await public.get("/api/asset-catalog?type=card")).json()
        assert len(directory["assets"]) == 1 and directory["cardSource"] == "card_catalog_public_index"
        item = directory["assets"][0]
        assert item["type"] == "card" and item["name"] == "Synthetic shared card"
        assert item["url"] == "" and item["price"] is None and item["marketCap"] is None
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM asset_catalog_entries")).fetchone()


async def test_v2_public_credential_needs_no_extra_scope_and_is_rechecked_after_read(
    client, admin, db, app, monkeypatch
):
    from alcor_api.native_app_auth import issue_grant

    async with db.connection() as conn, conn.transaction():
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (admin,))).fetchone()
        pair = await issue_grant(conn, user, "portfolio.read", "Synthetic lookup client")
    headers = {"authorization": "Bearer " + pair["access_token"]}
    response = await client.get("/api/v2/assets/lookup", params={"keys": "[]"}, headers=headers)
    assert response.status_code == 200 and response.headers["x-alcor-api-version"] == "2"
    original = app.state.asset_lookup_catalog.lookup

    async def revoked(*args):
        value = await original(*args)
        async with db.connection() as conn:
            await conn.execute(
                "UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s", (pair["grant_id"],)
            )
        return value

    monkeypatch.setattr(app.state.asset_lookup_catalog, "lookup", revoked)
    failed = await client.get("/api/v2/assets/lookup", params={"keys": "[]"}, headers=headers)
    assert failed.status_code == 401 and failed.json()["code"] == 40102
