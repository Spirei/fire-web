from uuid import uuid4

import pytest
from alcor_api.native_app_auth import issue_grant
from alcor_api.portfolio_records import PortfolioRecords

PASSWORD = "SyntheticPortfolioPass9"


async def register(client, name="LegacyPortfolio"):
    response = await client.post("/api/auth/register", json={"username": name, "password": PASSWORD})
    assert response.status_code == 201
    return response.json()["user"]["id"]


async def grant(db, owner, scope="portfolio.read portfolio.write"):
    async with db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE id=%s", (owner,))).fetchone()
        pair = await issue_grant(conn, user, scope, "Synthetic device")
    return {"authorization": "Bearer " + pair["access_token"]}


async def record(db, owner, **changes):
    service = PortfolioRecords(db)
    preview = await service.preview(owner, "create", {"name": "Example", "code": "00700", "market": "HK", "accountMarket": "CN", "price": "0", "cost": "-2.5", "qty": None, "group": "Manual", "note": "note", **changes})
    return await service.confirm(owner, preview["previewId"], uuid4())


@pytest.mark.asyncio
async def test_web_list_exact_shape_owner_header_and_missing_zero(client, db):
    owner = await register(client)
    created = await record(db, owner)
    response = await client.get("/api/records")
    assert response.status_code == 200
    assert response.headers["x-alcor-account-id"] == owner
    assert response.headers["x-alcor-records-revision"] == str(created["collectionRevision"])
    value = response.json()[0]
    assert set(value) == {"id", "name", "code", "market", "accountMarket", "price", "cost", "qty", "group", "watchGroupId", "watchGroupSort", "note", "updatedAt", "revision"}
    assert value["price"] == 0 and value["cost"] == -2.5 and value["qty"] == ""
    assert value["market"] == "HK" and value["accountMarket"] == "CN"
    assert value["updatedAt"].endswith("Z")
    native = await grant(db, owner)
    assert (await client.get("/api/records", headers=native)).status_code == 401
    client.cookies.clear()
    denied = await client.get("/api/records")
    assert denied.status_code == 401 and set(denied.json()) == {"error", "code"}


@pytest.mark.asyncio
@pytest.mark.parametrize("version", [1, 2])
async def test_native_records_paging_scope_snapshot_and_receipt(client, db, version):
    owner = await register(client)
    first = await record(db, owner)
    second = await record(db, owner, code="AAPL", market="US", accountMarket="", source="manual")
    headers = await grant(db, owner, "portfolio.read")
    prefix = f"/api/v{version}/records"
    response = await client.get(prefix + "?pageSize=1", headers=headers)
    assert response.status_code == 200
    assert response.headers["x-alcor-api-version"] == str(version)
    assert response.json()["meta"] == {"page": 1, "pageSize": 1, "total": 2, "collectionRevision": second["collectionRevision"]}
    assert response.json()["data"][0]["id"] == second["recordId"]
    filtered = await client.get(prefix + "?market=hk&group=Manual", headers=headers)
    assert len(filtered.json()["data"]) == 1 and filtered.json()["data"][0]["id"] == first["recordId"]
    single = await client.get(prefix + "/" + first["recordId"], headers=headers)
    assert single.json()["data"] == filtered.json()["data"][0]
    receipt = await client.get(prefix + "/operations/" + first["requestId"], headers=headers)
    assert receipt.status_code == 200
    value = receipt.json()["data"]
    assert set(value) == {"requestId", "kind", "recordId", "state", "code", "message", "record", "deleted", "revision", "collectionRevision", "createdAt", "completedAt"}
    assert value["record"]["id"] == first["recordId"] and value["state"] == "completed"
    stale = await client.get(prefix + "?collectionRevision=0", headers=headers)
    assert stale.status_code == 409 and stale.json()["code"] == 40902
    invalid = await client.get(prefix + "?collectionRevision=01", headers=headers)
    assert invalid.status_code == 400 and invalid.json()["code"] == 40001
    assert (await client.get(prefix, headers={"authorization": "Bearer fat_invalid"})).status_code == 401
    assert (await client.get(prefix, headers={**headers, "origin": "https://untrusted.invalid"})).status_code == 403
    if version == 2:
        assert (await client.get(prefix)).status_code == 401
    else:
        assert (await client.get(prefix)).status_code == 200


@pytest.mark.asyncio
async def test_legacy_record_and_receipt_cross_owner_not_found(client, db):
    owner = await register(client)
    created = await record(db, owner)
    await client.post("/api/auth/logout")
    other = await register(client, "SecondPortfolio")
    headers = await grant(db, other)
    assert (await client.get("/api/v2/records", headers=headers)).json()["data"] == []
    assert (await client.get("/api/v2/records/" + created["recordId"], headers=headers)).status_code == 404
    assert (await client.get("/api/v2/records/operations/" + created["requestId"], headers=headers)).status_code == 404
