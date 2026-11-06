-- Candidate migration: immutable source evidence plus links into the existing ledgers.
CREATE TABLE financial_import_uploads (
 owner_id text NOT NULL REFERENCES users(id), id uuid NOT NULL, manifest jsonb NOT NULL,
 byte_count integer NOT NULL CHECK(byte_count BETWEEN 1 AND 16777216),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), sealed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,id)
);
CREATE TABLE financial_import_chunks (
 owner_id text NOT NULL, upload_id uuid NOT NULL, part integer NOT NULL CHECK(part BETWEEN 0 AND 511),
 raw bytea NOT NULL CHECK(octet_length(raw) BETWEEN 1 AND 32768),
 PRIMARY KEY(owner_id,upload_id,part), FOREIGN KEY(owner_id,upload_id) REFERENCES financial_import_uploads(owner_id,id)
);
CREATE TABLE financial_import_sources (
 owner_id text NOT NULL REFERENCES users(id), id uuid NOT NULL,
 source_instance text NOT NULL, source_owner text NOT NULL, source_version text NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), raw bytea NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,id),
 UNIQUE(owner_id,source_instance,source_owner,source_version)
);
CREATE TABLE financial_import_previews (
 token_hash text PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), session_hash text NOT NULL,
 fingerprint text NOT NULL, dependencies jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes', consumed_at timestamptz
);
CREATE TABLE financial_import_operations (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL, fingerprint text NOT NULL,
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id)
);
-- These are provenance links, never a second balance or position authority.
CREATE TABLE financial_import_links (
 owner_id text NOT NULL, source_id uuid NOT NULL, source_instance text NOT NULL, source_owner text NOT NULL,
 object_kind text NOT NULL CHECK(object_kind IN ('record','cash','order')), original_id text NOT NULL,
 original_uuid uuid, source_version text NOT NULL, source_sha256 text NOT NULL,
 target_id text NOT NULL, operation_id uuid NOT NULL, original jsonb NOT NULL,
 PRIMARY KEY(owner_id,source_instance,source_owner,object_kind,original_id),
 FOREIGN KEY(owner_id,source_id) REFERENCES financial_import_sources(owner_id,id),
 FOREIGN KEY(owner_id,operation_id) REFERENCES financial_import_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION immutable_financial_import_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'financial import evidence is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_financial_import_sources BEFORE UPDATE OR DELETE ON financial_import_sources
 FOR EACH ROW EXECUTE FUNCTION immutable_financial_import_evidence();
CREATE TRIGGER immutable_financial_import_links BEFORE UPDATE OR DELETE ON financial_import_links
 FOR EACH ROW EXECUTE FUNCTION immutable_financial_import_evidence();
CREATE TRIGGER immutable_financial_import_receipts BEFORE UPDATE OR DELETE ON financial_import_operations
 FOR EACH ROW EXECUTE FUNCTION immutable_financial_import_evidence();
ALTER TABLE trade_ledger DROP CONSTRAINT trade_ledger_source_check;
ALTER TABLE trade_ledger ADD CONSTRAINT trade_ledger_source_check CHECK(source IN ('owner_recorded','broker_reported','legacy_import_zero','unverified_legacy'));
-- Imported old pending intent stays explicitly suspended, with no resource reservation or execution.
ALTER TABLE internal_orders DROP CONSTRAINT internal_orders_status_check;
ALTER TABLE internal_orders ADD CONSTRAINT internal_orders_status_check
 CHECK(status IN ('pending','cancelled','imported_suspended'));
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='internal_orders'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%cancelled_at%' LOOP
  EXECUTE format('ALTER TABLE internal_orders DROP CONSTRAINT %I',item.conname);
 END LOOP;
END $$;
ALTER TABLE internal_orders ADD CONSTRAINT internal_orders_status_time CHECK(
 (status IN ('pending','imported_suspended') AND cancelled_at IS NULL) OR
 (status='cancelled' AND cancelled_at IS NOT NULL));
ALTER TABLE internal_orders DROP CONSTRAINT internal_orders_order_type_check;
ALTER TABLE internal_orders ADD CONSTRAINT internal_orders_order_type_check CHECK(order_type IN ('limit','imported'));
ALTER TABLE internal_orders ADD COLUMN import_original_status text;
ALTER TABLE internal_orders ADD COLUMN import_original_intent jsonb;
ALTER TABLE internal_orders ADD CONSTRAINT internal_orders_import_metadata CHECK(
 (order_type='imported' AND status IN ('cancelled','imported_suspended')
  AND import_original_status IN ('pending','cancelled','canceled','expired','rejected') AND import_original_intent IS NOT NULL)
 OR (order_type='limit' AND import_original_status IS NULL AND import_original_intent IS NULL));
