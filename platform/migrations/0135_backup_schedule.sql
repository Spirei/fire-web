DO $$ DECLARE prior text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO prior FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_kind_check';
 IF prior IS NULL THEN RAISE EXCEPTION 'task kind constraint missing'; END IF;
 ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
 EXECUTE 'ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (('||prior||') OR kind=''backup.retention'')';
END $$;
CREATE TABLE backup_schedule_scope(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 0);
INSERT INTO backup_schedule_scope VALUES(true,0);
CREATE TABLE backup_schedule_versions(revision bigint PRIMARY KEY,actor_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,enabled boolean NOT NULL,interval_hours integer NOT NULL CHECK(interval_hours BETWEEN 1 AND 8760),keep integer NOT NULL CHECK(keep BETWEEN 1 AND 90),origin_instance uuid NOT NULL,session_version bigint NOT NULL,storage_identity jsonb NOT NULL,key_fingerprint text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER retain_backup_schedule_version BEFORE UPDATE OR DELETE ON backup_schedule_versions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE backup_schedule_operations(actor_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,request_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_id));
CREATE TRIGGER retain_backup_schedule_operation BEFORE UPDATE OR DELETE ON backup_schedule_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE backup_schedule_admissions(task_id uuid PRIMARY KEY REFERENCES tasks(id),request_id uuid NOT NULL,actor_id text NOT NULL REFERENCES users(id),config_revision bigint NOT NULL,kind text NOT NULL CHECK(kind IN ('manual','scheduled','retention')),origin_instance uuid NOT NULL,session_version bigint NOT NULL,session_hash text,storage_identity jsonb NOT NULL,key_fingerprint text NOT NULL,backup_id uuid REFERENCES backups(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(actor_id,request_id));
CREATE TRIGGER retain_backup_schedule_admission BEFORE UPDATE OR DELETE ON backup_schedule_admissions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE backup_retention_results(task_id uuid PRIMARY KEY REFERENCES tasks(id),backup_id uuid NOT NULL REFERENCES backups(id),state text NOT NULL CHECK(state IN ('admitted','deleted','unknown','unavailable')),file_identity jsonb,result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz);
CREATE FUNCTION retain_backup_retention_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.backup_id IS DISTINCT FROM OLD.backup_id OR OLD.state<>'admitted' THEN RAISE EXCEPTION 'retention receipt retained' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER retain_backup_retention_result BEFORE UPDATE OR DELETE ON backup_retention_results FOR EACH ROW EXECUTE FUNCTION retain_backup_retention_result();
