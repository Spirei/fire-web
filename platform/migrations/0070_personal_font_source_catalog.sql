-- Metadata-only global font inventory and permanent F32-backed file assignments.
CREATE TABLE personal_font_source_file_claims (
 root_identity text NOT NULL CHECK(root_identity ~ '^[a-f0-9]{64}$'),
 original_id text NOT NULL CHECK(original_id ~ '^custom-[1-9][0-9]*-[a-f0-9]{64}\.(woff2?|ttf|otf)$'),
 source_instance text NOT NULL, source_owner text NOT NULL, owner_id text NOT NULL REFERENCES users(id),
 physical_identity_hash text NOT NULL, first_grant_id uuid NOT NULL REFERENCES legacy_source_grants(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(root_identity,original_id), UNIQUE(source_instance,original_id), UNIQUE(physical_identity_hash,original_id),
 FOREIGN KEY(source_instance,source_owner) REFERENCES legacy_source_owner_claims(source_instance,source_owner)
);
CREATE FUNCTION guard_font_source_file_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'permanent font file assignment cannot be changed or released'; END IF;
 IF NOT EXISTS(SELECT 1 FROM legacy_source_owner_claims c WHERE c.source_instance=NEW.source_instance AND c.source_owner=NEW.source_owner AND c.owner_id=NEW.owner_id AND c.physical_identity_hash=NEW.physical_identity_hash)
 OR NOT EXISTS(SELECT 1 FROM personal_font_source_permissions p WHERE p.root_identity=NEW.root_identity AND p.original_id=NEW.original_id AND p.source_instance=NEW.source_instance AND p.source_owner=NEW.source_owner AND p.owner_id=NEW.owner_id AND p.physical_identity_hash=NEW.physical_identity_hash AND p.grant_id=NEW.first_grant_id)
 THEN RAISE EXCEPTION 'font file assignment requires its existing F32 owner claim and exact registered file'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER font_source_file_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON personal_font_source_file_claims FOR EACH ROW EXECUTE FUNCTION guard_font_source_file_claim();

-- Only real already-consented records with an exact permanent source claim qualify.
-- A duplicate logical or physical source file must fail closed, never pick an owner.
INSERT INTO personal_font_source_file_claims(root_identity,original_id,source_instance,source_owner,owner_id,physical_identity_hash,first_grant_id)
SELECT p.root_identity,p.original_id,p.source_instance,p.source_owner,p.owner_id,p.physical_identity_hash,p.grant_id
FROM personal_font_source_permissions p JOIN legacy_source_owner_claims c ON c.source_instance=p.source_instance AND c.source_owner=p.source_owner
 AND c.owner_id=p.owner_id AND c.physical_identity_hash=p.physical_identity_hash AND c.platform_instance=p.platform_instance
WHERE p.name IS NOT NULL;

-- Before this migration closure erased private file permissions. An old permanent
-- source-owner claim proves only the source, never which original files were used.
-- Keep that uncertainty without retaining names, bytes, or inferred file owners.
CREATE TABLE personal_font_source_history_gaps (
 physical_identity_hash text PRIMARY KEY,
 reason text NOT NULL DEFAULT 'pre_catalog_owner_closed' CHECK(reason='pre_catalog_owner_closed'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO personal_font_source_history_gaps(physical_identity_hash)
SELECT DISTINCT c.physical_identity_hash FROM legacy_source_owner_claims c
JOIN users u ON u.id=c.owner_id WHERE u.deleted_at IS NOT NULL;
CREATE TRIGGER font_source_history_gap_immutable BEFORE UPDATE OR DELETE ON personal_font_source_history_gaps FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

CREATE FUNCTION guard_font_source_permission_file_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM personal_font_source_history_gaps g WHERE g.physical_identity_hash=NEW.physical_identity_hash)
 AND NOT EXISTS(SELECT 1 FROM personal_font_source_file_claims c WHERE c.root_identity=NEW.root_identity AND c.original_id=NEW.original_id AND c.owner_id=NEW.owner_id AND c.physical_identity_hash=NEW.physical_identity_hash)
 THEN RAISE EXCEPTION 'font source history gap prevents new unclaimed assignment'; END IF;
 IF EXISTS(SELECT 1 FROM personal_font_source_file_claims c WHERE c.original_id=NEW.original_id
 AND (c.root_identity=NEW.root_identity OR c.source_instance=NEW.source_instance OR c.physical_identity_hash=NEW.physical_identity_hash)
 AND (c.owner_id<>NEW.owner_id OR c.source_owner<>NEW.source_owner OR c.source_instance<>NEW.source_instance
 OR c.physical_identity_hash<>NEW.physical_identity_hash OR c.root_identity<>NEW.root_identity))
 THEN RAISE EXCEPTION 'permanent font file owner cannot be reassigned'; END IF;
 IF NEW.state='active' AND NOT EXISTS(SELECT 1 FROM personal_font_source_file_claims c WHERE c.root_identity=NEW.root_identity AND c.original_id=NEW.original_id
 AND c.owner_id=NEW.owner_id AND c.source_owner=NEW.source_owner AND c.source_instance=NEW.source_instance AND c.physical_identity_hash=NEW.physical_identity_hash)
 THEN RAISE EXCEPTION 'active font source consent requires permanent file assignment'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER font_source_permission_file_claim_guard BEFORE INSERT OR UPDATE ON personal_font_source_permissions FOR EACH ROW EXECUTE FUNCTION guard_font_source_permission_file_claim();

CREATE TABLE personal_font_source_catalog_operations (
 request_id uuid PRIMARY KEY, actor_id text NOT NULL REFERENCES users(id), platform_instance uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('reading','completed','failed')), result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(result->>'requestId'=request_id::text AND result->>'kind'='catalog' AND result->>'state'=state)
);
CREATE TABLE personal_font_source_catalogs (
 id uuid PRIMARY KEY REFERENCES personal_font_source_catalog_operations(request_id),
 actor_id text NOT NULL REFERENCES users(id), platform_instance uuid NOT NULL,
 source_alias text NOT NULL, source_instance text NOT NULL, root_identity text NOT NULL,
 root_binding text NOT NULL, binding_hash text NOT NULL, physical_identity_hash text NOT NULL,
 manifest bytea NOT NULL CHECK(octet_length(manifest) BETWEEN 1 AND 8388608),
 sha256 text NOT NULL CHECK(encode(sha256(manifest),'hex')=sha256),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER font_source_catalog_immutable BEFORE UPDATE OR DELETE ON personal_font_source_catalogs FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE FUNCTION guard_font_source_catalog_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.state='reading' AND NEW.state IN ('completed','failed')
 AND (to_jsonb(NEW)-ARRAY['state','result'])=(to_jsonb(OLD)-ARRAY['state','result']) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'font catalog operation is immutable';
END $$;
CREATE TRIGGER font_source_catalog_operation_guard BEFORE UPDATE OR DELETE ON personal_font_source_catalog_operations FOR EACH ROW EXECUTE FUNCTION guard_font_source_catalog_operation();
CREATE FUNCTION guard_font_source_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM personal_font_source_catalog_operations o WHERE o.request_id=NEW.id AND o.actor_id=NEW.actor_id AND o.platform_instance=NEW.platform_instance AND o.state='reading')
 OR convert_from(NEW.manifest,'UTF8')::jsonb->>'sourceAlias' IS DISTINCT FROM NEW.source_alias
 OR convert_from(NEW.manifest,'UTF8')::jsonb->>'rootIdentity' IS DISTINCT FROM NEW.root_identity
 THEN RAISE EXCEPTION 'font catalog requires original admitted read and exact registered source'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER font_source_catalog_guard BEFORE INSERT ON personal_font_source_catalogs FOR EACH ROW EXECUTE FUNCTION guard_font_source_catalog();
