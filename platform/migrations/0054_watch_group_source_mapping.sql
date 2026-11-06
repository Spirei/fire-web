-- Nonfinancial source metadata and provenance into the existing watch/record domain.
CREATE TABLE watch_group_source_manifests(
 owner_id text NOT NULL REFERENCES users(id),id uuid NOT NULL,request_id uuid NOT NULL,
 grant_id uuid NOT NULL REFERENCES legacy_source_grants(id),grant_revision bigint NOT NULL CHECK(grant_revision>0),
 source_instance text NOT NULL,source_owner text NOT NULL,physical_identity_hash text NOT NULL,
 binding_hash text NOT NULL,metadata_binding_hash text NOT NULL,schema_hash text NOT NULL,
 raw bytea NOT NULL CHECK(octet_length(raw) BETWEEN 1 AND 16777216),raw_sha256 text NOT NULL,
 manifest jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id),
 CHECK(encode(sha256(raw),'hex')=raw_sha256),
 CHECK(manifest->>'rawSha256'=raw_sha256)
);
CREATE TABLE watch_group_source_bindings(
 owner_id text NOT NULL,source_instance text NOT NULL,source_owner text NOT NULL,original_group_id text NOT NULL,
 target_group_id text NOT NULL,manifest_id uuid NOT NULL,operation_id uuid NOT NULL,source_row_sha256 text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('market','custom')),market text NOT NULL,
 PRIMARY KEY(owner_id,source_instance,source_owner,original_group_id),
 FOREIGN KEY(owner_id,target_group_id) REFERENCES watch_groups(owner_id,id),
 FOREIGN KEY(owner_id,manifest_id) REFERENCES watch_group_source_manifests(owner_id,id),
 FOREIGN KEY(owner_id,operation_id) REFERENCES watch_group_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX watch_group_source_original_alias ON watch_group_source_bindings(owner_id,original_group_id);
CREATE TABLE watch_group_import_members(
 owner_id text NOT NULL,request_id uuid NOT NULL,manifest_id uuid NOT NULL,sequence integer NOT NULL CHECK(sequence>=0),original_record_id text,
 original_group_id text,source_row_sha256 text NOT NULL,target_record_id text,target_group_id text,
 state text NOT NULL CHECK(state IN ('applied','unchanged','unknown')),reason text,
 PRIMARY KEY(owner_id,request_id,sequence),
 FOREIGN KEY(owner_id,manifest_id) REFERENCES watch_group_source_manifests(owner_id,id),
 FOREIGN KEY(owner_id,target_record_id) REFERENCES portfolio_records(owner_id,id),
 FOREIGN KEY(owner_id,target_group_id) REFERENCES watch_groups(owner_id,id)
);
CREATE TABLE watch_group_import_operations(
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,fingerprint text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('capture','apply')),state text NOT NULL CHECK(state IN ('reading','completed','failed','unknown')),
 result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 PRIMARY KEY(owner_id,request_id)
);
ALTER TABLE watch_group_import_members ADD CONSTRAINT watch_group_member_operation FOREIGN KEY(owner_id,request_id) REFERENCES watch_group_import_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE watch_group_source_bindings ADD CONSTRAINT watch_group_binding_operation FOREIGN KEY(owner_id,operation_id) REFERENCES watch_group_import_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION guard_watch_group_source_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM legacy_source_grants g JOIN legacy_source_owner_claims c ON c.source_instance=g.source_instance AND c.source_owner=g.source_owner
   WHERE g.id=NEW.grant_id AND g.owner_id=NEW.owner_id AND g.state='active' AND g.revision=NEW.grant_revision
    AND g.source_instance=NEW.source_instance AND g.source_owner=NEW.source_owner AND g.physical_identity_hash=NEW.physical_identity_hash
    AND g.binding_hash=NEW.binding_hash AND c.owner_id=NEW.owner_id AND c.physical_identity_hash=NEW.physical_identity_hash
    AND g.platform_instance=(SELECT instance_id FROM alcor_instance WHERE singleton))
 THEN RAISE EXCEPTION 'watch metadata requires the same active shared source and permanent owner claim' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_watch_group_source_manifest BEFORE INSERT ON watch_group_source_manifests FOR EACH ROW EXECUTE FUNCTION guard_watch_group_source_manifest();
CREATE FUNCTION guard_watch_group_source_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m watch_group_source_manifests;g watch_groups;
BEGIN
 SELECT * INTO m FROM watch_group_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.manifest_id;
 SELECT * INTO g FROM watch_groups WHERE owner_id=NEW.owner_id AND id=NEW.target_group_id;
 IF m IS NULL OR g IS NULL OR m.source_instance<>NEW.source_instance OR m.source_owner<>NEW.source_owner OR g.kind<>NEW.kind OR g.market<>NEW.market
 OR m.manifest#>>ARRAY['groupIndex',NEW.original_group_id,'rowSha256'] IS DISTINCT FROM NEW.source_row_sha256
 OR m.manifest#>>ARRAY['groupIndex',NEW.original_group_id,'kind'] IS DISTINCT FROM NEW.kind
 OR m.manifest#>>ARRAY['groupIndex',NEW.original_group_id,'market'] IS DISTINCT FROM NEW.market
 THEN RAISE EXCEPTION 'watch source group binding must retain owner, source and group identity' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_watch_group_source_binding BEFORE INSERT ON watch_group_source_bindings FOR EACH ROW EXECUTE FUNCTION guard_watch_group_source_binding();
CREATE FUNCTION guard_watch_group_import_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m watch_group_source_manifests;original jsonb;
BEGIN
 SELECT * INTO m FROM watch_group_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.manifest_id;
 original=m.manifest->'memberRows'->NEW.sequence;
 IF original IS NULL OR original->>'originalId' IS DISTINCT FROM NEW.original_record_id
 OR original->>'rowSha256' IS DISTINCT FROM NEW.source_row_sha256
 OR coalesce(original->>'groupId','') IS DISTINCT FROM coalesce(NEW.original_group_id,'')
 THEN RAISE EXCEPTION 'watch member must retain the exact source row and original ID' USING ERRCODE='23514'; END IF;
 IF NEW.state<>'unknown' AND (NEW.target_record_id IS NULL OR
  (coalesce(NEW.original_group_id,'')='' AND NEW.target_group_id IS NOT NULL) OR
  (coalesce(NEW.original_group_id,'')<>'' AND NOT EXISTS(SELECT 1 FROM watch_group_source_bindings b
    WHERE b.owner_id=NEW.owner_id AND b.source_instance=m.source_instance AND b.source_owner=m.source_owner
     AND b.original_group_id=NEW.original_group_id AND b.target_group_id=NEW.target_group_id AND b.kind='custom')))
 THEN RAISE EXCEPTION 'applied watch member requires an exact custom group binding' USING ERRCODE='23514'; END IF;
 IF NEW.target_record_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM financial_import_links l
  WHERE l.owner_id=NEW.owner_id AND l.source_instance=m.source_instance AND l.source_owner=m.source_owner
   AND l.object_kind='record' AND l.original_id=NEW.original_record_id AND l.target_id=NEW.target_record_id)
 THEN RAISE EXCEPTION 'watch membership requires an existing exact original record binding' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_watch_group_import_member BEFORE INSERT ON watch_group_import_members FOR EACH ROW EXECUTE FUNCTION guard_watch_group_import_member();
CREATE FUNCTION guard_watch_group_import_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.state<>'reading' OR NEW.state NOT IN ('completed','failed','unknown')
 OR (NEW.owner_id,NEW.request_id,NEW.fingerprint,NEW.kind,NEW.created_at) IS DISTINCT FROM (OLD.owner_id,OLD.request_id,OLD.fingerprint,OLD.kind,OLD.created_at)
 THEN RAISE EXCEPTION 'watch import receipt is immutable except one accepted capture completion' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_watch_group_import_operation BEFORE UPDATE OR DELETE ON watch_group_import_operations FOR EACH ROW EXECUTE FUNCTION guard_watch_group_import_operation();
CREATE TRIGGER immutable_watch_group_source_manifest BEFORE UPDATE OR DELETE ON watch_group_source_manifests FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_watch_group_source_binding BEFORE UPDATE OR DELETE ON watch_group_source_bindings FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER immutable_watch_group_import_member BEFORE UPDATE OR DELETE ON watch_group_import_members FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
