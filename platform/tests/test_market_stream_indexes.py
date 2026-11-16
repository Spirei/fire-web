"""Per-security quote and history lookups are backed by owner-scoped indexes."""

EXPECTED = {
    "market_stream_quote_lookup",
    "market_stream_series_lookup",
    "market_demand_principal",
    "market_demand_live_client",
    "market_chart_projection_read",
    "market_chart_projection_current",
}
HOT_PATH = {
    "market_coverage_receipt_stream",
    "task_events_task",
    "audit_events_actor_time",
    "audit_events_time",
    "audit_events_target_time",
    "personal_activity_owner_time",
    "personal_declaration_owner_time",
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


async def test_hot_path_indexes_and_storage_options_exist(db):
    async with db.connection() as conn:
        rows = await (
            await conn.execute(
                "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname=ANY(%s)",
                (sorted(HOT_PATH),),
            )
        ).fetchall()
        options = await (
            await conn.execute(
                "SELECT relname,reloptions FROM pg_class WHERE relkind='r' AND relname=ANY(%s)",
                (["market_streams", "market_data_jobs", "tasks", "request_observations"],),
            )
        ).fetchall()
    assert {row["indexname"] for row in rows} == HOT_PATH
    values = {row["relname"]: row["reloptions"] or [] for row in options}
    assert "fillfactor=80" in values["market_streams"]
    assert "fillfactor=80" in values["market_data_jobs"]
    assert "fillfactor=90" in values["tasks"]
    assert "fillfactor=90" in values["request_observations"]
