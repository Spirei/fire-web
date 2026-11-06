CREATE TABLE private_runtime_scope(singleton boolean PRIMARY KEY CHECK(singleton),revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0));
INSERT INTO private_runtime_scope(singleton) VALUES(true);
CREATE TABLE private_runtime_versions(id uuid PRIMARY KEY,group_name text NOT NULL,revision bigint NOT NULL UNIQUE,payload_ciphertext text NOT NULL,crypto_instance uuid NOT NULL,actor_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TRIGGER immutable_private_runtime_version BEFORE UPDATE OR DELETE ON private_runtime_versions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE private_runtime_heads(group_name text PRIMARY KEY,current_version uuid NOT NULL REFERENCES private_runtime_versions(id),managed_fields text[] NOT NULL,managed_targets text[] NOT NULL DEFAULT '{}');
CREATE TABLE private_runtime_operations(actor_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_id));
CREATE TRIGGER immutable_private_runtime_operation BEFORE UPDATE OR DELETE ON private_runtime_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
INSERT INTO account_change_sources(domain,source_table,owner_column,selected_columns,ignored_columns) VALUES('settings','private_runtime_versions','actor_id','','');
CREATE TRIGGER account_signal_private_runtime AFTER INSERT OR UPDATE OR DELETE ON private_runtime_versions FOR EACH ROW EXECUTE FUNCTION capture_account_change('settings','actor_id','','');
