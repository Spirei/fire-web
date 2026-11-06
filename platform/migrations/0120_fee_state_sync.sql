-- Sync metadata references the sole fee-plan revision authority; no duplicate rules.
ALTER TABLE fee_plan_heads ADD COLUMN retired_at timestamptz;
CREATE TABLE fee_state_fields(
 owner_id text NOT NULL REFERENCES users(id),field text NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),plan_id uuid,
 domain_revision bigint NOT NULL DEFAULT 0 CHECK(domain_revision>=0),
 tombstone boolean NOT NULL DEFAULT false,
 PRIMARY KEY(owner_id,field),CHECK(length(field)<=512)
);
CREATE TABLE fee_state_operations(
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,
 fingerprint text NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(owner_id,request_id)
);
CREATE TRIGGER fee_state_operations_immutable BEFORE UPDATE OR DELETE ON fee_state_operations
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
INSERT INTO account_change_sources(domain,source_table,owner_column,selected_columns,ignored_columns)
VALUES('settings','fee_state_fields','owner_id','','')
ON CONFLICT(domain,source_table) DO NOTHING;
CREATE TRIGGER account_signal_settings AFTER INSERT OR UPDATE OR DELETE ON fee_state_fields
 FOR EACH ROW EXECUTE FUNCTION capture_account_change('settings','owner_id','','');
