-- Administrator-published system images; original and served bytes share the
-- existing global immutable blob registry, never a personal resource owner.
CREATE TABLE system_asset_scope (
 namespace text PRIMARY KEY CHECK(namespace='system_public'),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 9007199254740991)
);
INSERT INTO system_asset_scope(namespace) VALUES('system_public');
CREATE TABLE system_asset_versions (
 id uuid PRIMARY KEY,
 namespace text NOT NULL DEFAULT 'system_public' REFERENCES system_asset_scope(namespace),
 public_path text NOT NULL CHECK(public_path ~ '^/uploads/(ico|background|logo|login|asset)/[A-Za-z0-9._/-]+$' AND strpos(public_path,'..')=0 AND length(public_path)<=512),
 kind text NOT NULL CHECK(kind IN ('ico','background','logo','login','asset')),
 folder text NOT NULL, market text NOT NULL,
 original_sha256 text NOT NULL REFERENCES admin_attachment_objects(sha256),
 served_sha256 text NOT NULL REFERENCES admin_attachment_objects(sha256),
 original_size bigint NOT NULL CHECK(original_size BETWEEN 1 AND 20971520),
 served_size bigint NOT NULL CHECK(served_size BETWEEN 1 AND 21037056),
 media_type text NOT NULL CHECK(media_type IN ('image/jpeg','image/png','image/gif','image/webp','image/x-icon','image/svg+xml')),
 created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE system_asset_paths (
 public_path text PRIMARY KEY,
 current_version uuid NOT NULL REFERENCES system_asset_versions(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE system_asset_operations (
 request_id uuid PRIMARY KEY, actor_id text NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_system_asset_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM admin_attachment_objects WHERE sha256=NEW.original_sha256 AND byte_length=NEW.original_size)
 OR NOT EXISTS(SELECT 1 FROM admin_attachment_objects WHERE sha256=NEW.served_sha256 AND byte_length=NEW.served_size)
 THEN RAISE EXCEPTION 'system asset bytes mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER system_asset_version_guard BEFORE INSERT ON system_asset_versions FOR EACH ROW EXECUTE FUNCTION guard_system_asset_version();
CREATE FUNCTION guard_system_asset_path() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('system-public-assets',0));
 IF TG_OP='UPDATE' AND NEW.public_path IS DISTINCT FROM OLD.public_path THEN RAISE EXCEPTION 'immutable system asset path'; END IF;
 IF NOT EXISTS(SELECT 1 FROM system_asset_versions WHERE id=NEW.current_version AND public_path=NEW.public_path)
 THEN RAISE EXCEPTION 'system asset path mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER system_asset_path_guard BEFORE INSERT OR UPDATE ON system_asset_paths FOR EACH ROW EXECUTE FUNCTION guard_system_asset_path();
CREATE TRIGGER system_asset_version_immutable BEFORE UPDATE OR DELETE ON system_asset_versions FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
CREATE TRIGGER system_asset_operation_immutable BEFORE UPDATE OR DELETE ON system_asset_operations FOR EACH ROW EXECUTE FUNCTION immutable_admin_attachment();
