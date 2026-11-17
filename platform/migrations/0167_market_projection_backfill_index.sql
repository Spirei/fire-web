-- The Worker probes for minute chart projections missing from retained facts
-- every five seconds. Without a matching partial index that probe scans every
-- stream (latest, day and index series included) and sorts before LIMIT 10,
-- adding a periodic full-table scan beside API reads on the same database.
CREATE INDEX market_stream_chart_backfill ON market_streams(next_due,owner_id,id)
 WHERE (query->>'frame')='minute' AND (query->>'kind') IN ('bars','price_series');
