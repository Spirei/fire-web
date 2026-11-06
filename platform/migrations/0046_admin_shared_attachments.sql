-- Admin-shared attachment authority; actor is audit provenance, never a personal owner.
CREATE TABLE admin_attachment_scope (
 namespace text PRIMARY KEY CHECK(namespace='admin_shared'),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991)
);
INSERT INTO admin_attachment_scope(namespace) VALUES('admin_shared');
CREATE TABLE admin_attachment_objects (
 sha256 text PRIMARY KEY CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 byte_length bigint NOT NULL CHECK(byte_length BETWEEN 0 AND 52428800),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE admin_attachment_entries (
 id uuid PRIMARY KEY,
 namespace text NOT NULL DEFAULT 'admin_shared' REFERENCES admin_attachment_scope(namespace),
 parent_id uuid REFERENCES admin_attachment_entries(id),
 name text NOT NULL CHECK(name<>'' AND name NOT IN ('.','..') AND strpos(name,'/')=0 AND strpos(name,chr(92))=0 AND octet_length(name)<=255),
 kind text NOT NULL CHECK(kind IN ('directory','file')),
 current_version uuid,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 modified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 deleted_at timestamptz,
 CHECK(parent_id IS DISTINCT FROM id), CHECK(kind='file' OR current_version IS NULL)
);
CREATE UNIQUE INDEX admin_attachment_path ON admin_attachment_entries(coalesce(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),name) WHERE deleted_at IS NULL;
CREATE TABLE admin_attachment_versions (
 id uuid PRIMARY KEY, entry_id uuid NOT NULL REFERENCES admin_attachment_entries(id),
 sha256 text NOT NULL REFERENCES admin_attachment_objects(sha256),
 byte_length bigint NOT NULL CHECK(byte_length BETWEEN 0 AND 52428800),
 original_name text NOT NULL, created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(entry_id,id)
);
ALTER TABLE admin_attachment_entries ADD FOREIGN KEY(id,current_version) REFERENCES admin_attachment_versions(entry_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE admin_attachment_operations (
 namespace text NOT NULL DEFAULT 'admin_shared' REFERENCES admin_attachment_scope(namespace),
 request_id uuid NOT NULL, actor_id text NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(namespace,request_id)
);
CREATE FUNCTION guard_admin_attachment_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p uuid; visited uuid[];
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('admin-shared-attachments',0));
 IF TG_OP='UPDATE' AND (NEW.id,NEW.namespace,NEW.kind,NEW.created_by,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.namespace,OLD.kind,OLD.created_by,OLD.created_at) THEN RAISE EXCEPTION 'immutable attachment identity'; END IF;
 IF TG_OP='UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'immutable attachment tombstone'; END IF;
 IF NEW.deleted_at IS NULL THEN
  p:=NEW.parent_id;visited:=ARRAY[NEW.id];
  WHILE p IS NOT NULL LOOP
   IF p=ANY(visited) THEN RAISE EXCEPTION 'attachment directory cycle'; END IF;
   visited:=array_append(visited,p);
   SELECT parent_id INTO p FROM admin_attachment_entries WHERE id=p AND namespace=NEW.namespace AND kind='directory' AND deleted_at IS NULL;
   IF NOT FOUND THEN RAISE EXCEPTION 'unavailable attachment parent'; END IF;
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER admin_attachment_entry_guard BEFORE INSERT OR UPDATE ON admin_attachment_entries FOR EACH ROW EXECUTE FUNCTION guard_admin_attachment_entry();
CREATE FUNCTION check_admin_attachment_current() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM admin_attachment_entries WHERE id=NEW.id AND deleted_at IS NULL AND kind='file' AND current_version IS NULL) THEN RAISE EXCEPTION 'active attachment needs immutable original'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER admin_attachment_current_guard AFTER INSERT OR UPDATE ON admin_attachment_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_admin_attachment_current();
CREATE FUNCTION guard_admin_attachment_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM admin_attachment_objects WHERE sha256=NEW.sha256 AND byte_length=NEW.byte_length) THEN RAISE EXCEPTION 'attachment original size mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER admin_attachment_version_guard BEFORE INSERT ON admin_attachment_versions FOR EACH ROW EXECUTE FUNCTION guard_admin_attachment_version();
CREATE FUNCTION immutable_admin_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only attachment original and receipt'; END $$;
CREATE TRIGGER admin_attachment_object_immutable BEFORE UPDATE OR DELETE ON admin_attachment_objects FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TRIGGER admin_attachment_version_immutable BEFORE UPDATE OR DELETE ON admin_attachment_versions FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TRIGGER admin_attachment_operation_immutable BEFORE UPDATE OR DELETE ON admin_attachment_operations FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
