-- Explicit adoption and immutable receipts for the App-authored account ledger.
CREATE TABLE native_ledger_heads (
    owner_id text PRIMARY KEY REFERENCES users(id),
    revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE native_ledger_transactions (
    owner_id text NOT NULL REFERENCES native_ledger_heads(owner_id),
    request_id uuid NOT NULL,
    revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    event jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object'),
    receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_id, request_id),
    UNIQUE (owner_id, revision)
);
CREATE TRIGGER native_ledger_retained BEFORE UPDATE OR DELETE ON native_ledger_transactions
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();

DO $$ DECLARE previous text;
BEGIN
    SELECT pg_get_expr(conbin, conrelid) INTO STRICT previous FROM pg_constraint
    WHERE conrelid='asset_request_domains'::regclass AND conname='asset_request_domains_domain_check';
    ALTER TABLE asset_request_domains DROP CONSTRAINT asset_request_domains_domain_check;
    EXECUTE 'ALTER TABLE asset_request_domains ADD CONSTRAINT asset_request_domains_domain_check CHECK ((' ||
        previous || ') OR domain=''native_ledger'')';
END $$;
