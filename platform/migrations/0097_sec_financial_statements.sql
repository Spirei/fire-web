-- Company Facts uses an independently licensed source and immutable originals.
CREATE TABLE sec_financial_receipts(
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 source_revision uuid NOT NULL, origin_instance uuid NOT NULL, session_version integer NOT NULL,
 policy_fingerprint text NOT NULL CHECK(policy_fingerprint ~ '^[a-f0-9]{64}$'),
 license_revision text NOT NULL, ticker text NOT NULL CHECK(ticker ~ '^[A-Z0-9._-]{1,40}$'),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,source_revision) REFERENCES market_source_configs(owner_id,revision)
);
CREATE TABLE sec_financial_pages(
 owner_id text NOT NULL, request_id uuid NOT NULL, id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('directory','companyfacts')),
 cik text CHECK(cik ~ '^[0-9]{10}$'), http_status integer CHECK(http_status BETWEEN 100 AND 599),
 raw_bytes bytea NOT NULL CHECK(octet_length(raw_bytes)<=8388608),
 raw_sha256 text NOT NULL CHECK(raw_sha256 ~ '^[a-f0-9]{64}$'), complete boolean NOT NULL,
 representation text NOT NULL CHECK(representation='http_response_body'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,id),
 UNIQUE(owner_id,request_id,kind),
 FOREIGN KEY(owner_id,request_id) REFERENCES sec_financial_receipts(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((kind='directory' AND cik IS NULL) OR (kind='companyfacts' AND cik IS NOT NULL)),
 CHECK(encode(sha256(raw_bytes),'hex')=raw_sha256)
);
CREATE INDEX sec_financial_lookup ON sec_financial_receipts(owner_id,ticker,created_at DESC);
CREATE TRIGGER immutable_sec_financial_receipts BEFORE UPDATE OR DELETE ON sec_financial_receipts FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_sec_financial_pages BEFORE UPDATE OR DELETE ON sec_financial_pages FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

-- Cross-SEC UUID reservation survives a process loss before a response/archive commits.
-- These are immutable admission outcomes, superseded only by a separate final receipt.
CREATE TABLE sec_acquisition_admissions(
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 source_version text NOT NULL CHECK(source_version IN ('sec-submissions-v1','sec-companyfacts-v1')),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id)
);
CREATE TRIGGER immutable_sec_acquisition_admissions BEFORE UPDATE OR DELETE ON sec_acquisition_admissions
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
