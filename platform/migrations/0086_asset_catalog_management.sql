CREATE TABLE asset_catalog_tombstones(
 asset_id text PRIMARY KEY,deleted_at timestamptz NOT NULL DEFAULT clock_timestamp(),deleted_by text NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL,restored_at timestamptz,restored_by text REFERENCES users(id),restored_request_id uuid,
 CHECK((restored_at IS NULL)=(restored_by IS NULL)),CHECK((restored_at IS NULL)=(restored_request_id IS NULL))
);
CREATE TABLE asset_catalog_management_events(
 id uuid PRIMARY KEY,actor_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,asset_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('upsert','rename','delete','restore')),
 before_snapshot jsonb,after_snapshot jsonb,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(actor_id,request_id)
);
CREATE TRIGGER asset_catalog_management_event_immutable BEFORE UPDATE OR DELETE ON asset_catalog_management_events
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
-- A pure derived key on the original authority avoids a public unbounded scan.
-- convert_to/textsend are STABLE in PostgreSQL, so use a normal column/index
-- maintained in the publication transaction rather than an invalid expression index.
ALTER TABLE card_catalog_public_index ADD COLUMN asset_lookup_key text;
UPDATE card_catalog_public_index SET asset_lookup_key=left(encode(sha256(convert_to('card:'||image_path,'UTF8')||decode('00','hex')||convert_to('light','UTF8')),'hex'),24);
ALTER TABLE card_catalog_public_index ALTER COLUMN asset_lookup_key SET NOT NULL;
CREATE FUNCTION refresh_card_asset_lookup_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.asset_lookup_key=left(encode(sha256(convert_to('card:'||NEW.image_path,'UTF8')||decode('00','hex')||convert_to('light','UTF8')),'hex'),24);
 RETURN NEW;
END $$;
CREATE TRIGGER refresh_card_asset_lookup_key BEFORE INSERT OR UPDATE ON card_catalog_public_index
 FOR EACH ROW EXECUTE FUNCTION refresh_card_asset_lookup_key();
CREATE INDEX card_public_asset_hash ON card_catalog_public_index(asset_lookup_key)
 WHERE deleted_at IS NULL AND image_version IS NOT NULL;
