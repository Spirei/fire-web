import pytest
from alcor_api.native_app_auth import issue_grant


@pytest.mark.asyncio
@pytest.mark.parametrize("version", [1, 2])
async def test_legacy_group_list_create_reorder_exact_contract(client, db, version):
    registered = await client.post("/api/auth/register", json={"username": "LegacyGroups", "password": "SyntheticGroupsPass9"})
    owner = registered.json()["user"]["id"]
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (owner,))).fetchone()
        pair = await issue_grant(conn, user, "portfolio.read portfolio.write", "Synthetic device")
        read = await issue_grant(conn, user, "portfolio.read", "Read device")
    headers = {"authorization": "Bearer " + pair["access_token"]}
    path = f"/api/v{version}/watch-groups"
    from uuid import uuid4

    from alcor_api.watchlists import WatchGroups
    await WatchGroups(db).mutate(owner, "initialize", {}, uuid4(), 0)
    response = await client.get(path, headers=headers)
    assert response.status_code == 200
    groups = response.json()["data"]["groups"]
    assert len(groups) == 6
    assert all(set(g) == {"id", "name", "icon", "sort", "visible", "kind", "market"} for g in groups)
    created = await client.post(path, json={"name": "  Research  "}, headers=headers)
    assert created.status_code == 200, created.text
    group = created.json()["data"]["group"]
    assert group == {"id": group["id"], "name": "Research", "icon": "", "sort": 6, "visible": -1, "kind": "custom", "market": ""}
    assert (await client.post(path, json={"name": "Research"}, headers=headers)).status_code == 409
    read_headers = {"authorization": "Bearer " + read["access_token"]}
    assert (await client.post(path, json={"name": "Forbidden"}, headers=read_headers)).status_code == 403
    reordered = await client.post(path + "/reorder", json={"order": ["foreign", group["id"], group["id"], None]}, headers=headers)
    assert reordered.status_code == 200 and reordered.json()["data"] == {"updated": 1}
    listing = (await client.get(path, headers=headers)).json()["data"]["groups"]
    assert next(g for g in listing if g["id"] == group["id"])["sort"] == 1
    assert (await client.post(path, json={"name": "Origin"}, headers={**headers, "origin": "https://untrusted.invalid"})).status_code == 403
    if version == 2:
        assert (await client.get(path)).status_code == 401
    else:
        assert (await client.get(path)).status_code == 200
    assert (await client.get("/api/v3/watch-groups", headers=headers)).status_code == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("version", [1, 2])
async def test_legacy_assign_and_exact_reorder_membership(client, db, version):
    from uuid import uuid4

    from alcor_api.portfolio_records import PortfolioRecords
    registered = await client.post("/api/auth/register", json={"username": "GroupRecords", "password": "SyntheticGroupsPass9"})
    owner = registered.json()["user"]["id"]
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (owner,))).fetchone()
        pair = await issue_grant(conn, user, "portfolio.read portfolio.write", "Synthetic device")
    headers = {"authorization": "Bearer " + pair["access_token"]}
    groups = f"/api/v{version}/watch-groups"
    group = (await client.post(groups, json={"name": "Favorites"}, headers=headers)).json()["data"]["group"]
    records = PortfolioRecords(db)
    ids = []
    for code in ("AAPL", "MSFT"):
        preview = await records.preview(owner, "create", {"name": code, "code": code, "market": "US", "price": None, "qty": None, "cost": None, "group": "", "note": ""})
        ids.append((await records.confirm(owner, preview["previewId"], uuid4()))["recordId"])
    prefix = f"/api/v{version}/records"
    assigned = await client.post(prefix + "/group-assign", json={"ids": [*ids, "foreign", ids[0]], "groupId": group["id"]}, headers=headers)
    assert assigned.status_code == 200 and assigned.json()["data"] == {"updated": 2}
    incomplete = await client.post(prefix + "/group-reorder", json={"ids": ids[:1], "groupId": group["id"]}, headers=headers)
    assert incomplete.status_code == 400 and incomplete.json()["code"] == 40001
    reordered = await client.post(prefix + "/group-reorder", json={"ids": ids[::-1], "groupId": group["id"]}, headers=headers)
    assert reordered.status_code == 200 and reordered.json()["data"] == {"updated": 2}
    listed = await records.list(owner, view=group["id"])
    assert [r["id"] for r in listed["records"]] == ids[::-1]
    invalid = await client.post(prefix + "/group-assign", json={"ids": ids, "groupId": "market:US"}, headers=headers)
    assert invalid.status_code == 400
    cleared = await client.post(prefix + "/group-assign", json={"ids": ids, "groupId": ""}, headers=headers)
    assert cleared.status_code == 200 and cleared.json()["data"] == {"updated": 2}
    assert all(r["watchGroupId"] == "" for r in (await records.list(owner))["records"])
