import pytest
from request_telemetry_tables import REQUEST_TELEMETRY_TABLES
from alcor_api.backups import tables_and_hashes
from test_cash_ledger import account


async def business_hashes(db):
    async with db.connection() as conn, conn.transaction():
        values = await tables_and_hashes(conn)
    telemetry = REQUEST_TELEMETRY_TABLES | {"auth_rate_limits"}
    return {name: value for name, value in values.items() if name not in telemetry}


@pytest.mark.asyncio
async def test_fresh_cash_snapshot_preserves_all_business_tables_and_missing_collection(client, admin, db):
    identifier = await account(client)
    before = await business_hashes(db)
    response = await client.get("/api/cash/accounts/" + identifier)
    assert response.status_code == 200, response.text
    assert response.json()["revision"] == 0
    assert all(row["balance"] is None and row["registeredBalance"] is None for row in response.json()["currencies"])
    assert await business_hashes(db) == before
    async with db.connection() as conn:
        assert not await (await conn.execute("SELECT 1 FROM cash_ledger_collections WHERE owner_id=%s", (admin,))).fetchone()
