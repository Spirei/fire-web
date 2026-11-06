-- Isolated candidate only; formal number assigned by the root merge.
CREATE TABLE market_source_configs(owner_id text NOT NULL REFERENCES users(id),revision uuid NOT NULL,request_id uuid NOT NULL,
 policy_id text NOT NULL,policy_fingerprint text NOT NULL,origin_instance uuid NOT NULL,
 session_version integer NOT NULL,native_grant_id text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,revision),UNIQUE(owner_id,request_id));
CREATE TRIGGER immutable_market_source_config BEFORE UPDATE OR DELETE ON market_source_configs FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE market_source_revocations(owner_id text NOT NULL,revision uuid NOT NULL,request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,revision),UNIQUE(owner_id,request_id),
 FOREIGN KEY(owner_id,revision) REFERENCES market_source_configs(owner_id,revision));
CREATE TRIGGER immutable_market_source_revocation BEFORE UPDATE OR DELETE ON market_source_revocations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE market_data_operations(owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,fingerprint text NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id));
CREATE TRIGGER immutable_market_data_operation BEFORE UPDATE OR DELETE ON market_data_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE market_streams(owner_id text NOT NULL,source_revision uuid NOT NULL,id uuid NOT NULL,query_fingerprint text NOT NULL,query jsonb NOT NULL,
 generation bigint NOT NULL DEFAULT 0,demand_generation bigint NOT NULL DEFAULT 0,current_task_id uuid,next_due timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,source_revision,query_fingerprint),FOREIGN KEY(owner_id,source_revision) REFERENCES market_source_configs(owner_id,revision));
CREATE TABLE market_demands(owner_id text NOT NULL,stream_id uuid NOT NULL,principal text NOT NULL,native_grant_id text,session_version integer NOT NULL,
 revision bigint NOT NULL DEFAULT 1,expires_at timestamptz,hot_until timestamptz NOT NULL,revoked_at timestamptz,
 origin text NOT NULL CHECK(origin IN ('client','price.alert')),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,stream_id,principal),FOREIGN KEY(owner_id,stream_id) REFERENCES market_streams(owner_id,id));
CREATE TABLE market_data_jobs(task_id uuid PRIMARY KEY REFERENCES tasks(id),owner_id text NOT NULL,stream_id uuid NOT NULL,generation bigint NOT NULL,
 cursor text,page_count integer NOT NULL DEFAULT 0,state text NOT NULL DEFAULT 'pending',last_source_error text,
 FOREIGN KEY(owner_id,stream_id) REFERENCES market_streams(owner_id,id));
CREATE TABLE market_source_pages(owner_id text NOT NULL,id uuid NOT NULL,task_id uuid NOT NULL REFERENCES tasks(id),source_revision uuid NOT NULL,
 page_number integer NOT NULL,cursor_in text,cursor_out text,representation text NOT NULL,raw_bytes bytea NOT NULL,raw_sha256 text NOT NULL,
 issues jsonb NOT NULL,observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,id),
 FOREIGN KEY(owner_id,source_revision) REFERENCES market_source_configs(owner_id,revision),UNIQUE(task_id,page_number));
CREATE TRIGGER immutable_market_source_page BEFORE UPDATE OR DELETE ON market_source_pages FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE market_facts(owner_id text NOT NULL,source_revision uuid NOT NULL,series_fingerprint text NOT NULL,stream_id uuid NOT NULL,page_id uuid NOT NULL,
 sequence bigint GENERATED ALWAYS AS IDENTITY,id uuid NOT NULL,source_time timestamptz NOT NULL,contents jsonb NOT NULL,fingerprint text NOT NULL,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,source_revision,series_fingerprint,fingerprint),FOREIGN KEY(owner_id,stream_id) REFERENCES market_streams(owner_id,id),
 FOREIGN KEY(owner_id,page_id) REFERENCES market_source_pages(owner_id,id));
CREATE TRIGGER immutable_market_fact BEFORE UPDATE OR DELETE ON market_facts FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE market_cache_generations(owner_id text PRIMARY KEY REFERENCES users(id),generation bigint NOT NULL DEFAULT 1);
DO $$ DECLARE previous text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='tasks'::regclass AND conname='tasks_kind_check';
 ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
 EXECUTE 'ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK (('||previous||') OR kind=''market.latest'')';
END $$;
