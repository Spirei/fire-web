-- Quote and history intent lookups filter one owner's streams by JSON query
-- fields. Without these indexes every per-security registration reads all of
-- that owner's retained streams while holding the owner advisory lock and a
-- pooled connection, which starves unrelated reads under a small pool.
CREATE INDEX market_stream_quote_lookup ON market_streams(
 owner_id,(query->>'kind'),(query->>'market'),(query->>'code'),(query->>'instrument'),(query->>'session'));
CREATE INDEX market_stream_series_lookup ON market_streams(
 owner_id,(query->>'kind'),(query->>'frame'),(query->>'market'),(query->>'code'),
 (query->>'instrument'),(query->>'session'),(query->>'adjust'),source_revision);
-- Generated observation receipts and live-demand limits read by principal and
-- by still-active client demand rather than by stream primary key.
CREATE INDEX market_demand_principal ON market_demands(owner_id,principal,revoked_at);
CREATE INDEX market_demand_live_client ON market_demands(owner_id,origin,expires_at) WHERE revoked_at IS NULL;
