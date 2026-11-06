-- Global migration evidence; actor is audit provenance, never a personal file owner.
CREATE TABLE admin_attachment_source_manifests (
 id uuid PRIMARY KEY,
 platform_instance uuid NOT NULL,
 source_alias text NOT NULL,
 binding_hash text NOT NULL CHECK(binding_hash ~ '^[a-f0-9]{64}$'),
 manifest jsonb NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('sealed','partial')),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE admin_attachment_source_items (
 manifest_id uuid NOT NULL REFERENCES admin_attachment_source_manifests(id),
 ordinal integer NOT NULL CHECK(ordinal>=0),
 evidence jsonb NOT NULL,
 PRIMARY KEY(manifest_id,ordinal)
);
CREATE TABLE admin_attachment_source_progress (
 manifest_id uuid PRIMARY KEY REFERENCES admin_attachment_source_manifests(id),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991)
);
CREATE TABLE admin_attachment_source_results (
 manifest_id uuid NOT NULL,
 ordinal integer NOT NULL,
 state text NOT NULL CHECK(state IN ('applied','blocked')),
 result jsonb NOT NULL,
 request_id uuid NOT NULL,
 PRIMARY KEY(manifest_id,ordinal),
 FOREIGN KEY(manifest_id,ordinal) REFERENCES admin_attachment_source_items(manifest_id,ordinal)
);
CREATE TABLE admin_attachment_source_links (
 binding_hash text NOT NULL CHECK(binding_hash ~ '^[a-f0-9]{64}$'),
 source_path text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('directory','file')),
 sha256 text,
 byte_length bigint,
 entry_id uuid NOT NULL REFERENCES admin_attachment_entries(id),
 version_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(binding_hash,source_path),
 FOREIGN KEY(entry_id,version_id) REFERENCES admin_attachment_versions(entry_id,id),
 CHECK((kind='directory' AND sha256 IS NULL AND byte_length IS NULL AND version_id IS NULL) OR (kind='file' AND sha256 IS NOT NULL AND byte_length IS NOT NULL AND sha256 ~ '^[a-f0-9]{64}$' AND byte_length BETWEEN 0 AND 52428800 AND version_id IS NOT NULL))
);
CREATE FUNCTION guard_admin_attachment_source_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM admin_attachment_entries WHERE id=NEW.entry_id AND kind=NEW.kind AND namespace='admin_shared' AND deleted_at IS NULL)
 OR (NEW.kind='file' AND NOT EXISTS(SELECT 1 FROM admin_attachment_versions WHERE id=NEW.version_id AND entry_id=NEW.entry_id AND sha256=NEW.sha256 AND byte_length=NEW.byte_length))
 THEN RAISE EXCEPTION 'source attachment link identity mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER admin_attachment_source_link_guard BEFORE INSERT ON admin_attachment_source_links FOR EACH ROW EXECUTE FUNCTION guard_admin_attachment_source_link();
CREATE TRIGGER admin_attachment_source_manifest_immutable BEFORE UPDATE OR DELETE ON admin_attachment_source_manifests FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TRIGGER admin_attachment_source_item_immutable BEFORE UPDATE OR DELETE ON admin_attachment_source_items FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TRIGGER admin_attachment_source_link_immutable BEFORE UPDATE OR DELETE ON admin_attachment_source_links FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
