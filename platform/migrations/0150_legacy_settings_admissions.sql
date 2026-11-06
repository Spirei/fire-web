-- One complete legacy settings intent owns the preflight; a replay cannot steal it.
CREATE TABLE legacy_settings_admissions(
 actor_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,
 fingerprint text NOT NULL,origin_instance uuid NOT NULL,admission_id uuid NOT NULL,
 child_request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_id),UNIQUE(admission_id));
CREATE TRIGGER immutable_legacy_settings_admission BEFORE UPDATE OR DELETE ON legacy_settings_admissions
 FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE FUNCTION bind_legacy_settings_admission_instance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM alcor_instance WHERE singleton AND instance_id=NEW.origin_instance)
 THEN RAISE EXCEPTION 'legacy settings admission requires current instance' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bind_legacy_settings_admission_instance BEFORE INSERT ON legacy_settings_admissions
 FOR EACH ROW EXECUTE FUNCTION bind_legacy_settings_admission_instance();
