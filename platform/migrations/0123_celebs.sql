CREATE TABLE celeb_scope(singleton boolean PRIMARY KEY CHECK(singleton),revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0));
INSERT INTO celeb_scope(singleton) VALUES(true);
CREATE TABLE celeb_heads(id text PRIMARY KEY CHECK(id ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),revision bigint NOT NULL CHECK(revision>0),sort integer NOT NULL DEFAULT 0,deleted_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE celeb_revisions(celeb_id text NOT NULL REFERENCES celeb_heads(id),revision bigint NOT NULL CHECK(revision>0),payload jsonb NOT NULL,raw_input jsonb NOT NULL,raw_bytes bytea NOT NULL,input_sha256 text NOT NULL,actor_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,source_kind text NOT NULL,source_page_id text,source_revision text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(celeb_id,revision));
CREATE TRIGGER immutable_celeb_revision BEFORE UPDATE OR DELETE ON celeb_revisions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE celeb_operations(actor_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_id));
CREATE TRIGGER immutable_celeb_operation BEFORE UPDATE OR DELETE ON celeb_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
