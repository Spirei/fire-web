-- NEXT delivery copy. Sequence 0038 reserved by integration owner; never edits 0032/0033.
CREATE TABLE resource_source_consents (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id),
 platform_instance uuid NOT NULL, source_alias text NOT NULL,
 source_instance text NOT NULL, source_owner text NOT NULL,
 physical_identity_hash text NOT NULL CHECK(physical_identity_hash ~ '^[0-9a-f]{64}$'),
 binding_hash text NOT NULL CHECK(binding_hash ~ '^[0-9a-f]{64}$'),
 scope text NOT NULL CHECK(scope='resources.migrate'),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 9007199254740991),
 state text NOT NULL CHECK(state IN ('pending_owner','active','revoked')),
 registered_by text NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), approved_at timestamptz, revoked_at timestamptz,
 FOREIGN KEY(source_instance,source_owner) REFERENCES legacy_source_owner_claims(source_instance,source_owner)
);
CREATE UNIQUE INDEX resource_consent_active ON resource_source_consents(source_instance,source_owner) WHERE state='active';
CREATE FUNCTION guard_resource_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM legacy_source_owner_claims c WHERE c.source_instance=NEW.source_instance AND c.source_owner=NEW.source_owner AND c.owner_id=NEW.owner_id AND c.physical_identity_hash=NEW.physical_identity_hash) THEN
  RAISE EXCEPTION 'resource scope requires the existing immutable source claim';
 END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['revision','state','approved_at','revoked_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['revision','state','approved_at','revoked_at']) THEN
  RAISE EXCEPTION 'resource source identity is immutable';
 END IF;
 IF TG_OP='UPDATE' AND (OLD.state='revoked' OR NEW.revision<>OLD.revision+1 OR NOT ((OLD.state='pending_owner' AND NEW.state IN ('active','revoked')) OR (OLD.state='active' AND NEW.state='revoked'))) THEN
  RAISE EXCEPTION 'invalid resource scope transition';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER resource_consent_guard BEFORE INSERT OR UPDATE ON resource_source_consents FOR EACH ROW EXECUTE FUNCTION guard_resource_consent();
CREATE TABLE resource_import_manifests (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), consent_id uuid NOT NULL REFERENCES resource_source_consents(id),
 request_id uuid NOT NULL, fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 consent_revision bigint NOT NULL, platform_instance uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('capturing','sealed','failed')),
 manifest jsonb, digest text CHECK(digest ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), sealed_at timestamptz,
 UNIQUE(owner_id,id), UNIQUE(owner_id,request_id), CHECK((state='sealed')=(manifest IS NOT NULL AND digest IS NOT NULL AND sealed_at IS NOT NULL))
);
CREATE TABLE resource_import_records (
 manifest_id uuid NOT NULL REFERENCES resource_import_manifests(id), seq bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN ('folder','file','operation')), source_id text NOT NULL,
 raw jsonb NOT NULL, raw_sha256 text NOT NULL CHECK(raw_sha256 ~ '^[0-9a-f]{64}$'), normalized jsonb,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applied','blocked')),
 reason text, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 PRIMARY KEY(manifest_id,seq), UNIQUE(manifest_id,kind,source_id)
);
CREATE TABLE resource_import_originals (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 manifest_id uuid NOT NULL, record_seq bigint NOT NULL, kind text NOT NULL CHECK(kind IN ('upload','delete','unverified')),
 projection jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id), FOREIGN KEY(manifest_id,record_seq) REFERENCES resource_import_records(manifest_id,seq)
);
CREATE TABLE resource_import_operations (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id)
);
CREATE FUNCTION guard_resource_import_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['state','reason','attempts']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','reason','attempts']) THEN
  RAISE EXCEPTION 'immutable source resource record';
 END IF;
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM resource_import_manifests WHERE id=NEW.manifest_id AND state='capturing') THEN
  RAISE EXCEPTION 'source manifest is already sealed';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER resource_import_record_guard BEFORE INSERT OR UPDATE ON resource_import_records FOR EACH ROW EXECUTE FUNCTION guard_resource_import_record();
CREATE FUNCTION guard_resource_import_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state<>'capturing' OR (NEW.id,NEW.owner_id,NEW.consent_id,NEW.consent_revision,NEW.platform_instance,NEW.created_at,NEW.request_id,NEW.fingerprint) IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.consent_id,OLD.consent_revision,OLD.platform_instance,OLD.created_at,OLD.request_id,OLD.fingerprint) THEN
  RAISE EXCEPTION 'sealed source resource manifest is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER resource_import_manifest_guard BEFORE UPDATE ON resource_import_manifests FOR EACH ROW EXECUTE FUNCTION guard_resource_import_manifest();
CREATE TRIGGER resource_import_original_guard BEFORE UPDATE ON resource_import_originals FOR EACH ROW EXECUTE FUNCTION guard_resource_receipt();
CREATE TRIGGER resource_import_operation_guard BEFORE UPDATE ON resource_import_operations FOR EACH ROW EXECUTE FUNCTION guard_resource_receipt();
CREATE FUNCTION guard_resource_import_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM resource_import_records r JOIN resource_import_manifests m ON m.id=r.manifest_id WHERE r.manifest_id=NEW.manifest_id AND r.seq=NEW.record_seq AND r.kind='operation' AND m.state='sealed' AND m.owner_id=NEW.owner_id AND r.source_id=NEW.request_id::text AND ((r.normalized IS NOT NULL AND r.normalized->>'type'=NEW.kind AND r.normalized->'projection'=NEW.projection) OR (r.normalized IS NULL AND NEW.projection->>'state'='unverified'))) THEN
  RAISE EXCEPTION 'source UUID owner or evidence mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER resource_import_original_insert_guard BEFORE INSERT ON resource_import_originals FOR EACH ROW EXECUTE FUNCTION guard_resource_import_original();
-- A legitimate old deletion has a historical digest but no remaining object.
-- Separate that digest from an actual immutable object reference, never invent bytes.
ALTER TABLE resource_files ADD COLUMN object_sha256 text, ADD COLUMN import_manifest_id uuid, ADD COLUMN import_record_seq bigint;
UPDATE resource_files SET object_sha256=sha256;
ALTER TABLE resource_files DROP CONSTRAINT resource_files_owner_id_sha256_fkey;
ALTER TABLE resource_files ADD FOREIGN KEY(owner_id,object_sha256) REFERENCES resource_media_objects(owner_id,sha256);
ALTER TABLE resource_files ADD FOREIGN KEY(import_manifest_id,import_record_seq) REFERENCES resource_import_records(manifest_id,seq);
ALTER TABLE resource_files ADD CHECK((import_manifest_id IS NULL)=(import_record_seq IS NULL));
CREATE OR REPLACE FUNCTION guard_resource_file() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE used bigint; number bigint; bytes bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('resources:'||NEW.owner_id,0));
 IF TG_OP='INSERT' AND NEW.object_sha256 IS NULL AND NEW.deleted_at IS NULL THEN NEW.object_sha256:=NEW.sha256; END IF;
 IF TG_OP='UPDATE' AND (NEW.id,NEW.owner_id,NEW.sha256,NEW.size_bytes,NEW.kind,NEW.mime,NEW.category,NEW.created_at,NEW.object_sha256,NEW.import_manifest_id,NEW.import_record_seq)
   IS DISTINCT FROM (OLD.id,OLD.owner_id,OLD.sha256,OLD.size_bytes,OLD.kind,OLD.mime,OLD.category,OLD.created_at,OLD.object_sha256,OLD.import_manifest_id,OLD.import_record_seq) THEN
   RAISE EXCEPTION 'immutable original metadata';
 END IF;
 IF NEW.import_manifest_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM resource_import_records r JOIN resource_import_manifests m ON m.id=r.manifest_id WHERE m.state='sealed' AND m.owner_id=NEW.owner_id AND r.manifest_id=NEW.import_manifest_id AND r.seq=NEW.import_record_seq AND r.kind='file' AND r.source_id=NEW.id AND r.normalized->>'sha256'=NEW.sha256 AND (r.normalized->>'size_bytes')::bigint=NEW.size_bytes AND r.normalized->>'category'=NEW.category AND r.normalized->>'kind'=NEW.kind AND r.normalized->>'mime'=NEW.mime) THEN
  RAISE EXCEPTION 'resource import proof does not match owner or original';
 END IF;
 IF NEW.object_sha256 IS NOT NULL THEN
  SELECT byte_length INTO bytes FROM resource_media_objects WHERE owner_id=NEW.owner_id AND sha256=NEW.object_sha256;
  IF NEW.object_sha256<>NEW.sha256 OR bytes IS DISTINCT FROM NEW.size_bytes THEN RAISE EXCEPTION 'original size mismatch'; END IF;
 ELSIF NEW.deleted_at IS NULL OR NOT EXISTS(
  SELECT 1 FROM resource_import_records r JOIN resource_import_manifests m ON m.id=r.manifest_id
   WHERE m.state='sealed' AND m.owner_id=NEW.owner_id AND r.manifest_id=NEW.import_manifest_id AND r.seq=NEW.import_record_seq
    AND r.kind='file' AND r.source_id=NEW.id AND r.normalized->>'state'='deleted'
    AND r.normalized->>'sha256'=NEW.sha256 AND (r.normalized->>'size_bytes')::bigint=NEW.size_bytes
 ) THEN RAISE EXCEPTION 'missing original requires proven imported deletion'; END IF;
 IF NEW.deleted_at IS NULL THEN
  IF NEW.folder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM resource_folders WHERE id=NEW.folder_id AND owner_id=NEW.owner_id AND category=NEW.category AND deleted_at IS NULL) THEN RAISE EXCEPTION 'unavailable resource folder'; END IF;
  SELECT coalesce(sum(size_bytes),0),count(*) INTO used,number FROM resource_files WHERE owner_id=NEW.owner_id AND deleted_at IS NULL AND id<>NEW.id;
  IF used+NEW.size_bytes>1073741824 OR number>=5000 THEN RAISE EXCEPTION 'resource quota exceeded'; END IF;
 END IF;
 IF TG_OP='UPDATE' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN RAISE EXCEPTION 'resource tombstone is immutable'; END IF;
 RETURN NEW;
END $$;
