DO $$ DECLARE previous text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_kind_check';
 IF previous IS NULL THEN RAISE EXCEPTION 'task kind constraint missing'; END IF;
 ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
 EXECUTE 'ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (('||previous||') OR kind=''asset.source'')';
END $$;
CREATE TABLE asset_source_jobs(owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,request_id uuid NOT NULL,task_id uuid NOT NULL UNIQUE REFERENCES tasks(id),action text NOT NULL CHECK(action IN ('search','add','sync','backfill','check-delisted','cleanup')),expected_revision bigint NOT NULL,target_id text NOT NULL,target_fingerprint text NOT NULL,subject jsonb NOT NULL,inputs jsonb NOT NULL,request_hash text NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id));
CREATE FUNCTION retain_asset_source_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'result') IS DISTINCT FROM (to_jsonb(OLD)-'result') OR OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result THEN RAISE EXCEPTION 'asset source request/result retained' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER retain_asset_source_job BEFORE UPDATE OR DELETE ON asset_source_jobs FOR EACH ROW EXECUTE FUNCTION retain_asset_source_job();
CREATE TABLE asset_source_admissions(owner_id text NOT NULL,job_id uuid NOT NULL,request_key text NOT NULL,request jsonb NOT NULL,target_fingerprint text NOT NULL,license_revision text NOT NULL,admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,job_id,request_key),FOREIGN KEY(owner_id,job_id) REFERENCES asset_source_jobs(owner_id,id));
CREATE TRIGGER immutable_asset_source_admission BEFORE UPDATE OR DELETE ON asset_source_admissions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE asset_source_pages(owner_id text NOT NULL,id uuid NOT NULL,job_id uuid NOT NULL,request_key text NOT NULL,raw bytea NOT NULL CHECK(octet_length(raw)<=8388608),raw_sha256 text NOT NULL,http_status integer,complete boolean NOT NULL,representation text NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,id),UNIQUE(owner_id,job_id,request_key),FOREIGN KEY(owner_id,job_id,request_key) REFERENCES asset_source_admissions(owner_id,job_id,request_key));
CREATE TRIGGER immutable_asset_source_page BEFORE UPDATE OR DELETE ON asset_source_pages FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
