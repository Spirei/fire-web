"""Per-security quote and history lookups are backed by owner-scoped indexes."""

EXPECTED = {
    "market_stream_quote_lookup",
    "market_stream_series_lookup",
    "market_demand_principal",
    "market_demand_live_client",
}


async def test_market_stream_lookup_indexes_exist(db):
    async with db.connection() as conn:
        rows = await (
            await conn.execute(
                "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname=ANY(%s)",
                (sorted(EXPECTED),),
            )
        ).fetchall()
    assert {row["indexname"] for row in rows} == EXPECTED
