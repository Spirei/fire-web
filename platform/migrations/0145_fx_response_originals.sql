-- One bounded private response per durable FX attempt, including failures.
CREATE TABLE fx_response_pages (
 task_id uuid PRIMARY KEY REFERENCES fx_refresh_tasks(id),
 task_owner_id text REFERENCES users(id),provider_revision uuid REFERENCES fx_provider_revisions(id),
 origin_instance uuid NOT NULL,raw_bytes bytea NOT NULL,raw_sha256 text NOT NULL,
 representation text NOT NULL CHECK(representation IN ('http_response_body','http_decoded_response_body')),
 http_status integer CHECK(http_status BETWEEN 100 AND 599),complete boolean NOT NULL,
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(octet_length(raw_bytes)<=131072),
 CHECK(raw_sha256=encode(sha256(raw_bytes),'hex'))
);
CREATE FUNCTION guard_fx_response_page() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original fx_refresh_tasks;
BEGIN
 SELECT * INTO original FROM fx_refresh_tasks WHERE id=NEW.task_id;
 IF original.id IS NULL OR original.state<>'running'
 OR original.owner_id IS DISTINCT FROM NEW.task_owner_id
 OR original.provider_revision IS DISTINCT FROM NEW.provider_revision
 OR NEW.origin_instance IS DISTINCT FROM (SELECT instance_id FROM alcor_instance WHERE singleton)
 THEN RAISE EXCEPTION 'FX response requires its original admitted task/provider/owner/instance' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_fx_response_page BEFORE INSERT ON fx_response_pages FOR EACH ROW EXECUTE FUNCTION guard_fx_response_page();
CREATE TRIGGER retain_fx_response_page BEFORE UPDATE OR DELETE ON fx_response_pages FOR EACH ROW EXECUTE FUNCTION retain_reference_observation();
