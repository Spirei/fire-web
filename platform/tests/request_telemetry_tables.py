"""Only independent request-observability storage is outside business-read hashes.

Do not add audit, sessions, receipts, preferences, financial or source tables here.
A route's explicit abuse counter exception remains local to that route's test.
"""

REQUEST_TELEMETRY_TABLES = frozenset({
    "request_observations",
    "request_observation_producers",
    "request_rollup_state",
    "account_request_activity",
    "account_request_activity_batches",
    "account_request_activity_state",
})


async def business_table_hashes(conn):
    """Hashes for a read-only business proof.

    The request collector flushes on its own timer. Those rows are not business
    state, so a flush during the proof must not fail the comparison. Proofs
    about telemetry itself must keep using tables_and_hashes.
    """
    from alcor_api.backups import tables_and_hashes

    values = await tables_and_hashes(conn)
    return {name: value for name, value in values.items() if name not in REQUEST_TELEMETRY_TABLES}
