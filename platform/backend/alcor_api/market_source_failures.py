"""Latest-source cooldown survives scheduling the next attempt; newer success clears it."""


async def recent_failed_sources(conn, owner, revisions, market, code, instrument):
    if not revisions:
        return set()
    rows = await (await conn.execute("""SELECT DISTINCT s.source_revision
        FROM market_streams s JOIN market_data_jobs j ON j.owner_id=s.owner_id AND j.stream_id=s.id
        JOIN tasks t ON t.id=j.task_id
        WHERE s.owner_id=%s AND s.source_revision=ANY(%s)
        AND s.query->>'kind'='latest' AND s.query->>'market'=%s AND s.query->>'code'=%s
        AND s.query->>'instrument'=%s AND t.status='failed'
        AND j.last_source_error IN ('source_outcome_unknown','source_pagination_unclosed')
        AND t.finished_at>clock_timestamp()-interval '60 seconds'
        AND NOT EXISTS(SELECT 1 FROM market_data_jobs recovered
            WHERE recovered.owner_id=s.owner_id AND recovered.stream_id=s.id
            AND recovered.state='observed' AND
            (SELECT p.observed_at FROM market_source_pages p WHERE p.task_id=recovered.task_id
                AND p.page_number<=recovered.page_count ORDER BY p.page_number DESC LIMIT 1)>=t.finished_at)""",
        (owner, list(revisions), market, code, instrument))).fetchall()
    return {row['source_revision'] for row in rows}


async def recent_failed_sources_by_pair(conn, owner, revisions, pairs, instrument_for):
    """Resolve a whole multi-security quote read in one statement, not one per symbol."""
    requested = sorted({(market, code, instrument_for(market)) for market, code in pairs})
    if not revisions or not requested:
        return set()
    rows = await (await conn.execute("""SELECT DISTINCT s.query->>'market' AS market,s.query->>'code' AS code,s.source_revision
        FROM market_streams s JOIN market_data_jobs j ON j.owner_id=s.owner_id AND j.stream_id=s.id
        JOIN tasks t ON t.id=j.task_id
        JOIN unnest(%s::text[],%s::text[],%s::text[]) wanted(market,code,instrument)
          ON s.query->>'market'=wanted.market AND s.query->>'code'=wanted.code
          AND s.query->>'instrument'=wanted.instrument
        WHERE s.owner_id=%s AND s.source_revision=ANY(%s)
        AND s.query->>'kind'='latest' AND t.status='failed'
        AND j.last_source_error IN ('source_outcome_unknown','source_pagination_unclosed')
        AND t.finished_at>clock_timestamp()-interval '60 seconds'
        AND NOT EXISTS(SELECT 1 FROM market_data_jobs recovered
            WHERE recovered.owner_id=s.owner_id AND recovered.stream_id=s.id
            AND recovered.state='observed' AND
            (SELECT p.observed_at FROM market_source_pages p WHERE p.task_id=recovered.task_id
                AND p.page_number<=recovered.page_count ORDER BY p.page_number DESC LIMIT 1)>=t.finished_at)""",
        ([market for market,_,_ in requested],[code for _,code,_ in requested],
         [instrument for _,_,instrument in requested],owner,list(revisions)))).fetchall()
    return {(row['market'],row['code'],row['source_revision']) for row in rows}
