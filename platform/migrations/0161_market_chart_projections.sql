-- Ready-to-serve minute-chart payloads built once by the Worker after a
-- licensed history task completes. Reads still check the current owner,
-- source revision and license; only the retained-original replay is moved to
-- write time.
CREATE TABLE market_chart_projections(
 owner_id text NOT NULL REFERENCES users(id),
 source_revision uuid NOT NULL,
 market text NOT NULL,
 code text NOT NULL,
 session text NOT NULL,
 payload jsonb NOT NULL,
 generation bigint NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,source_revision,market,code,session),
 FOREIGN KEY(owner_id,source_revision) REFERENCES market_source_configs(owner_id,revision)
);
CREATE INDEX market_chart_projection_read
 ON market_chart_projections(owner_id,source_revision,market,code);
-- The no-header read selects the newest projection per security; keep its
-- DISTINCT ON order indexable instead of sorting every retained revision.
CREATE INDEX market_chart_projection_current
 ON market_chart_projections(owner_id,session,market,code,updated_at DESC);
