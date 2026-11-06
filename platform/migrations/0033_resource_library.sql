-- Candidate only: final sequence is assigned during promotion.
CREATE TABLE resource_cursor_key (
  singleton boolean PRIMARY KEY CHECK(singleton),
  secret text NOT NULL CHECK(length(secret)>=64)
);
INSERT INTO resource_cursor_key VALUES(true,replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''));
CREATE TABLE resource_media_objects (
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL CHECK(byte_length BETWEEN 1 AND 52428800),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,sha256)
);
CREATE TABLE resource_folders (
  id text PRIMARY KEY CHECK(id ~ '^rld_[0-9a-f]{32}$'),
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK(category IN ('components','media')),
  parent_id text,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 240 AND octet_length(name)<=480),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  UNIQUE(owner_id,category,id),
  FOREIGN KEY(owner_id,category,parent_id) REFERENCES resource_folders(owner_id,category,id),
  CHECK(parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX resource_folder_sibling ON resource_folders(owner_id,category,coalesce(parent_id,''),name) WHERE deleted_at IS NULL;
CREATE INDEX resource_folder_page ON resource_folders(owner_id,category,parent_id,created_at,id) WHERE deleted_at IS NULL;
CREATE TABLE resource_files (
  id text PRIMARY KEY CHECK(id ~ '^rlf_[0-9a-f]{32}$'),
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK(category IN ('components','media')),
  folder_id text,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120 AND octet_length(name)<=240),
  kind text NOT NULL CHECK(kind IN ('image','video','audio','document','archive','other')),
  mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 52428800),
  sha256 text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  FOREIGN KEY(owner_id,sha256) REFERENCES resource_media_objects(owner_id,sha256),
  FOREIGN KEY(owner_id,category,folder_id) REFERENCES resource_folders(owner_id,category,id)
);
CREATE INDEX resource_file_page ON resource_files(owner_id,category,kind,created_at,id) WHERE deleted_at IS NULL;
CREATE INDEX resource_file_name ON resource_files(owner_id,name COLLATE "C",id) WHERE deleted_at IS NULL;
CREATE TABLE resource_operation_receipts (
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('upload','delete','folder_create','folder_delete','folder_update','file_update')),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,request_id)
);
CREATE FUNCTION guard_resource_file() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE used bigint; number bigint; bytes bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('resources:'||NEW.owner_id,0));
  IF TG_OP='UPDATE' AND (NEW.id,NEW.owner_id,NEW.sha256,NEW.size_bytes,NEW.kind,NEW.mime,NEW.category,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.sha256,OLD.size_bytes,OLD.kind,OLD.mime,OLD.category,OLD.created_at) THEN
    RAISE EXCEPTION 'immutable original metadata';
  END IF;
  SELECT byte_length INTO bytes FROM resource_media_objects WHERE owner_id=NEW.owner_id AND sha256=NEW.sha256;
  IF bytes IS DISTINCT FROM NEW.size_bytes THEN RAISE EXCEPTION 'original size mismatch'; END IF;
  IF NEW.deleted_at IS NULL THEN
    IF NEW.folder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM resource_folders WHERE id=NEW.folder_id AND owner_id=NEW.owner_id AND category=NEW.category AND deleted_at IS NULL) THEN
      RAISE EXCEPTION 'unavailable resource folder';
    END IF;
    SELECT coalesce(sum(size_bytes),0),count(*) INTO used,number FROM resource_files WHERE owner_id=NEW.owner_id AND deleted_at IS NULL AND id<>NEW.id;
    IF used+NEW.size_bytes>1073741824 OR number>=5000 THEN RAISE EXCEPTION 'resource quota exceeded'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'resource tombstone is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resource_file_guard BEFORE INSERT OR UPDATE ON resource_files FOR EACH ROW EXECUTE FUNCTION guard_resource_file();
CREATE FUNCTION guard_resource_media() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.owner_id,NEW.sha256,NEW.byte_length,NEW.created_at) IS DISTINCT FROM (OLD.owner_id,OLD.sha256,OLD.byte_length,OLD.created_at) THEN
    RAISE EXCEPTION 'immutable original object';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resource_media_guard BEFORE UPDATE ON resource_media_objects FOR EACH ROW EXECUTE FUNCTION guard_resource_media();
-- NFC can expand a few legacy-valid folder scalars; raw input limits remain
-- 120 scalars / 240 UTF-8 bytes in the service, while storage retains its NFC.
ALTER TABLE resource_folders ADD CHECK(name NOT IN ('.','..') AND name=btrim(name) AND strpos(name,'/')=0 AND strpos(name,chr(92))=0 AND name !~ '[\x01-\x1f\x7f]');
ALTER TABLE resource_files ADD CHECK(name NOT IN ('.','..') AND name=btrim(name) AND strpos(name,'/')=0 AND strpos(name,chr(92))=0 AND name !~ '[\x01-\x1f\x7f]');
CREATE FUNCTION guard_resource_folder() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_id text; visited text[]; depth integer:=1; subtree integer; number integer; p resource_folders;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('resources:'||NEW.owner_id,0));
  IF TG_OP='UPDATE' AND (NEW.id,NEW.owner_id,NEW.category,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.category,OLD.created_at) THEN
    RAISE EXCEPTION 'immutable folder identity';
  END IF;
  IF TG_OP='UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'immutable folder tombstone'; END IF;
  IF NEW.deleted_at IS NULL THEN
    SELECT count(*) INTO number FROM resource_folders WHERE owner_id=NEW.owner_id AND deleted_at IS NULL AND id<>NEW.id;
    IF number>=128 THEN RAISE EXCEPTION 'folder limit'; END IF;
    visited:=ARRAY[NEW.id]; next_id:=NEW.parent_id;
    WHILE next_id IS NOT NULL LOOP
      IF next_id=ANY(visited) THEN RAISE EXCEPTION 'folder cycle'; END IF;
      visited:=array_append(visited,next_id);
      SELECT * INTO p FROM resource_folders WHERE owner_id=NEW.owner_id AND category=NEW.category AND id=next_id AND deleted_at IS NULL;
      IF NOT FOUND THEN RAISE EXCEPTION 'unavailable parent'; END IF;
      depth:=depth+1;
      IF depth>8 THEN RAISE EXCEPTION 'folder depth'; END IF;
      next_id:=p.parent_id;
    END LOOP;
    WITH RECURSIVE tree AS (SELECT id,1 AS h FROM resource_folders WHERE id=NEW.id AND deleted_at IS NULL
      UNION ALL SELECT f.id,t.h+1 FROM resource_folders f JOIN tree t ON f.parent_id=t.id
      WHERE f.owner_id=NEW.owner_id AND f.deleted_at IS NULL AND t.h<=8)
      SELECT coalesce(max(h),1) INTO subtree FROM tree;
    IF depth+subtree-1>8 THEN RAISE EXCEPTION 'folder subtree depth'; END IF;
  ELSIF EXISTS(SELECT 1 FROM resource_folders WHERE owner_id=NEW.owner_id AND parent_id=NEW.id AND deleted_at IS NULL)
    OR EXISTS(SELECT 1 FROM resource_files WHERE owner_id=NEW.owner_id AND folder_id=NEW.id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'nonempty folder';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER resource_folder_guard BEFORE INSERT OR UPDATE ON resource_folders FOR EACH ROW EXECUTE FUNCTION guard_resource_folder();
CREATE FUNCTION guard_resource_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'resource receipt is append-only'; END $$;
CREATE TRIGGER resource_receipt_guard BEFORE UPDATE ON resource_operation_receipts FOR EACH ROW EXECUTE FUNCTION guard_resource_receipt();
