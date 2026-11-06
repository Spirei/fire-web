-- A diagnostic admitted before SDK I/O cannot be retried as an unknown new call.
CREATE TABLE market_diagnostic_admissions(
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,
 source_revision uuid NOT NULL,action text NOT NULL CHECK(action IN ('futu.test','futu.quota')),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,source_revision) REFERENCES market_source_configs(owner_id,revision)
);
CREATE TRIGGER immutable_market_diagnostic_admission BEFORE UPDATE OR DELETE ON market_diagnostic_admissions
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
