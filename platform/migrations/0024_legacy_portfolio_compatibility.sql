-- Legacy presentation metadata and immutable offline receipt provenance.
CREATE TABLE portfolio_legacy_ordering (
 owner_id text NOT NULL,
 record_id text NOT NULL,
 display_timestamp timestamptz NOT NULL,
 PRIMARY KEY(owner_id,record_id),
 FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id)
);
CREATE FUNCTION invalidate_legacy_record_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM portfolio_legacy_ordering WHERE owner_id=NEW.owner_id AND record_id=NEW.id;
 RETURN NEW;
END $$;
CREATE TRIGGER invalidate_legacy_record_order AFTER UPDATE OF updated_at ON portfolio_records
FOR EACH ROW EXECUTE FUNCTION invalidate_legacy_record_order();
-- Explicit offline-source receipts are separate from newly confirmed previews.
-- The reservation prevents an imported request UUID being re-executed as a new request.
CREATE TABLE portfolio_request_reservations (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 source_kind text NOT NULL CHECK(source_kind IN ('canonical','legacy-import')),
 PRIMARY KEY(owner_id,request_id)
);
INSERT INTO portfolio_request_reservations SELECT owner_id,request_id,'canonical' FROM portfolio_record_operations;
CREATE TABLE portfolio_legacy_receipts (
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,
 source_instance uuid NOT NULL,source_owner_id text NOT NULL,
 import_batch uuid NOT NULL,original_json bytea NOT NULL,
 original_sha256 text NOT NULL CHECK(original_sha256 ~ '^[a-f0-9]{64}$'),
 imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id),
 FOREIGN KEY(owner_id,request_id) REFERENCES portfolio_request_reservations(owner_id,request_id)
);
CREATE FUNCTION reserve_portfolio_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO portfolio_request_reservations(owner_id,request_id,source_kind)
 VALUES(NEW.owner_id,NEW.request_id,CASE WHEN TG_TABLE_NAME='portfolio_legacy_receipts' THEN 'legacy-import' ELSE 'canonical' END);
 RETURN NEW;
END $$;
CREATE TRIGGER reserve_canonical_portfolio_request BEFORE INSERT ON portfolio_record_operations
FOR EACH ROW EXECUTE FUNCTION reserve_portfolio_request();
CREATE TRIGGER reserve_imported_portfolio_request BEFORE INSERT ON portfolio_legacy_receipts
FOR EACH ROW EXECUTE FUNCTION reserve_portfolio_request();
CREATE FUNCTION retain_original_portfolio_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'imported receipt provenance and bytes are immutable';
END $$;
CREATE TRIGGER retain_original_portfolio_receipt BEFORE UPDATE OR DELETE ON portfolio_legacy_receipts
FOR EACH ROW EXECUTE FUNCTION retain_original_portfolio_receipt();

CREATE TRIGGER retain_portfolio_request_reservation BEFORE UPDATE OR DELETE ON portfolio_request_reservations
FOR EACH ROW EXECUTE FUNCTION retain_original_portfolio_receipt();
ALTER TABLE portfolio_legacy_receipts ADD CHECK(octet_length(original_json) BETWEEN 1 AND 262144);
