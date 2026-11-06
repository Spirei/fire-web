-- Original statements and preview receipts do not alter portfolio or cash facts.
CREATE TABLE broker_statement_originals (
 owner_id text NOT NULL REFERENCES users(id), id uuid NOT NULL,
 account_id text NOT NULL, account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),
 provider text NOT NULL CHECK(provider='ibkr'), external_account text NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 source_bytes bytea NOT NULL CHECK(octet_length(source_bytes) BETWEEN 1 AND 8388608),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id), FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id)
);
CREATE TRIGGER broker_statement_original_no_rewrite BEFORE UPDATE OR DELETE ON broker_statement_originals
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TABLE broker_statement_previews (
 owner_id text NOT NULL, id uuid NOT NULL, original_id uuid NOT NULL,
 account_id text NOT NULL, account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),
 account_revision bigint NOT NULL, authorization_binding text NOT NULL,
 parsed jsonb NOT NULL, comparison jsonb NOT NULL, comparison_hash text NOT NULL, record_collection_revision bigint NOT NULL, expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,id),
 FOREIGN KEY(owner_id,original_id) REFERENCES broker_statement_originals(owner_id,id),
 FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id)
);
CREATE TRIGGER broker_statement_preview_no_rewrite BEFORE UPDATE ON broker_statement_previews
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TABLE broker_statement_preview_operations (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 request_hash text, result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id)
);
CREATE TRIGGER broker_statement_preview_receipt_no_rewrite BEFORE UPDATE OR DELETE ON broker_statement_preview_operations
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
