import asyncio
import hashlib
import json
import subprocess
from pathlib import Path
from uuid import uuid4

import httpx
import pytest_asyncio
from alcor_api.asset_catalog_management import page_number
from frozen_legacy import source_root
from test_asset_lookup_catalog import P, capture, entry
from test_system_assets import SVG, upload

PATH = P + "/entries"


@pytest_asyncio.fixture(autouse=True)
async def files(settings, tmp_path):
    settings.file_root = tmp_path / "asset-management-files"


def command(revision=0, request=None, **asset):
    return {
        "requestId": str(request or uuid4()),
        "expectedRevision": revision,
        "publicMetadataConfirmed": True,
        "asset": {"type": "stock", "market": "US", "code": "DEMO", "name": "Synthetic public asset", **asset},
        "restore": False,
    }


async def test_original_asset_ids_default_fields_and_page_goldens(client, admin):
    fixture = Path(__file__).parent / "fixtures/asset-management-source"
    for name, digest in json.loads((fixture / "source.json").read_text()).items():
        assert hashlib.sha256((fixture / name).read_bytes()).hexdigest() == digest
    api_root = source_root("ALCOR_MAIL_LEGACY_ROOT", ["lib/api.ts"])
    run = await asyncio.to_thread(
        subprocess.run,
        [
            "node",
            "--experimental-vm-modules",
            str(Path(__file__).with_name("asset_management_source.cjs")),
            str(fixture),
            str(api_root),
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    original = json.loads(run.stdout)
    inputs = [
        {"type": "stock", "market": " us ", "code": " demo.oq ", "name": ""},
        {"type": "market", "market": " us ", "code": "", "name": " US market "},
        {"type": "crypto", "market": "", "code": " btc ", "name": ""},
        {"type": "broker", "market": "GROUP", "code": " demo ", "name": "Public broker icon"},
        {"type": "group", "market": "GROUP", "code": "", "name": "Public group icon"},
        {"type": "icon", "market": "", "code": " demo ", "name": "Public icon"},
    ]
    for revision, (asset, golden) in enumerate(zip(inputs, original["assets"], strict=True)):
        saved = await client.post(
            PATH,
            json={
                "requestId": str(uuid4()),
                "expectedRevision": revision,
                "publicMetadataConfirmed": True,
                "asset": asset,
                "restore": False,
            },
        )
        assert saved.status_code == 200, saved.text
        actual = saved.json()["asset"]
        for key in ("id", "type", "market", "code", "name", "price", "changePct"):
            assert actual[key] == golden[key]
        assert golden["marketCap"] == 0 and actual["marketCap"] is None
    values = ["", "1.9", "0", "-1", "Infinity", "0x10", "0b10", "2e2", "1000001", "bad"]
    assert [{"page": page_number(v), "pageSize": page_number(v, 10, 100)} for v in values] == original[
        "pages"
    ]


async def test_single_authority_cas_uuid_delete_tombstone_and_explicit_restore(client, admin, app, db):
    image, _ = await upload(client, raw=SVG, name="asset.svg", folder="stock", market="US", code="DEMO")
    data = command(imageVersion=image.json()["version"])
    responses = await asyncio.gather(*(client.post(PATH, json=data) for _ in range(3)))
    assert all(
        response.status_code == 200 and response.json() == responses[0].json() for response in responses
    )
    first = responses[0].json()
    aid = first["asset"]["id"]
    assert (await client.get(P + "/operations/" + data["requestId"])).json() == first
    renamed = await client.post(
        PATH, json=command(1, id=aid, imageVersion=image.json()["version"], name="Renamed")
    )
    assert renamed.status_code == 200
    assert (await client.post(PATH, json=command(1))).status_code == 409
    deletion = str(uuid4())
    url = PATH + "/" + aid + "?requestId=" + deletion + "&expectedRevision=2"
    removed = await client.delete(url)
    assert removed.status_code == 200, removed.text
    assert (await client.delete(url)).json() == removed.json()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as public:
        assert (await public.get(first["asset"]["imageUrl"])).status_code == 404
        assert (await public.get("/api/v1/assets")).json()["data"] == []
    late, _, _ = await capture(client, [entry()])
    assert late.json()["entries"][0]["error"] == "deleted-asset"
    assert (await client.post(PATH, json=command(4, id=aid))).status_code == 409
    restored = await client.post(PATH, json={**command(4, id=aid), "restore": True})
    assert restored.status_code == 200, restored.text
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM asset_catalog_entries")).fetchone())[
            "n"
        ] == 1
        assert (await (await conn.execute("SELECT restored_at FROM asset_catalog_tombstones")).fetchone())[
            "restored_at"
        ] is not None
        assert (
            await (await conn.execute("SELECT count(*) n FROM asset_catalog_management_events")).fetchone()
        )["n"] == 4


async def test_legacy_public_lists_admin_writes_rename_and_query_delete(client, admin, app):
    assert (await client.post("/api/v1/assets", json={})).status_code == 401
    signed = await client.post("/api/auth/login", json={"username": "AdminOne", "password": "Synthetic9Pass"})
    assert signed.status_code == 200
    saved = await client.post(
        "/api/v1/assets", json={"type": "stock", "market": "us", "code": "demo", "name": "Demo"}
    )
    assert saved.status_code == 200, saved.text
    aid = saved.json()["data"]["id"]
    first = await client.get("/api/v1/assets?type=stock&q=demo&page=1&pageSize=1")
    assert first.json()["meta"] == {"page": 1, "pageSize": 1, "total": 1}
    assert first.json()["data"][0]["marketCap"] is None
    renamed = await client.put("/api/v1/assets/" + aid, json={"name": "Changed name"})
    assert renamed.status_code == 200 and renamed.json()["data"] == {"id": aid, "name": "Changed name"}
    assert (await client.get("/api/assets?type=stock&paged=1")).json()["assets"][0]["name"] == "Changed name"
    assert (await client.get("/api/v2/assets")).status_code == 200
    assert (
        await client.get("/api/v2/assets", headers={"authorization": "Bearer invalid"})
    ).status_code == 401
    assert (await client.delete("/api/v1/assets?id=" + aid)).json()["data"] == {"deleted": True}
    assert (await client.get("/api/v1/assets")).json()["data"] == []
    missing = await client.delete("/api/assets?id=stock:US:ABSENT")
    assert missing.status_code == 200 and missing.json() == {"ok": True}


async def test_unregistered_urls_and_non_public_fields_do_not_create_false_materials(client, admin, db):
    for asset in (
        {"url": "https://source.example.invalid/private.png"},
        {"url": "/uploads/asset/stock/US/not-registered.png"},
    ):
        rejected = await client.post(PATH, json=command(**asset))
        assert rejected.status_code == 409, rejected.text
    assert (await client.post(PATH, json={**command(), "publicMetadataConfirmed": False})).status_code == 400
    assert (await client.post(PATH, json=command(price=0))).status_code == 400
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM asset_catalog_entries")).fetchone()
        assert not await (await conn.execute("SELECT 1 FROM asset_catalog_operations")).fetchone()


async def test_audit_failure_rolls_back_metadata_tombstone_receipts_and_shared_originals(client, admin, db):
    saved = (await client.post(PATH, json=command())).json()
    aid = saved["asset"]["id"]
    async with db.connection() as conn:
        await conn.execute(
            "CREATE FUNCTION asset_manage_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='asset-catalog.delete' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$; CREATE TRIGGER asset_manage_audit_fail BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION asset_manage_audit_fail()",
            prepare=False,
        )
    rid = str(uuid4())
    result = await client.delete(PATH + "/" + aid + "?requestId=" + rid + "&expectedRevision=1")
    assert result.status_code == 503, result.text
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM asset_catalog_tombstones")).fetchone()
        assert not await (
            await conn.execute("SELECT 1 FROM asset_catalog_operations WHERE request_id=%s", (rid,))
        ).fetchone()
        assert (await (await conn.execute("SELECT revision FROM asset_catalog_scope")).fetchone())[
            "revision"
        ] == 1
        await conn.execute(
            "DROP TRIGGER asset_manage_audit_fail ON audit_events; DROP FUNCTION asset_manage_audit_fail()",
            prepare=False,
        )


async def test_legacy_management_accepts_only_web_session_family_never_native_admin_inheritance(
    client, admin, app, db
):
    from alcor_api.native_app_auth import issue_grant

    async with db.connection() as conn, conn.transaction():
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (admin,))).fetchone()
        web, _ = await app.state.legacy_create_session(conn, user, str(uuid4()))
        v1, _ = await app.state.legacy_create_session(conn, user, str(uuid4()), v1=True)
        native = await issue_grant(conn, user, "portfolio.read", "Synthetic public asset reader")
    body = {"type": "stock", "market": "US", "code": "DEMO", "name": "Web-only metadata"}
    client.cookies.set("fire_session", web)
    for token in (v1, native["access_token"]):
        denied = await client.post("/api/v1/assets", json=body, headers={"authorization": "Bearer " + token})
        assert denied.status_code == 401, denied.text
    accepted = await client.post("/api/v1/assets", json=body, headers={"authorization": "Bearer " + web})
    assert accepted.status_code == 200, accepted.text
    assert (await client.get("/api/v1/assets", headers={"authorization": "Bearer " + v1})).status_code == 200
    assert (
        await client.get("/api/v2/assets", headers={"authorization": "Bearer " + native["access_token"]})
    ).status_code == 200
    async with db.connection() as conn:
        assert (
            await (await conn.execute("SELECT count(*) n FROM asset_catalog_management_events")).fetchone()
        )["n"] == 1


async def test_explicit_public_icon_types_share_catalog_and_tombstones(client, admin, app, db):
    revision = 0
    for kind in ("broker", "group", "icon"):
        image, _ = await upload(client, raw=SVG, name=kind + ".svg", folder=kind, market="GROUP", code="DEMO")
        assert image.status_code == 200, image.text
        saved = await client.post(
            PATH,
            json=command(
                revision, type=kind, market="GROUP", code="DEMO", imageVersion=image.json()["version"]
            ),
        )
        assert saved.status_code == 200, saved.text
        asset = saved.json()["asset"]
        revision += 1
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        ) as public:
            directory = await public.get("/api/asset-catalog", params={"type": kind})
            assert directory.status_code == 200, directory.text
            assert asset["id"] in str(directory.json())
            assert (await public.get(asset["imageUrl"])).status_code == 200
        removed = await client.delete(
            PATH + "/" + asset["id"], params={"requestId": str(uuid4()), "expectedRevision": revision}
        )
        assert removed.status_code == 200, removed.text
        revision += 1
        assert (await client.get(asset["imageUrl"])).status_code == 404


async def test_legacy_web_flag_and_stock_keys_use_verified_single_authority(client, admin):
    for revision, (kind, market, code) in enumerate(
        [
            ("flag", "OTHER", "US"),
            ("stock", "HK", "09992"),
            ("stock", "US", "NVDA"),
            ("stock", "US", "NVDL"),
        ]
    ):
        image, _ = await upload(client, raw=SVG, name=code + ".svg", folder=kind, market=market, code=code)
        assert image.status_code == 200, image.text
        saved = await client.post(
            PATH,
            json=command(revision, type=kind, market=market, code=code, imageVersion=image.json()["version"]),
        )
        assert saved.status_code == 200, saved.text
    flags = await client.get("/api/assets", params={"type": "flag", "keys": " us ,US,XX,!"})
    assert flags.status_code == 200
    assert [row["code"] for row in flags.json()["assets"]] == ["US"]
    assert flags.json()["assets"][0]["marketCap"] is None
    assert (
        await client.get("/api/assets", params={"type": "flag", "keys": ",".join(["!"] * 50 + ["US"])})
    ).json() == {"assets": []}
    result = await client.get("/api/assets", params={"type": "stock", "keys": "HK:9992,US:NVDL,US:NVDA"})
    assert result.status_code == 200, result.text
    mapping = {row["market"] + ":" + row["code"]: row["url"] for row in result.json()["assets"]}
    assert mapping["HK:9992"] == mapping["HK:09992"]
    assert mapping["US:NVDL"] == mapping["US:NVDA"]
    assert (await client.get(mapping["US:NVDL"])).status_code == 200
    assert (await client.get("/api/assets", params={"type": "stock", "keys": "US:NVDL"})).json() == {
        "assets": []
    }
    assert (
        await client.get(
            "/api/assets", params={"type": "stock", "keys": ",".join(["bad"] * 200 + ["HK:9992"])}
        )
    ).json() == {"assets": []}


async def test_legacy_web_http_paging_sort_unknowns_and_app_literal_query(client, admin):
    for revision, (code, name) in enumerate(
        [("AA", "Alpha"), ("AB", "a_b"), ("AC", "a%b"), ("AD", "Shared"), ("AE", "Shared")]
    ):
        saved = await client.post(PATH, json=command(revision, code=code, name=name))
        assert saved.status_code == 200, saved.text

    async def codes(**params):
        response = await client.get("/api/assets", params={"type": "stock", "paged": "1", **params})
        assert response.status_code == 200, response.text
        return response.json()

    wildcard = await codes(q="a_b", sort="code", dir="asc", pageSize="1", page="Infinity")
    assert wildcard["total"] == 2 and wildcard["page"] == 2
    assert [row["code"] for row in wildcard["assets"]] == ["AC"]
    literal = await client.get("/api/v1/assets", params={"type": "stock", "q": "a_b"})
    assert [row["code"] for row in literal.json()["data"]] == ["AB"]
    assert [row["code"] for row in (await codes(sort="name", dir="desc"))["assets"]] == [
        "AB",
        "AC",
        "AD",
        "AE",
        "AA",
    ]
    for sort in ("price", "marketCap", "changePct", "rank", "board", "invalid"):
        result = await codes(sort=sort, dir="desc")
        assert [row["code"] for row in result["assets"]] == ["AA", "AB", "AC", "AD", "AE"]
        assert all(
            row["price"] is None and row["marketCap"] is None and row["changePct"] is None
            for row in result["assets"]
        )
    assert (await codes(market=" us "))["total"] == 0
    assert (await codes(type="invalid"))["total"] == 0
    unpaged = await client.get("/api/assets", params={"type": "stock", "q": "missing", "market": "HK"})
    assert len(unpaged.json()["assets"]) == 5
    no_type = await client.get("/api/assets", params={"paged": "1", "q": "missing"})
    assert len(no_type.json()["assets"]) == 5
