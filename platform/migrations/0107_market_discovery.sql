-- Owner/licence-isolated discovery observations, not a synthetic quote universe.
CREATE TABLE market_discovery_admissions(
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,
 source_revision uuid,query jsonb NOT NULL,fingerprint text NOT NULL,
 authorization_binding text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id),FOREIGN KEY(owner_id,source_revision) REFERENCES market_source_configs(owner_id,revision)
);
CREATE TABLE market_discovery_receipts(
 owner_id text NOT NULL,request_id uuid NOT NULL,source_revision uuid NOT NULL,
 license_revision text NOT NULL,policy_fingerprint text NOT NULL,query jsonb NOT NULL,query_hash text NOT NULL,
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id),FOREIGN KEY(owner_id,request_id) REFERENCES market_discovery_admissions(owner_id,request_id),
 FOREIGN KEY(owner_id,source_revision) REFERENCES market_source_configs(owner_id,revision)
);
CREATE TABLE market_discovery_pages(
 owner_id text NOT NULL,request_id uuid NOT NULL,id uuid NOT NULL,page_number integer NOT NULL CHECK(page_number BETWEEN 0 AND 99),
 role text NOT NULL,response_headers jsonb NOT NULL DEFAULT '{}'::jsonb,http_status integer CHECK(http_status BETWEEN 100 AND 599),raw_bytes bytea NOT NULL CHECK(octet_length(raw_bytes)<=8388608),
 raw_sha256 text NOT NULL CHECK(raw_sha256 ~ '^[a-f0-9]{64}$'),complete boolean NOT NULL,
 representation text NOT NULL CHECK(representation='http_response_body'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id,page_number),
 FOREIGN KEY(owner_id,request_id) REFERENCES market_discovery_admissions(owner_id,request_id),
 CHECK(encode(sha256(raw_bytes),'hex')=raw_sha256)
);
CREATE INDEX market_discovery_lookup ON market_discovery_receipts(owner_id,query_hash,created_at DESC,request_id);
CREATE TRIGGER immutable_market_discovery_admission BEFORE UPDATE OR DELETE ON market_discovery_admissions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_market_discovery_receipt BEFORE UPDATE OR DELETE ON market_discovery_receipts FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_market_discovery_page BEFORE UPDATE OR DELETE ON market_discovery_pages FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
