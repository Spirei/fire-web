-- Owner-bound versions reuse the existing private SHA byte registry and group receipts.
CREATE TABLE watch_group_icon_versions (
 id uuid PRIMARY KEY,
 owner_id text NOT NULL,
 group_id text NOT NULL,
 legacy_path text NOT NULL CHECK(legacy_path ~ '^/uploads/asset/group/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/[A-Za-z0-9._-]+$' AND strpos(legacy_path,'..')=0),
 original_sha256 text NOT NULL,
 served_sha256 text NOT NULL,
 original_size bigint NOT NULL CHECK(original_size BETWEEN 1 AND 2097152),
 served_size bigint NOT NULL CHECK(served_size BETWEEN 1 AND 2162688),
 media_type text NOT NULL CHECK(media_type IN ('image/jpeg','image/png','image/gif','image/webp','image/svg+xml')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(owner_id,group_id) REFERENCES watch_groups(owner_id,id),
 FOREIGN KEY(owner_id,original_sha256) REFERENCES resource_media_objects(owner_id,sha256),
 FOREIGN KEY(owner_id,served_sha256) REFERENCES resource_media_objects(owner_id,sha256)
);
CREATE INDEX watch_group_icon_history ON watch_group_icon_versions(owner_id,group_id,created_at,id);
CREATE INDEX watch_group_icon_reference ON watch_group_icon_versions(owner_id,legacy_path,served_sha256);
CREATE FUNCTION guard_watch_group_icon_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'immutable personal group icon version'; END IF;
 IF NOT EXISTS(SELECT 1 FROM resource_media_objects WHERE owner_id=NEW.owner_id AND sha256=NEW.original_sha256 AND byte_length=NEW.original_size)
 OR NOT EXISTS(SELECT 1 FROM resource_media_objects WHERE owner_id=NEW.owner_id AND sha256=NEW.served_sha256 AND byte_length=NEW.served_size)
 OR NOT EXISTS(SELECT 1 FROM watch_groups WHERE owner_id=NEW.owner_id AND id=NEW.group_id AND kind='custom' AND deleted_at IS NULL)
 THEN RAISE EXCEPTION 'personal group icon bytes or owner mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER watch_group_icon_version_guard BEFORE INSERT OR UPDATE OR DELETE ON watch_group_icon_versions FOR EACH ROW EXECUTE FUNCTION guard_watch_group_icon_version();
