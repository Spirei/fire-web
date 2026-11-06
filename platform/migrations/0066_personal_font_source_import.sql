-- Explicit per-file migration consent. A legacy numeric filename never proves uploader identity.
CREATE TABLE personal_font_source_permissions (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id),
 grant_id uuid NOT NULL REFERENCES legacy_source_grants(id), grant_revision bigint NOT NULL,
 platform_instance uuid NOT NULL, source_alias text NOT NULL, source_instance text NOT NULL, source_owner text NOT NULL,
 binding_hash text NOT NULL, physical_identity_hash text NOT NULL, root_binding text NOT NULL, root_identity text NOT NULL,
 original_id text NOT NULL CHECK(original_id ~ '^custom-[1-9][0-9]*-[a-f0-9]{64}\.(woff2?|ttf|otf)$'),
 scope text NOT NULL DEFAULT 'fonts.migrate' CHECK(scope='fonts.migrate'),
 state text NOT NULL CHECK(state IN ('pending_owner','active','revoked')), revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 registered_by text NOT NULL REFERENCES users(id), evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 200),
 name text CHECK(length(name) BETWEEN 1 AND 60 AND name !~ '[\x01-\x1f\x7f]'),
 historical_uploader_verified boolean NOT NULL DEFAULT false CHECK(NOT historical_uploader_verified),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,id), UNIQUE(root_identity,original_id)
);
CREATE TABLE personal_font_source_operations (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('register','consent','capture','apply')),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('reading','completed','failed')), result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id),
 CHECK(result->>'kind'=kind AND result->>'state'=state AND result->>'requestId'=request_id::text),
 CHECK(state<>'reading' OR kind='capture')
);
CREATE TABLE personal_font_source_captures (
 owner_id text NOT NULL, id uuid NOT NULL, request_id uuid NOT NULL,
 permission_id uuid NOT NULL, permission_revision bigint NOT NULL,
 sha256 text NOT NULL, byte_length bigint NOT NULL CHECK(byte_length BETWEEN 48 AND 10485760),
 evidence bytea NOT NULL CHECK(octet_length(evidence)<=32768), evidence_sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,id), UNIQUE(owner_id,request_id), UNIQUE(owner_id,permission_id),
 FOREIGN KEY(owner_id,permission_id) REFERENCES personal_font_source_permissions(owner_id,id),
 FOREIGN KEY(owner_id,request_id) REFERENCES personal_font_source_operations(owner_id,request_id),
 FOREIGN KEY(owner_id,sha256) REFERENCES resource_media_objects(owner_id,sha256),
 CHECK(encode(sha256(evidence),'hex')=evidence_sha256)
);
CREATE TABLE personal_font_source_aliases (
 owner_id text NOT NULL, permission_id uuid NOT NULL, capture_id uuid NOT NULL, request_id uuid NOT NULL,
 original_id text NOT NULL, target_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,permission_id),
 FOREIGN KEY(owner_id,permission_id) REFERENCES personal_font_source_permissions(owner_id,id),
 FOREIGN KEY(owner_id,capture_id) REFERENCES personal_font_source_captures(owner_id,id),
 FOREIGN KEY(owner_id,target_id) REFERENCES personal_fonts(owner_id,id),
 FOREIGN KEY(owner_id,request_id) REFERENCES personal_font_source_operations(owner_id,request_id)
);

CREATE FUNCTION guard_personal_font_source_permission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM users WHERE id=OLD.owner_id AND NOT active AND deleted_at IS NOT NULL) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'live font source permission cannot be deleted';
 END IF;
 IF TG_OP='UPDATE' AND (
  (to_jsonb(NEW)-ARRAY['state','revision','name']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','name'])
  OR NEW.revision<>OLD.revision+1 OR NEW.state NOT IN ('active','revoked') OR OLD.state='revoked' OR (OLD.state='active' AND NEW.state<>'revoked'))
 THEN RAISE EXCEPTION 'font source consent identity is immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM legacy_source_grants g WHERE g.id=NEW.grant_id AND g.owner_id=NEW.owner_id
  AND g.platform_instance=NEW.platform_instance AND g.source_alias=NEW.source_alias AND g.source_instance=NEW.source_instance
  AND g.source_owner=NEW.source_owner AND g.binding_hash=NEW.binding_hash AND g.physical_identity_hash=NEW.physical_identity_hash)
 THEN RAISE EXCEPTION 'font source requires exact existing grant'; END IF;
 IF NEW.state='active' AND (NEW.name IS NULL OR NOT EXISTS(SELECT 1 FROM legacy_source_owner_claims c JOIN legacy_source_grants g ON g.id=NEW.grant_id
  WHERE c.source_instance=NEW.source_instance AND c.source_owner=NEW.source_owner AND c.owner_id=NEW.owner_id
  AND c.physical_identity_hash=NEW.physical_identity_hash AND c.platform_instance=NEW.platform_instance
  AND g.state='active' AND g.revision=NEW.grant_revision))
 THEN RAISE EXCEPTION 'font consent requires same immutable owner claim'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER personal_font_source_permission_guard BEFORE INSERT OR UPDATE OR DELETE ON personal_font_source_permissions FOR EACH ROW EXECUTE FUNCTION guard_personal_font_source_permission();

CREATE FUNCTION guard_personal_font_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM users WHERE id=OLD.owner_id AND NOT active AND deleted_at IS NOT NULL) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'font source evidence is immutable';
END $$;
CREATE TRIGGER personal_font_source_capture_guard BEFORE UPDATE OR DELETE ON personal_font_source_captures FOR EACH ROW EXECUTE FUNCTION guard_personal_font_source_immutable();
CREATE TRIGGER personal_font_source_alias_guard BEFORE UPDATE OR DELETE ON personal_font_source_aliases FOR EACH ROW EXECUTE FUNCTION guard_personal_font_source_immutable();

CREATE FUNCTION guard_personal_font_source_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND EXISTS(SELECT 1 FROM users WHERE id=OLD.owner_id AND NOT active AND deleted_at IS NOT NULL) THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE' AND OLD.state='reading' AND NEW.state IN ('completed','failed')
  AND (to_jsonb(NEW)-ARRAY['state','result'])=(to_jsonb(OLD)-ARRAY['state','result']) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'font source original operation is immutable';
END $$;
CREATE TRIGGER personal_font_source_operation_guard BEFORE UPDATE OR DELETE ON personal_font_source_operations FOR EACH ROW EXECUTE FUNCTION guard_personal_font_source_operation();

CREATE FUNCTION guard_personal_font_source_capture_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p personal_font_source_permissions; doc jsonb;
BEGIN
 SELECT * INTO p FROM personal_font_source_permissions WHERE owner_id=NEW.owner_id AND id=NEW.permission_id;
 doc=convert_from(NEW.evidence,'UTF8')::jsonb;
 IF p.state<>'active' OR p.revision<>NEW.permission_revision
 OR doc->>'permissionId' IS DISTINCT FROM p.id::text OR doc->>'originalId' IS DISTINCT FROM p.original_id
 OR doc->>'sha256' IS DISTINCT FROM NEW.sha256 OR doc->>'rootBinding' IS DISTINCT FROM p.root_binding
 OR NOT EXISTS(SELECT 1 FROM personal_font_source_operations WHERE owner_id=NEW.owner_id AND request_id=NEW.request_id AND kind='capture' AND state='reading')
 OR NOT EXISTS(SELECT 1 FROM resource_media_objects WHERE owner_id=NEW.owner_id AND sha256=NEW.sha256 AND byte_length=NEW.byte_length)
 THEN RAISE EXCEPTION 'font capture requires accepted original operation and attested owner bytes'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER personal_font_source_capture_insert_guard BEFORE INSERT ON personal_font_source_captures FOR EACH ROW EXECUTE FUNCTION guard_personal_font_source_capture_insert();

CREATE FUNCTION guard_personal_font_source_alias_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM personal_font_source_captures c JOIN personal_font_source_permissions p ON p.owner_id=c.owner_id AND p.id=c.permission_id
 JOIN personal_fonts f ON f.owner_id=c.owner_id AND f.id=NEW.target_id
 WHERE c.owner_id=NEW.owner_id AND c.id=NEW.capture_id AND c.permission_id=NEW.permission_id AND p.original_id=NEW.original_id
 AND f.sha256=c.sha256 AND f.byte_length=c.byte_length AND f.extension=split_part(p.original_id,'.',2)
 AND EXISTS(SELECT 1 FROM personal_font_source_operations WHERE owner_id=NEW.owner_id AND request_id=NEW.request_id AND kind='apply' AND state='completed'))
 THEN RAISE EXCEPTION 'font source alias must reference same owner committed original'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER personal_font_source_alias_insert_guard BEFORE INSERT ON personal_font_source_aliases FOR EACH ROW EXECUTE FUNCTION guard_personal_font_source_alias_insert();
