-- Explicit administrator SEC collection through the existing leased queue.
DO $$ DECLARE prior text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO prior FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_kind_check';
 IF prior IS NULL THEN RAISE EXCEPTION 'task kind constraint missing'; END IF;
 ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
 EXECUTE 'ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (('||prior||') OR kind=''celeb.sec_collect'')';
END $$;
CREATE TABLE celeb_source_jobs(owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,request_id uuid NOT NULL,task_id uuid NOT NULL UNIQUE REFERENCES tasks(id),celeb_id text NOT NULL,revision bigint NOT NULL,target_id text NOT NULL,target_fingerprint text NOT NULL,subject jsonb NOT NULL,inputs jsonb NOT NULL DEFAULT '{}',request_hash text NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id));
CREATE FUNCTION retain_celeb_source_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'result') IS DISTINCT FROM (to_jsonb(OLD)-'result') OR OLD.result IS NOT NULL THEN RAISE EXCEPTION 'celeb source job retained' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER retain_celeb_source_job BEFORE UPDATE OR DELETE ON celeb_source_jobs FOR EACH ROW EXECUTE FUNCTION retain_celeb_source_job();
CREATE TABLE celeb_source_admissions(owner_id text NOT NULL,job_id uuid NOT NULL,url text NOT NULL,target_fingerprint text NOT NULL,license_revision text NOT NULL,admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,job_id,url),FOREIGN KEY(owner_id,job_id) REFERENCES celeb_source_jobs(owner_id,id));
CREATE TRIGGER retain_celeb_source_admission BEFORE UPDATE OR DELETE ON celeb_source_admissions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE celeb_source_pages(owner_id text NOT NULL,id uuid NOT NULL,job_id uuid NOT NULL,url text NOT NULL,raw bytea NOT NULL CHECK(octet_length(raw)<=8388608),raw_sha256 text NOT NULL,http_status integer,complete boolean NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,id),UNIQUE(owner_id,job_id,url),FOREIGN KEY(owner_id,job_id,url) REFERENCES celeb_source_admissions(owner_id,job_id,url));
CREATE TRIGGER retain_celeb_source_page BEFORE UPDATE OR DELETE ON celeb_source_pages FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

CREATE INDEX celeb_source_schedule_heads ON celeb_source_jobs(owner_id,celeb_id,created_at DESC,id DESC);
