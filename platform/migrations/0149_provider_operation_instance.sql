-- Historical provider probes have no proven origin instance; never invent it.
ALTER TABLE provider_setting_operations ADD COLUMN origin_instance uuid;
COMMENT ON COLUMN provider_setting_operations.origin_instance IS 'Original explicit admission instance; null means legacy origin unknown, not current authorization.';
CREATE FUNCTION bind_provider_operation_instance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.origin_instance IS NULL OR NOT EXISTS(SELECT 1 FROM alcor_instance WHERE singleton AND instance_id=NEW.origin_instance)
 THEN RAISE EXCEPTION 'provider admission requires current instance' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bind_provider_operation_instance BEFORE INSERT ON provider_setting_operations FOR EACH ROW EXECUTE FUNCTION bind_provider_operation_instance();
