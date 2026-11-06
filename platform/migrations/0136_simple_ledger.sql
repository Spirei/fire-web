CREATE TABLE simple_ledger_heads(owner_id text PRIMARY KEY REFERENCES users(id),revision bigint NOT NULL CHECK(revision>0));
CREATE TABLE simple_ledger_versions(owner_id text NOT NULL REFERENCES users(id),revision bigint NOT NULL,value jsonb NOT NULL,request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,revision),UNIQUE(owner_id,request_id));
CREATE TRIGGER retain_simple_ledger_version BEFORE UPDATE OR DELETE ON simple_ledger_versions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE simple_ledger_operations(owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id));
CREATE TRIGGER retain_simple_ledger_operation BEFORE UPDATE OR DELETE ON simple_ledger_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE simple_ledger_files(owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,sha256 text NOT NULL,raw bytea NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id));
CREATE TRIGGER retain_simple_ledger_file BEFORE UPDATE OR DELETE ON simple_ledger_files FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
