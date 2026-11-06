-- Explicitly installed host capability, never an implicit client clipboard proxy.
CREATE TABLE host_clipboard_operations(owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,image_sha256 text NOT NULL,byte_length integer NOT NULL CHECK(byte_length BETWEEN 1 AND 8388608),origin_instance uuid NOT NULL,result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id));
CREATE FUNCTION retain_host_clipboard_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'result') IS DISTINCT FROM (to_jsonb(OLD)-'result') OR OLD.result IS NOT NULL THEN RAISE EXCEPTION 'host clipboard receipt retained' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER retain_host_clipboard_operation BEFORE UPDATE OR DELETE ON host_clipboard_operations FOR EACH ROW EXECUTE FUNCTION retain_host_clipboard_operation();
