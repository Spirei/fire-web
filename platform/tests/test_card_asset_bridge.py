"""Complete custom-card publication bridge through the actual old global asset read."""

import httpx
import pytest_asyncio
from alcor_api.asset_lookup_contract import image_key
from test_card_catalog import card, imported, sign_in
from test_system_assets import SVG, upload


@pytest_asyncio.fixture(autouse=True)
async def files(settings, tmp_path):
    settings.file_root = tmp_path / "card-asset-bridge"


async def global_cards(client):
    response = await client.get("/api/assets?type=card&paged=1")
    assert response.status_code == 200, response.text
    return response.json()["assets"]


async def test_admin_custom_publication_peer_reuse_and_deletion_share_one_original_index(client, app, db):
    admin = await sign_in(client)
    assert (await imported(client))[0].status_code == 200
    material, _ = await upload(client, raw=SVG, name="card.svg", folder="card")
    assert material.status_code == 200, material.text
    path = material.json()["legacyUrl"]
    created = await client.post(
        "/api/cards/custom", json=card(name="Public Descriptor", region="hk", image=path)
    )
    assert created.status_code == 200, created.text
    first = created.json()["card"]
    values = await global_cards(client)
    assert len(values) == 1
    asset = values[0]
    assert {key: asset[key] for key in ("id", "type", "market", "code", "name")} == {
        "id": "card:" + path,
        "type": "card",
        "market": "HK",
        "code": "PUBLIC DESCRIPTOR",
        "name": "Public Descriptor",
    }
    assert asset["imageUrl"].startswith("/api/asset-image/" + image_key("card:" + path))
    assert asset["marketCap"] is None and asset["price"] is None
    served = await client.get(asset["imageUrl"])
    assert served.status_code == 200 and served.content
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM card_catalog_public_index")).fetchone())[
            "n"
        ] == 1
        assert not await (await conn.execute("SELECT 1 FROM asset_catalog_entries")).fetchone()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="http://testserver",
        headers={"origin": "http://testserver"},
    ) as peer:
        await sign_in(peer, "BridgePeer")
        reused = await peer.post(
            "/api/cards/custom", json=card(name="Peer private name", bank="Peer private bank", image=path)
        )
        assert reused.status_code == 200, reused.text
        observed = await global_cards(peer)
        assert len(observed) == 1 and observed[0]["name"] == "Public Descriptor"
        assert "Peer private" not in str(observed)
        # Admin removal cannot retire publication while another owner uses it.
        assert (await client.delete("/api/cards/custom", params={"id": first["id"]})).status_code == 200
        assert len(await global_cards(peer)) == 1
        assert (await peer.get(asset["imageUrl"])).content == served.content
        # The last ordinary owner still cannot remove a global publication.
        assert (
            await peer.delete("/api/cards/custom", params={"id": reused.json()["card"]["id"]})
        ).status_code == 200
        assert len(await global_cards(peer)) == 1
    # The administrator can retire its final private association/public index,
    # while the independently registered immutable shared original is retained.
    final = await client.post("/api/cards/custom", json=card(name="Final Public Descriptor", image=path))
    assert final.status_code == 200, final.text
    assert (
        await client.delete("/api/cards/custom", params={"id": final.json()["card"]["id"]})
    ).status_code == 200
    assert await global_cards(client) == []
    assert (await client.get(asset["imageUrl"])).status_code == 404
    assert (await client.get(path)).content == served.content
    async with db.connection() as conn:
        index = await (
            await conn.execute("SELECT updated_by,deleted_at,image_version FROM card_catalog_public_index")
        ).fetchone()
        assert (
            index["deleted_at"] is not None
            and index["updated_by"] == admin
            and index["image_version"] is not None
        )
        assert not await (await conn.execute("SELECT 1 FROM asset_catalog_entries")).fetchone()
        assert (await (await conn.execute("SELECT count(*) n FROM system_asset_versions")).fetchone())[
            "n"
        ] == 1
