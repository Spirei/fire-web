from uuid import uuid4

from resource_test_support import resource_files, setup  # noqa:F401
from test_legacy_devices import bearer, grant, register


async def test_one_bounded_tree_read_covers_all_128_folders_without_cross_owner_or_legacy_expansion(
    client, db
):
    owner, pair, read, base = await setup(client, db)
    identifiers = []
    for index in range(128):
        response = await client.post(
            base + "/folders",
            headers=bearer(pair),
            json={
                "requestId": str(uuid4()),
                "category": "components" if index < 127 else "media",
                "name": f"folder-{index:03d}",
            },
        )
        assert response.status_code == 201, response.text
        identifiers.append(response.json()["result"]["id"])
    response = await client.get(base + "/folder-tree?category=components", headers=bearer(read))
    assert response.status_code == 200, response.text
    assert {item["id"] for item in response.json()["items"]} == set(identifiers[:127])
    assert all(item["revision"] == 1 and item["parentId"] is None for item in response.json()["items"])
    assert (
        len((await client.get(base + "/folder-tree?category=media", headers=bearer(read))).json()["items"])
        == 1
    )
    for query in [
        "",
        "?category=components&category=media",
        "?category=components&owner=other",
        "?category=unknown",
    ]:
        assert (await client.get(base + "/folder-tree" + query, headers=bearer(read))).status_code == 400
    assert (
        await client.get("/api/v1/resource-library/folder-tree?category=components", headers=bearer(read))
    ).status_code == 404
    other = await register(client, "TreeOther")
    other_read = await grant(db, other, "portfolio.read resources.read")
    assert (
        await client.get(base + "/folder-tree?category=components", headers=bearer(other_read))
    ).json() == {"items": []}
    insufficient = await grant(db, owner, "portfolio.read")
    assert (
        await client.get(base + "/folder-tree?category=components", headers=bearer(insufficient))
    ).status_code == 403
