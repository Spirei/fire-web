-- Candidate only, follows the frozen receipt/chain SQL. No formal migration number.
ALTER TABLE dividend_announcement_revisions DROP CONSTRAINT dividend_announcement_revisions_source_check;
ALTER TABLE dividend_announcement_revisions ADD CONSTRAINT dividend_announcement_revisions_source_check
 CHECK(source IN ('futu','eastmoney','yahoo'));

CREATE TABLE dividend_source_configs (
 owner_id text NOT NULL REFERENCES users(id), revision uuid NOT NULL,
 request_id uuid NOT NULL, fingerprint text NOT NULL,
 target_id text NOT NULL, target_fingerprint text NOT NULL,
 source text NOT NULL CHECK(source IN ('futu','eastmoney','yahoo')),
 source_assurance text NOT NULL CHECK(source_assurance IN ('controlled_fixture','transport_observed')),
 market text NOT NULL, code text NOT NULL, config jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,revision), UNIQUE(owner_id,request_id)
);
CREATE TRIGGER immutable_dividend_source_config BEFORE UPDATE OR DELETE ON dividend_source_configs
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

CREATE TABLE dividend_source_scans (
 owner_id text NOT NULL REFERENCES users(id), task_id uuid PRIMARY KEY REFERENCES tasks(id),
 config_revision uuid NOT NULL, next_cursor integer NOT NULL DEFAULT 1,
 expected_count integer, expected_pages integer, observed_count integer NOT NULL DEFAULT 0,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','partial','complete','failed','cancelled')),
 latest_error text, completed_at timestamptz, not_before timestamptz,
 FOREIGN KEY(owner_id,config_revision) REFERENCES dividend_source_configs(owner_id,revision)
);
CREATE TABLE dividend_source_attempts (
 id uuid PRIMARY KEY, owner_id text NOT NULL, task_id uuid NOT NULL REFERENCES tasks(id),
 target_id text NOT NULL, budget_key text NOT NULL, cursor integer NOT NULL, lease_version bigint NOT NULL,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX dividend_source_rate_budget ON dividend_source_attempts(budget_key,started_at);
CREATE TRIGGER immutable_dividend_source_attempt BEFORE UPDATE OR DELETE ON dividend_source_attempts
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

CREATE TABLE dividend_source_pages (
 owner_id text NOT NULL, task_id uuid NOT NULL REFERENCES tasks(id), cursor integer NOT NULL,
 attempt_id uuid NOT NULL REFERENCES dividend_source_attempts(id),
 raw_bytes bytea NOT NULL CHECK(octet_length(raw_bytes)<=131072), raw_sha256 text NOT NULL,
 representation text NOT NULL, received_at timestamptz NOT NULL,
 source_timezone text, source_date_contract text NOT NULL,
 pagination_semantics text NOT NULL, record_count integer NOT NULL,
 PRIMARY KEY(owner_id,task_id,cursor)
);
CREATE TRIGGER immutable_dividend_source_page BEFORE UPDATE OR DELETE ON dividend_source_pages
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

CREATE TABLE dividend_source_failures (
 attempt_id uuid PRIMARY KEY REFERENCES dividend_source_attempts(id),
 task_id uuid NOT NULL REFERENCES tasks(id), owner_id text NOT NULL,
 error_code text NOT NULL, http_status integer,
 raw_bytes bytea CHECK(octet_length(raw_bytes)<=131072), raw_sha256 text,
 representation text, body_complete boolean NOT NULL DEFAULT true,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_dividend_source_failure BEFORE UPDATE OR DELETE ON dividend_source_failures
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

CREATE TABLE dividend_source_observations (
 owner_id text NOT NULL, task_id uuid NOT NULL, cursor integer NOT NULL,
 json_pointer text NOT NULL, announcement_revision uuid NOT NULL,
 record_fingerprint text NOT NULL, event_identity text NOT NULL DEFAULT 'content_observation_not_official_event_id',
 PRIMARY KEY(owner_id,task_id,cursor,json_pointer),
 UNIQUE(owner_id,task_id,record_fingerprint),
 FOREIGN KEY(owner_id,task_id,cursor) REFERENCES dividend_source_pages(owner_id,task_id,cursor),
 FOREIGN KEY(owner_id,announcement_revision) REFERENCES dividend_announcement_revisions(owner_id,revision)
);
CREATE TRIGGER immutable_dividend_source_observation BEFORE UPDATE OR DELETE ON dividend_source_observations
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

-- Extend, rather than overwrite, other candidate/formal worker task kinds.
DO $$ DECLARE existing text; BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO existing FROM pg_constraint
 WHERE conrelid='tasks'::regclass AND conname='tasks_kind_check';
 ALTER TABLE tasks DROP CONSTRAINT tasks_kind_check;
 EXECUTE 'ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check CHECK ((' || existing ||
 ') OR kind=''dividends.source.collect'')';
END $$;
