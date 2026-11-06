CREATE TABLE financial_report_scope (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740990)
);
INSERT INTO financial_report_scope(singleton) VALUES(true);
CREATE TABLE financial_report_files (
 id text PRIMARY KEY,
 market text NOT NULL,
 exchange text NOT NULL,
 company_code text NOT NULL,
 company_name text NOT NULL,
 fiscal_year integer NOT NULL CHECK(fiscal_year BETWEEN 1900 AND 2200),
 fiscal_period text NOT NULL,
 report_type text NOT NULL,
 file_kind text NOT NULL CHECK(file_kind IN ('original','parsed','export','filing')),
 file_name text NOT NULL,
 mime_type text NOT NULL,
 sha256 text NOT NULL REFERENCES admin_attachment_objects(sha256),
 byte_length bigint NOT NULL CHECK(byte_length BETWEEN 1 AND 52428800),
 uploaded_by text NOT NULL REFERENCES users(id),
 origin_instance uuid NOT NULL,
 source text NOT NULL DEFAULT 'manual' CHECK(source='manual'),
 source_verified boolean NOT NULL DEFAULT false CHECK(NOT source_verified),
 source_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 deleted_at timestamptz,
 deleted_by text REFERENCES users(id)
);
CREATE TABLE financial_report_operations (
 actor_id text NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL,
 fingerprint text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_id)
);
CREATE FUNCTION financial_report_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'report originals and receipts are immutable'; END IF;
 IF TG_TABLE_NAME='financial_report_operations' THEN RAISE EXCEPTION 'report receipts are immutable'; END IF;
 IF (to_jsonb(OLD)-'deleted_at'-'deleted_by') IS DISTINCT FROM (to_jsonb(NEW)-'deleted_at'-'deleted_by')
    OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL OR NEW.deleted_by IS NULL
 THEN RAISE EXCEPTION 'report original is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_report_original_guard BEFORE UPDATE OR DELETE ON financial_report_files
 FOR EACH ROW EXECUTE FUNCTION financial_report_immutable();
CREATE TRIGGER financial_report_receipt_guard BEFORE UPDATE OR DELETE ON financial_report_operations
 FOR EACH ROW EXECUTE FUNCTION financial_report_immutable();
