CREATE TABLE asset_catalog_scope(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740990));
INSERT INTO asset_catalog_scope(singleton) VALUES(true);
CREATE TABLE asset_catalog_sources(
 id uuid PRIMARY KEY,actor_id text NOT NULL REFERENCES users(id),source_label text NOT NULL,
 sha256 text NOT NULL,original_text text NOT NULL,manifest jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE asset_catalog_entries(
 id text PRIMARY KEY,type text NOT NULL CHECK(type IN ('stock','market','flag','crypto','metal')),
 market text NOT NULL,code text NOT NULL,name text NOT NULL,
 source_id uuid NOT NULL REFERENCES asset_catalog_sources(id),
 light_version uuid REFERENCES system_asset_versions(id),dark_version uuid REFERENCES system_asset_versions(id),
 material_state jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX asset_catalog_exact ON asset_catalog_entries(type,upper(market),upper(code));
CREATE TABLE asset_catalog_image_keys(
 key text PRIMARY KEY CHECK(key ~ '^[a-f0-9]{24}$'),asset_id text NOT NULL REFERENCES asset_catalog_entries(id),
 variant text NOT NULL CHECK(variant IN ('light','dark')),UNIQUE(asset_id,variant)
);
CREATE TABLE asset_catalog_aliases(
 alias text PRIMARY KEY,key text NOT NULL REFERENCES asset_catalog_image_keys(key),
 source_id uuid NOT NULL REFERENCES asset_catalog_sources(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE asset_catalog_operations(
 actor_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(actor_id,request_id)
);
CREATE TRIGGER asset_catalog_source_immutable BEFORE UPDATE OR DELETE ON asset_catalog_sources FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TRIGGER asset_catalog_operation_immutable BEFORE UPDATE OR DELETE ON asset_catalog_operations FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TRIGGER asset_catalog_alias_immutable BEFORE UPDATE OR DELETE ON asset_catalog_aliases FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TRIGGER asset_catalog_key_immutable BEFORE UPDATE OR DELETE ON asset_catalog_image_keys FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE FUNCTION guard_asset_catalog_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id,NEW.type,NEW.market,NEW.code,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.type,OLD.market,OLD.code,OLD.created_at)
 THEN RAISE EXCEPTION 'asset identity is immutable'; END IF;
 IF NEW.light_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM system_asset_versions WHERE id=NEW.light_version AND kind='asset' AND folder=NEW.type)
 OR NEW.dark_version IS NOT NULL AND NOT EXISTS(SELECT 1 FROM system_asset_versions WHERE id=NEW.dark_version AND kind='asset' AND folder=NEW.type)
 THEN RAISE EXCEPTION 'asset image is not a registered public version'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER asset_catalog_identity_guard BEFORE INSERT OR UPDATE ON asset_catalog_entries FOR EACH ROW EXECUTE FUNCTION guard_asset_catalog_identity();
