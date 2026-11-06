-- Display preferences only; holdings, financial records, group definitions and fee plans remain separate authorities.
CREATE TABLE watch_display_fields(owner_id text NOT NULL REFERENCES users(id),field text NOT NULL CHECK(length(field) BETWEEN 1 AND 512),
  revision bigint NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),value jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,field));
CREATE TABLE watch_display_operations(owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id));
CREATE TRIGGER immutable_watch_display_receipt BEFORE UPDATE OR DELETE ON watch_display_operations
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER retain_watch_display_tombstone BEFORE DELETE ON watch_display_fields
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
INSERT INTO account_change_sources VALUES('watch','watch_display_fields','owner_id','','');
CREATE TRIGGER account_signal_watch AFTER INSERT OR UPDATE OR DELETE ON watch_display_fields
 FOR EACH ROW EXECUTE FUNCTION capture_account_change('watch','owner_id','','');
