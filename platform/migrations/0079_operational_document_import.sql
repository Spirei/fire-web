CREATE TABLE operational_document_claims (
    source_instance text PRIMARY KEY CHECK (source_instance ~ '^[a-f0-9]{64}$'),
    root_identity text NOT NULL UNIQUE CHECK (root_identity ~ '^[a-f0-9]{64}$'),
    source_alias text NOT NULL CHECK (source_alias ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    source_owner text NOT NULL CHECK (length(source_owner) BETWEEN 1 AND 200),
    binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
    claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE operational_document_permissions (
    id uuid PRIMARY KEY,
    source_instance text NOT NULL UNIQUE REFERENCES operational_document_claims(source_instance),
    actor_id text NOT NULL REFERENCES users(id),
    revision bigint NOT NULL CHECK (revision >= 1),
    active boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE operational_document_progress (
    permission_id uuid NOT NULL REFERENCES operational_document_permissions(id),
    version smallint NOT NULL CHECK (version IN (1, 2)),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    applied_capture_id uuid,
    content_sha256 text CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[a-f0-9]{64}$'),
    PRIMARY KEY (permission_id, version),
    CHECK ((applied_capture_id IS NULL) = (content_sha256 IS NULL))
);
CREATE TABLE operational_document_captures (
    id uuid PRIMARY KEY,
    permission_id uuid NOT NULL REFERENCES operational_document_permissions(id),
    permission_revision bigint NOT NULL CHECK (permission_revision >= 1),
    version smallint NOT NULL CHECK (version IN (1, 2)),
    content text NOT NULL CHECK (octet_length(content) <= 524288),
    content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
    byte_count integer NOT NULL CHECK (byte_count BETWEEN 0 AND 524288),
    capture_complete boolean NOT NULL CHECK (capture_complete),
    historical_versions_known boolean NOT NULL DEFAULT false CHECK (historical_versions_known = false),
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE operational_document_progress
    ADD CONSTRAINT operational_document_progress_capture_fk
    FOREIGN KEY (applied_capture_id) REFERENCES operational_document_captures(id);
CREATE TABLE operational_document_operations (
    actor_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    result jsonb NOT NULL CHECK (octet_length(result::text) <= 65536),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (actor_id, request_id)
);
CREATE TABLE operational_document_closed_operations (
    actor_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (actor_id, request_id)
);
CREATE TABLE operational_document_applications (
    capture_id uuid PRIMARY KEY REFERENCES operational_document_captures(id),
    version smallint NOT NULL CHECK (version IN (1, 2)),
    document_revision text NOT NULL CHECK (document_revision ~ '^[a-f0-9]{64}$'),
    actor_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_operational_document_claim
    BEFORE UPDATE OR DELETE ON operational_document_claims
    FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_operational_document_capture
    BEFORE UPDATE OR DELETE ON operational_document_captures
    FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_operational_document_operation
    BEFORE UPDATE OR DELETE ON operational_document_operations
    FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_operational_document_closed_operation
    BEFORE UPDATE OR DELETE ON operational_document_closed_operations
    FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_operational_document_application
    BEFORE UPDATE OR DELETE ON operational_document_applications
    FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
