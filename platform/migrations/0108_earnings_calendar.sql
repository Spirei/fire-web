CREATE TABLE earnings_calendar_admissions (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 source_revision uuid NOT NULL, request_hash text NOT NULL,
 market text NOT NULL CHECK(market IN ('US','CN','HK')), month text NOT NULL,
 page_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,source_revision) REFERENCES market_source_configs(owner_id,revision)
);
CREATE TRIGGER immutable_earnings_admission BEFORE UPDATE OR DELETE ON earnings_calendar_admissions
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TABLE earnings_calendar_pages (
 owner_id text NOT NULL, request_id uuid NOT NULL, id uuid NOT NULL,
 source_revision uuid NOT NULL, policy_fingerprint text NOT NULL, license_revision text NOT NULL,
 market text NOT NULL, month text NOT NULL, page_key text NOT NULL,
 raw_bytes bytea NOT NULL CHECK(octet_length(raw_bytes)<=2097152),
 raw_sha256 text NOT NULL CHECK(raw_sha256 ~ '^[a-f0-9]{64}$'), result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id), UNIQUE(owner_id,request_id),
 FOREIGN KEY(owner_id,request_id) REFERENCES earnings_calendar_admissions(owner_id,request_id),
 FOREIGN KEY(owner_id,source_revision) REFERENCES market_source_configs(owner_id,revision),
 CHECK(encode(sha256(raw_bytes),'hex')=raw_sha256)
);
CREATE INDEX earnings_calendar_latest ON earnings_calendar_pages(owner_id,market,month,source_revision,page_key,created_at DESC);
CREATE TRIGGER immutable_earnings_page BEFORE UPDATE OR DELETE ON earnings_calendar_pages
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
