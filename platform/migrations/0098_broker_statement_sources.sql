CREATE TABLE broker_statement_sources (
 owner_id text NOT NULL, account_id text NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')), origin_instance uuid NOT NULL,
 target_id text NOT NULL, target_fingerprint text NOT NULL, license_revision text NOT NULL,
 external_account text NOT NULL, enabled boolean NOT NULL DEFAULT true, credentials_ciphertext text,
 CHECK((enabled AND credentials_ciphertext IS NOT NULL) OR (NOT enabled AND credentials_ciphertext IS NULL)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,account_id,revision),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id)
);
CREATE TRIGGER broker_statement_source_no_rewrite BEFORE UPDATE OR DELETE ON broker_statement_sources
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TABLE broker_statement_source_attempts (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL, request_hash text,
 account_id text, source_revision bigint, authorization_binding text, kind text NOT NULL CHECK(kind IN ('configure','fetch','closed')),
 public_result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(kind<>'fetch' OR authorization_binding IS NOT NULL),
 PRIMARY KEY(owner_id,request_id), FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id)
);
CREATE TRIGGER broker_statement_source_attempt_no_rewrite BEFORE UPDATE OR DELETE ON broker_statement_source_attempts
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TABLE broker_statement_source_results (
 owner_id text NOT NULL, request_id uuid NOT NULL, public_result jsonb NOT NULL,
 provider_reference text, raw_response bytea, http_status integer, response_complete boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,request_id) REFERENCES broker_statement_source_attempts(owner_id,request_id)
);
CREATE TRIGGER broker_statement_source_result_no_rewrite BEFORE UPDATE OR DELETE ON broker_statement_source_results
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
