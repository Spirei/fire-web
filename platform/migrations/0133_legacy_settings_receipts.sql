CREATE TABLE legacy_settings_receipts(
 actor_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,
 fingerprint text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_id)
);
CREATE TRIGGER immutable_legacy_settings_receipt BEFORE UPDATE OR DELETE ON legacy_settings_receipts
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
