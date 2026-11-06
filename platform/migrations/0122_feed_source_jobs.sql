-- Feed collection uses the existing leased task queue. No automatic network retry.
DO $$ DECLARE previous text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_kind_check';
 IF previous IS NULL THEN RAISE EXCEPTION 'task kind constraint missing'; END IF;
 EXECUTE 'ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check';
 EXECUTE 'ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (('||previous||') OR kind IN (''feed.source_test'',''feed.refresh'',''feed.discussion''))';
END $$;
CREATE TABLE feed_source_jobs(owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,request_id uuid NOT NULL,
 task_id uuid NOT NULL UNIQUE REFERENCES tasks(id),kind text NOT NULL CHECK(kind IN ('source_test','refresh','discussion')),
 group_id text,group_revision bigint,inputs jsonb NOT NULL,subject jsonb NOT NULL,fingerprint text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','partial','failed','unknown','cancelled')),
 result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id));
CREATE FUNCTION guard_feed_source_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'status'-'result'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'result'-'updated_at')
 THEN RAISE EXCEPTION 'feed job request is retained' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER retain_feed_source_job BEFORE UPDATE OR DELETE ON feed_source_jobs FOR EACH ROW EXECUTE FUNCTION guard_feed_source_job();
CREATE TABLE feed_source_admissions(owner_id text NOT NULL,job_id uuid NOT NULL,target_key text NOT NULL,
 target_id text NOT NULL,target_fingerprint text NOT NULL,license_revision text NOT NULL,purpose text NOT NULL,
 lease_owner uuid NOT NULL,lease_version bigint NOT NULL,admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,job_id,target_key),FOREIGN KEY(owner_id,job_id) REFERENCES feed_source_jobs(owner_id,id));
CREATE TRIGGER immutable_feed_source_admission BEFORE UPDATE OR DELETE ON feed_source_admissions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE feed_source_pages(owner_id text NOT NULL,id uuid NOT NULL,job_id uuid NOT NULL,target_key text NOT NULL,
 target_id text NOT NULL,target_fingerprint text NOT NULL,license_revision text NOT NULL,
 raw bytea NOT NULL CHECK(octet_length(raw)<=1500000),raw_sha256 text NOT NULL,http_status integer,
 complete boolean NOT NULL,representation text NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,job_id,target_key),
 FOREIGN KEY(owner_id,job_id,target_key) REFERENCES feed_source_admissions(owner_id,job_id,target_key));
CREATE TRIGGER immutable_feed_source_page BEFORE UPDATE OR DELETE ON feed_source_pages FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE feed_source_results(owner_id text NOT NULL,job_id uuid NOT NULL,target_key text NOT NULL,
 result jsonb NOT NULL,page_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,job_id,target_key),FOREIGN KEY(owner_id,job_id) REFERENCES feed_source_jobs(owner_id,id),
 FOREIGN KEY(owner_id,page_id) REFERENCES feed_source_pages(owner_id,id));
CREATE TRIGGER immutable_feed_source_result BEFORE UPDATE OR DELETE ON feed_source_results FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
INSERT INTO account_change_sources(domain,source_table,owner_column,selected_columns,ignored_columns) VALUES
 ('feed','feed_source_jobs','owner_id','status,result','');
CREATE TRIGGER account_signal_feed AFTER INSERT OR UPDATE OR DELETE ON feed_source_jobs
 FOR EACH ROW EXECUTE FUNCTION capture_account_change('feed','owner_id','status,result','');
CREATE INDEX feed_jobs_owner_group_latest ON feed_source_jobs(owner_id,group_id,created_at DESC,id DESC) WHERE kind='refresh';
UPDATE account_change_metadata SET epoch=gen_random_uuid(),installed_at=clock_timestamp() WHERE singleton;
