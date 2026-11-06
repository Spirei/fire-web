CREATE TABLE public_discovery_licenses (
 id uuid PRIMARY KEY, policy_id text NOT NULL, policy_fingerprint text NOT NULL CHECK(policy_fingerprint ~ '^[a-f0-9]{64}$'),
 license_revision text NOT NULL, origin_instance uuid NOT NULL, created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public_discovery_revocations (
 license_id uuid PRIMARY KEY REFERENCES public_discovery_licenses(id),request_id uuid NOT NULL UNIQUE,created_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public_discovery_operations (
 request_id uuid PRIMARY KEY,created_by text NOT NULL REFERENCES users(id),request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 license_id uuid NOT NULL REFERENCES public_discovery_licenses(id),query jsonb,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public_discovery_pages (
 id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE REFERENCES public_discovery_operations(request_id),raw_bytes bytea NOT NULL CHECK(octet_length(raw_bytes)<=8388608),
 raw_sha256 text NOT NULL CHECK(encode(sha256(raw_bytes),'hex')=raw_sha256),http_status integer CHECK(http_status BETWEEN 100 AND 599),complete boolean NOT NULL,
 representation text NOT NULL DEFAULT 'http_response_body',received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public_discovery_results (
 request_id uuid PRIMARY KEY REFERENCES public_discovery_operations(request_id),page_id uuid REFERENCES public_discovery_pages(id),
 result jsonb NOT NULL CHECK(octet_length(result::text)<=8388608),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX public_discovery_read ON public_discovery_operations USING gin(query);
CREATE FUNCTION public_discovery_result_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.page_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public_discovery_pages WHERE id=NEW.page_id AND request_id=NEW.request_id)
 THEN RAISE EXCEPTION 'public_discovery_page_binding'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER public_discovery_result_binding BEFORE INSERT ON public_discovery_results FOR EACH ROW EXECUTE FUNCTION public_discovery_result_binding();
CREATE TRIGGER immutable_public_discovery_licenses BEFORE UPDATE OR DELETE ON public_discovery_licenses FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_public_discovery_revocations BEFORE UPDATE OR DELETE ON public_discovery_revocations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_public_discovery_operations BEFORE UPDATE OR DELETE ON public_discovery_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_public_discovery_pages BEFORE UPDATE OR DELETE ON public_discovery_pages FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_public_discovery_results BEFORE UPDATE OR DELETE ON public_discovery_results FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
