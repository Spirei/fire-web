-- Independently licensed public company/financial/calendar captures; no owner facts.
CREATE TABLE public_reference_licenses(id uuid PRIMARY KEY,policy_id text NOT NULL,policy_fingerprint text NOT NULL,license_revision text NOT NULL,origin_instance uuid NOT NULL,created_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public_reference_revocations(license_id uuid PRIMARY KEY REFERENCES public_reference_licenses(id),request_id uuid NOT NULL UNIQUE,created_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public_reference_receipts(request_id uuid PRIMARY KEY,request_hash text NOT NULL,result jsonb NOT NULL,created_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public_reference_admissions(request_id uuid PRIMARY KEY,request_hash text NOT NULL,license_id uuid NOT NULL REFERENCES public_reference_licenses(id),query jsonb NOT NULL,scope jsonb NOT NULL,origin_instance uuid NOT NULL,created_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE public_reference_pages(id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES public_reference_admissions(request_id),page_number integer NOT NULL CHECK(page_number BETWEEN 0 AND 3),kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),raw_bytes bytea NOT NULL CHECK(octet_length(raw_bytes)<=16777216),raw_sha256 text NOT NULL CHECK(encode(sha256(raw_bytes),'hex')=raw_sha256),http_status integer CHECK(http_status BETWEEN 100 AND 599),complete boolean NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(request_id,page_number));
CREATE TABLE public_reference_captures(request_id uuid PRIMARY KEY REFERENCES public_reference_admissions(request_id),license_id uuid NOT NULL REFERENCES public_reference_licenses(id),query jsonb NOT NULL,scope jsonb NOT NULL,payload jsonb NOT NULL,observed_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE INDEX public_reference_capture_scope ON public_reference_captures(license_id,observed_at);
CREATE FUNCTION guard_public_reference_capture() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE admitted public_reference_admissions;
BEGIN
 SELECT * INTO STRICT admitted FROM public_reference_admissions WHERE request_id=NEW.request_id;
 IF (NEW.license_id,NEW.query,NEW.scope) IS DISTINCT FROM (admitted.license_id,admitted.query,admitted.scope) THEN RAISE EXCEPTION 'public_reference_capture_binding'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER public_reference_capture_binding BEFORE INSERT ON public_reference_captures FOR EACH ROW EXECUTE FUNCTION guard_public_reference_capture();
CREATE TRIGGER public_reference_licenses_immutable BEFORE UPDATE OR DELETE ON public_reference_licenses FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER public_reference_revocations_immutable BEFORE UPDATE OR DELETE ON public_reference_revocations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER public_reference_receipts_immutable BEFORE UPDATE OR DELETE ON public_reference_receipts FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER public_reference_admissions_immutable BEFORE UPDATE OR DELETE ON public_reference_admissions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER public_reference_pages_immutable BEFORE UPDATE OR DELETE ON public_reference_pages FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER public_reference_captures_immutable BEFORE UPDATE OR DELETE ON public_reference_captures FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
