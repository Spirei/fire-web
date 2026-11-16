-- Hot market and audit lookups that grew without a supporting index.
-- Coverage receipts are read by stream on every history view; without this
-- index the read scans every retained receipt for the owner.
CREATE INDEX market_coverage_receipt_stream
 ON market_coverage_receipts(owner_id,stream_id,created_at DESC,task_id DESC);
-- Task detail and migration progress read the latest event of one task.
CREATE INDEX task_events_task
 ON task_events(task_id,id);
-- Activity and profile checks sort one actor or target without a scan.
CREATE INDEX audit_events_actor_time
 ON audit_events(actor_id,created_at DESC,id DESC);
CREATE INDEX audit_events_time
 ON audit_events(created_at DESC,id DESC);
CREATE INDEX audit_events_target_time
 ON audit_events(target_id,action,created_at DESC);
-- Imported personal activity and order declarations page by time.
CREATE INDEX personal_activity_owner_time
 ON personal_legacy_activities(owner_id,created_at DESC,id DESC);
CREATE INDEX personal_declaration_owner_time
 ON personal_order_declarations(owner_id,created_at,id);

-- Quote collection updates a few owner/stream rows many times per second.
-- Keep room for HOT updates and vacuum the delta before the tables bloat.
ALTER TABLE market_streams SET (fillfactor=80,
 autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.01);
ALTER TABLE market_data_jobs SET (fillfactor=80,
 autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.01);
ALTER TABLE market_demands SET (fillfactor=85,
 autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.01);
ALTER TABLE tasks SET (fillfactor=90,
 autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.01);
ALTER TABLE market_facts SET (autovacuum_vacuum_scale_factor=0.02,
 autovacuum_analyze_scale_factor=0.01);
ALTER TABLE market_source_pages SET (autovacuum_vacuum_scale_factor=0.02,
 autovacuum_analyze_scale_factor=0.01);
ALTER TABLE market_coverage_receipts SET (autovacuum_vacuum_scale_factor=0.02,
 autovacuum_analyze_scale_factor=0.01);
ALTER TABLE market_chart_projections SET (fillfactor=90,
 autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.01);
ALTER TABLE request_observations SET (fillfactor=90,
 autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.01);
ALTER TABLE auth_rate_limits SET (fillfactor=80,
 autovacuum_vacuum_scale_factor=0.02,autovacuum_analyze_scale_factor=0.01);
