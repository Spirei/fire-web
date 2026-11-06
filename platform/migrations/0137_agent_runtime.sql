-- Separate owner-bound Agent connections. Existing device vaults and runs are untouched.
DO $$ DECLARE prior text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO prior FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_kind_check';
 IF prior IS NULL THEN RAISE EXCEPTION 'task kind constraint missing'; END IF;
 ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
 EXECUTE 'ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (('||prior||') OR kind=''agent.runtime'')';
END $$;
CREATE TABLE agent_runtime_connections (
 owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,revision bigint NOT NULL DEFAULT 1,
 ciphertext text NOT NULL,origin_instance uuid NOT NULL,enabled boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,id)
);
CREATE TABLE agent_runtime_connection_operations (
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id)
);
CREATE TABLE agent_runtime_jobs (
 owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,request_id uuid NOT NULL,task_id uuid NOT NULL REFERENCES tasks(id),
 connection_id uuid NOT NULL,connection_revision bigint NOT NULL,action text NOT NULL,
 subject jsonb NOT NULL,ciphertext text NOT NULL,fingerprint text NOT NULL,status text NOT NULL DEFAULT 'queued',result jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id),
 FOREIGN KEY(owner_id,connection_id) REFERENCES agent_runtime_connections(owner_id,id)
);
CREATE TABLE agent_runtime_runs (
 owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,connection_id uuid NOT NULL,
 agent_instance text NOT NULL,remote_id text NOT NULL,model_binding text NOT NULL,model_service text NOT NULL,
 start_request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),UNIQUE(connection_id,remote_id),FOREIGN KEY(owner_id,connection_id) REFERENCES agent_runtime_connections(owner_id,id)
);
CREATE TABLE agent_runtime_admissions (
 owner_id text NOT NULL,job_id uuid NOT NULL,request_id uuid NOT NULL,connection_revision bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,job_id),
 FOREIGN KEY(owner_id,job_id) REFERENCES agent_runtime_jobs(owner_id,id)
);
CREATE TABLE agent_runtime_pages (
 owner_id text NOT NULL,id uuid NOT NULL,job_id uuid NOT NULL,status integer NOT NULL,raw bytea NOT NULL CHECK(octet_length(raw)<=2097152),
 complete boolean NOT NULL,sha256 text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,job_id),FOREIGN KEY(owner_id,job_id) REFERENCES agent_runtime_jobs(owner_id,id)
);
CREATE TRIGGER agent_runtime_receipt_immutable BEFORE UPDATE OR DELETE ON agent_runtime_connection_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER agent_runtime_admission_immutable BEFORE UPDATE OR DELETE ON agent_runtime_admissions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER agent_runtime_page_immutable BEFORE UPDATE OR DELETE ON agent_runtime_pages FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER agent_runtime_run_immutable BEFORE UPDATE OR DELETE ON agent_runtime_runs FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE agent_runtime_connection_versions (
 owner_id text NOT NULL,id uuid NOT NULL,revision bigint NOT NULL,ciphertext text NOT NULL,enabled boolean NOT NULL,
 request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,id,revision),
 FOREIGN KEY(owner_id,id) REFERENCES agent_runtime_connections(owner_id,id)
);
CREATE TRIGGER agent_runtime_version_immutable BEFORE UPDATE OR DELETE ON agent_runtime_connection_versions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
