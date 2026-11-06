import hashlib
from uuid import uuid4

import pytest_asyncio

from test_legacy_asset_directory import SVG, write


@pytest_asyncio.fixture(autouse=True)
async def uploads(settings, tmp_path):
    settings.file_root = tmp_path / "uploads"
    write(settings.file_root, "asset/stock/US/DEMO.svg")
    write(settings.file_root, "asset/stock/US/OTHER.svg")
    write(settings.file_root, "avatar/private.svg")


async def test_public_directory_paging_original_bytes_and_database_stays_unchanged(client, db, settings):
    async with db.connection() as conn:
        before = (await (await conn.execute("SELECT count(*) n FROM asset_catalog_entries")).fetchone())["n"]
    listing = await client.get("/api/assets?type=stock&market=US&paged=1&pageSize=1")
    assert listing.status_code == 200, listing.text
    data = listing.json()
    assert data["total"] == 2 and len(data["assets"]) == 1
    one = data["assets"][0]
    assert one["code"] == "DEMO" and one["coverage"] == "filename-only"
    assert one["originalSha256"] == hashlib.sha256(SVG).hexdigest()
    keys = '[{"type":"stock","market":"US","code":"DEMO"}]'
    lookup = await client.get("/api/asset-catalog/lookup", params={"keys": keys})
    assert lookup.status_code == 200 and lookup.json()["missingKeys"] == []
    assert lookup.json()["assets"][0]["imageUrl"] == one["imageUrl"]
    icons = await client.get("/api/assets", params={"type": "stock", "keys": "US:DEMO"})
    assert icons.status_code == 200 and one["imageUrl"] in str(icons.json())
    image = await client.get(one["imageUrl"])
    assert image.status_code == 200 and image.headers["content-type"].startswith("image/svg+xml")
    assert (
        await client.get(one["imageUrl"], headers={"if-none-match": image.headers["etag"]})
    ).status_code == 304
    assert (await client.get(one["imageUrl"], headers={"range": "bytes=0-4"})).status_code == 206
    assert (await client.get("/uploads/avatar/private.svg")).status_code == 400
    assert (settings.file_root / "asset/stock/US/DEMO.svg").read_bytes() == SVG
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM asset_catalog_entries")).fetchone())[
            "n"
        ] == before


async def test_registered_metadata_and_tombstones_suppress_filename_fallback(client, admin):
    saved = await client.post(
        "/api/admin/asset-catalog/entries",
        json={
            "requestId": str(uuid4()),
            "expectedRevision": 0,
            "publicMetadataConfirmed": True,
            "asset": {
                "id": "source-demo",
                "type": "stock",
                "market": "US",
                "code": "DEMO",
                "name": "Authoritative name",
            },
            "restore": False,
        },
    )
    assert saved.status_code == 200, saved.text
    rows = (await client.get("/api/assets?type=stock&paged=1")).json()["assets"]
    assert len(rows) == 2 and next(r for r in rows if r["code"] == "DEMO")["name"] == "Authoritative name"
    result = saved.json()
    deleted = await client.delete(
        f"/api/admin/asset-catalog/entries/source-demo?requestId={uuid4()}&expectedRevision={result['revision']}"
    )
    assert deleted.status_code == 200, deleted.text
    rows = (await client.get("/api/assets?type=stock&paged=1")).json()["assets"]
    assert [r["code"] for r in rows] == ["OTHER"]
    lookup = await client.get(
        "/api/asset-catalog/lookup", params={"keys": '[{"type":"stock","market":"US","code":"DEMO"}]'}
    )
    assert lookup.json()["assets"] == [] and len(lookup.json()["missingKeys"]) == 1
