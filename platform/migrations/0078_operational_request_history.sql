CREATE TABLE operational_request_claims (
    source_instance text PRIMARY KEY CHECK (source_instance ~ '^[a-f0-9]{64}$'),
    root_identity text NOT NULL UNIQUE CHECK (root_identity ~ '^[a-f0-9]{64}$'),
    source_alias text NOT NULL CHECK (source_alias ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    source_owner text NOT NULL CHECK (length(source_owner) BETWEEN 1 AND 200),
    binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
    claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE operational_request_permissions (
    id uuid PRIMARY KEY,
    source_instance text NOT NULL UNIQUE REFERENCES operational_request_claims(source_instance),
    actor_id text NOT NULL REFERENCES users(id),
    revision bigint NOT NULL CHECK (revision >= 1),
    active boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE operational_request_progress (
    permission_id uuid NOT NULL REFERENCES operational_request_permissions(id),
    kind text NOT NULL CHECK (kind IN ('requests','request_daily','request_hours')),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    cursor jsonb,
    page_exhausted boolean NOT NULL DEFAULT false,
    applied_rows bigint NOT NULL DEFAULT 0 CHECK (applied_rows >= 0),
    PRIMARY KEY (permission_id, kind)
);
CREATE TABLE operational_request_captures (
    id uuid PRIMARY KEY,
    permission_id uuid NOT NULL REFERENCES operational_request_permissions(id),
    permission_revision bigint NOT NULL CHECK (permission_revision >= 1),
    kind text NOT NULL CHECK (kind IN ('requests','request_daily','request_hours')),
    cursor_before jsonb,
    cursor_after jsonb,
    page_exhausted boolean NOT NULL,
    page_snapshot_complete boolean NOT NULL CHECK (page_snapshot_complete),
    capture_complete boolean NOT NULL DEFAULT false CHECK (capture_complete = false),
    historical_coverage_known boolean NOT NULL DEFAULT false CHECK (historical_coverage_known = false),
    schema_sha256 text NOT NULL CHECK (schema_sha256 ~ '^[a-f0-9]{64}$'),
    raw_sha256 text NOT NULL CHECK (raw_sha256 ~ '^[a-f0-9]{64}$'),
    max_detail_id bigint NOT NULL CHECK (max_detail_id >= 0),
    retained_detail_count bigint NOT NULL CHECK (retained_detail_count >= 0),
    row_count integer NOT NULL CHECK (row_count BETWEEN 0 AND 500),
    raw jsonb NOT NULL CHECK (octet_length(raw::text) <= 4194304),
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE operational_request_operations (
    actor_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
    result jsonb NOT NULL CHECK (octet_length(result::text) <= 65536),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (actor_id, request_id)
);
CREATE TABLE operational_request_closed_operations (
    actor_id text NOT NULL REFERENCES users(id),
    request_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (actor_id, request_id)
);
CREATE TABLE operational_request_log_rows (
    source_instance text NOT NULL REFERENCES operational_request_claims(source_instance),
    original_id bigint NOT NULL CHECK (original_id >= 1),
    observation_key uuid NOT NULL UNIQUE,
    capture_id uuid NOT NULL REFERENCES operational_request_captures(id),
    digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
    PRIMARY KEY (source_instance, original_id)
);
CREATE TABLE operational_request_log_cells (
    source_instance text NOT NULL REFERENCES operational_request_claims(source_instance),
    unit text NOT NULL CHECK (unit IN ('hour','day')),
    bucket timestamptz NOT NULL,
    path text NOT NULL,
    method text NOT NULL,
    source text NOT NULL,
    status smallint NOT NULL,
    count bigint NOT NULL CHECK (count >= 1),
    total_ms double precision,
    capture_id uuid NOT NULL REFERENCES operational_request_captures(id),
    PRIMARY KEY (source_instance, unit, bucket, path, method, source, status),
    CHECK (
        (unit = 'hour' AND total_ms IS NULL)
        OR (unit = 'day' AND total_ms IS NOT NULL AND total_ms >= 0)
    )
);
ALTER TABLE request_observations
    ADD COLUMN imported_source text REFERENCES operational_request_claims(root_identity);
CREATE TRIGGER immutable_operational_request_claim
    BEFORE UPDATE OR DELETE ON operational_request_claims
    FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_operational_request_capture
    BEFORE UPDATE OR DELETE ON operational_request_captures
    FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_operational_request_operation
    BEFORE UPDATE OR DELETE ON operational_request_operations
    FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_operational_request_closed_operation
    BEFORE UPDATE OR DELETE ON operational_request_closed_operations
    FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_operational_request_log_row
    BEFORE UPDATE OR DELETE ON operational_request_log_rows
    FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
