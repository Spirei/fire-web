from dataclasses import asdict
from uuid import uuid4

import pytest
from request_telemetry_tables import REQUEST_TELEMETRY_TABLES
from alcor_api.backups import tables_and_hashes
from alcor_api.market_contract import Query, canonical
from alcor_api.market_worker import claim, execute, schedule
from alcor_api.native_app_auth import issue_grant
from market_latest_candidate.test_market_authority import demand, market, market_settings  # noqa: F401


async def business_hashes(app):
    async with app.state.db.connection() as conn, conn.transaction():
        values = await tables_and_hashes(conn)
    telemetry = REQUEST_TELEMETRY_TABLES | {"auth_rate_limits"}
    return {name: value for name, value in values.items() if name not in telemetry}


@pytest.mark.asyncio
async def test_real_month_pages_feed_all_three_read_routes_without_interpolation_or_collection(market):  # noqa: F811
    client, app, authority, _, revision = market
    query = Query("bars", "US", "AAPL", "month", "qfq", start="2025-01-01", through="2026-10-31")
    await demand(client, revision, query)
    points = [(f"{2025 + i // 12}-{i % 12 + 1:02}", 10 + i) for i in range(20) if i % 4 != 2]
    class OriginalMonths:
        fixture = True
        async def read(self, policy, selected, cursor):
            assert selected == query and cursor is None
            facts = [{"at": month + "-03T05:00:00+00:00", "o": str(close), "h": str(close + 1),
                      "l": str(close - 1), "c": str(close), "session": "REGULAR", "currency": "USD"}
                     for month, close in points]
            return canonical({"query": asdict(query), "licenseRevision": policy.license_revision,
                              "facts": facts, "nextCursor": None}).encode(), "controlled_source_body"
    assert await schedule(authority) == 1
    task = await claim(authority.db, uuid4(), kind="market.history")
    assert await execute(authority, task, OriginalMonths()) == "complete"
    async with app.state.db.connection() as conn:
        user = await (await conn.execute("SELECT * FROM users WHERE username='MarketReader'")).fetchone()
        pair = await issue_grant(conn, user, "portfolio.read", "Synthetic monthly reader")
    headers = {"authorization": "Bearer " + pair["access_token"]}
    before = await business_hashes(app)
    for prefix in ("", "v1/", "v2/"):
        response = await client.get("/api/" + prefix + "kline?market=US&code=AAPL", headers=headers)
        assert response.status_code == 200, response.text
        if prefix:
            assert response.json() == {"code": 0, "message": "ok", "data": {
                "months": [month for month, _ in points], "closes": [close for _, close in points]}}
        else:
            assert response.json() == {"closes": [close for _, close in points][-12:]}
        assert response.headers["x-alcor-market-adjust"] == "qfq"
        assert response.headers["x-alcor-history-coverage"] == "unknown"
    missing = await client.get("/api/v2/kline?market=US&code=MSFT", headers=headers)
    assert missing.status_code == 503 and "尚无本人" in missing.json()["message"]
    assert await business_hashes(app) == before
    async with app.state.db.connection() as conn:
        await conn.execute("UPDATE identity_app_grants SET revoked_at=clock_timestamp() WHERE id=%s", (pair["grant_id"],))
    denied = await client.get("/api/v2/kline?market=US&code=AAPL", headers=headers)
    assert denied.status_code == 401 and denied.headers["x-alcor-retire-context"] == "true"
