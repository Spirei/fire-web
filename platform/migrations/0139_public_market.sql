CREATE TABLE public_market_licenses (
 id uuid PRIMARY KEY, policy_id text NOT NULL, policy_fingerprint text NOT NULL CHECK(policy_fingerprint ~ '^[a-f0-9]{64}$'),
 license_revision text NOT NULL, origin_instance uuid NOT NULL, created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public_market_receipts (
 request_id uuid PRIMARY KEY, request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL CHECK(octet_length(result::text)<=262144), created_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public_market_revocations (
 license_id uuid PRIMARY KEY REFERENCES public_market_licenses(id), request_id uuid NOT NULL UNIQUE,
 created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public_market_tasks (
 id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE, license_id uuid NOT NULL REFERENCES public_market_licenses(id),
 query jsonb NOT NULL CHECK(jsonb_typeof(query)='object' AND octet_length(query::text)<=8192),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','unknown','cancelled')),
 lease_owner text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz, error_code text,
 UNIQUE(id,license_id)
);
CREATE INDEX public_market_task_queue ON public_market_tasks(created_at) WHERE status='queued';
CREATE TABLE public_market_pages (
 id uuid PRIMARY KEY, task_id uuid NOT NULL UNIQUE REFERENCES public_market_tasks(id),
 raw_bytes bytea NOT NULL CHECK(octet_length(raw_bytes)<=16777216),
 raw_sha256 text NOT NULL CHECK(raw_sha256 ~ '^[a-f0-9]{64}$' AND encode(sha256(raw_bytes),'hex')=raw_sha256),
 representation text NOT NULL, http_status integer CHECK(http_status BETWEEN 100 AND 599),
 complete boolean NOT NULL, issues jsonb NOT NULL DEFAULT '[]' CHECK(octet_length(issues::text)<=65536),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(id,task_id)
);
CREATE TABLE public_market_facts (
 id uuid PRIMARY KEY, task_id uuid NOT NULL, page_id uuid NOT NULL, license_id uuid NOT NULL,
 query jsonb NOT NULL, source_time timestamptz NOT NULL,
 contents jsonb NOT NULL CHECK(jsonb_typeof(contents)='object' AND octet_length(contents::text)<=1048576),
 published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(task_id,license_id) REFERENCES public_market_tasks(id,license_id),
 FOREIGN KEY(page_id,task_id) REFERENCES public_market_pages(id,task_id), UNIQUE(task_id,source_time)
);
CREATE INDEX public_market_fact_read ON public_market_facts(license_id,source_time DESC);
CREATE FUNCTION guard_public_market_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'public_market_task_immutable'; END IF;
 IF (NEW.id,NEW.request_id,NEW.license_id,NEW.query,NEW.created_at) IS DISTINCT FROM
    (OLD.id,OLD.request_id,OLD.license_id,OLD.query,OLD.created_at)
    OR OLD.status IN ('completed','failed','unknown','cancelled') THEN
  RAISE EXCEPTION 'public_market_task_admission_immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER public_market_task_guard BEFORE UPDATE OR DELETE ON public_market_tasks FOR EACH ROW EXECUTE FUNCTION guard_public_market_task();
CREATE FUNCTION guard_public_market_fact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t public_market_tasks; p public_market_pages;
BEGIN
 SELECT * INTO STRICT t FROM public_market_tasks WHERE id=NEW.task_id;
 SELECT * INTO STRICT p FROM public_market_pages WHERE id=NEW.page_id;
 IF NEW.license_id<>t.license_id OR NEW.query<>t.query OR p.task_id<>t.id OR NOT p.complete
    OR (p.http_status IS NOT NULL AND p.http_status<>200) OR t.status<>'running'
    OR jsonb_typeof(NEW.contents->'at') IS DISTINCT FROM 'string'
    OR NEW.contents->>'at' !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
    OR (NEW.contents->>'at')::timestamptz IS DISTINCT FROM NEW.source_time
 THEN RAISE EXCEPTION 'public_market_fact_binding'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER public_market_fact_binding BEFORE INSERT ON public_market_facts FOR EACH ROW EXECUTE FUNCTION guard_public_market_fact();
CREATE TRIGGER public_market_license_immutable BEFORE UPDATE OR DELETE ON public_market_licenses FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER public_market_revocation_immutable BEFORE UPDATE OR DELETE ON public_market_revocations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER public_market_receipt_immutable BEFORE UPDATE OR DELETE ON public_market_receipts FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER public_market_page_immutable BEFORE UPDATE OR DELETE ON public_market_pages FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER public_market_fact_immutable BEFORE UPDATE OR DELETE ON public_market_facts FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
