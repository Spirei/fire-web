-- Latest snapshots are read by owner/stream/revision. Historical-series indexes
-- cannot serve that lookup without scanning unrelated retained observations.
CREATE INDEX market_fact_stream_window
 ON market_facts(owner_id,stream_id,source_revision,source_time DESC,sequence DESC);
