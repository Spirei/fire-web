-- Shared immutable card metadata snapshots are separate from each owner's custom cards.
CREATE TABLE card_catalog_scope (
 singleton boolean PRIMARY KEY CHECK(singleton), revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 current_source uuid
);
INSERT INTO card_catalog_scope(singleton) VALUES(true);
CREATE TABLE card_catalog_sources (
 id uuid PRIMARY KEY, sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 source_label text NOT NULL CHECK(length(source_label) BETWEEN 1 AND 120),
 manifest jsonb NOT NULL, original_text text NOT NULL CHECK(octet_length(original_text)<=2097152), card_count integer NOT NULL CHECK(card_count>=0),
 imported_by text NOT NULL REFERENCES users(id), imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE card_catalog_scope ADD FOREIGN KEY(current_source) REFERENCES card_catalog_sources(id);
CREATE TABLE card_custom_records (
 owner_id text NOT NULL REFERENCES users(id), id uuid NOT NULL,
 metadata jsonb NOT NULL, image_path text NOT NULL, image_version uuid REFERENCES system_asset_versions(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), deleted_at timestamptz,
 PRIMARY KEY(owner_id,id)
);
CREATE INDEX card_custom_images ON card_custom_records(image_path) WHERE deleted_at IS NULL;
CREATE TABLE card_catalog_public_index (
 image_path text PRIMARY KEY, metadata jsonb NOT NULL,
 image_version uuid REFERENCES system_asset_versions(id),
 updated_by text NOT NULL REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 deleted_at timestamptz
);
CREATE TABLE card_catalog_operations (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id)
);
CREATE TRIGGER card_catalog_source_immutable BEFORE UPDATE OR DELETE ON card_catalog_sources
 FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
