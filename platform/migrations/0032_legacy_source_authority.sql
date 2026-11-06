-- One source authority binds the financial and fee evidence views. No new ledger.
CREATE TABLE legacy_source_grants (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), platform_instance uuid NOT NULL,
 source_alias text NOT NULL, source_instance text NOT NULL, source_owner text NOT NULL,
 binding_hash text NOT NULL CHECK(binding_hash ~ '^[a-f0-9]{64}$'),
 physical_identity_hash text NOT NULL CHECK(physical_identity_hash ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('pending_owner','active','revoked')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0), registered_by text NOT NULL REFERENCES users(id),
 approved_at timestamptz, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((state='pending_owner' AND approved_at IS NULL AND revoked_at IS NULL) OR
       (state='active' AND approved_at IS NOT NULL AND revoked_at IS NULL) OR state='revoked')
);
CREATE UNIQUE INDEX legacy_one_active_authority ON legacy_source_grants(owner_id) WHERE state='active';
CREATE UNIQUE INDEX legacy_one_active_source_owner ON legacy_source_grants(source_instance,source_owner) WHERE state='active';
CREATE UNIQUE INDEX legacy_one_active_dataset_owner ON legacy_source_grants(physical_identity_hash,source_owner) WHERE state='active';
CREATE TABLE legacy_source_owner_claims (
 source_instance text NOT NULL,source_owner text NOT NULL,owner_id text NOT NULL REFERENCES users(id),
 physical_identity_hash text NOT NULL CHECK(physical_identity_hash ~ '^[a-f0-9]{64}$'),
 first_grant_id uuid NOT NULL REFERENCES legacy_source_grants(id),platform_instance uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(source_instance,source_owner),
 UNIQUE(physical_identity_hash,source_owner)
);
CREATE TRIGGER legacy_source_claim_immutable BEFORE UPDATE OR DELETE ON legacy_source_owner_claims FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE FUNCTION guard_legacy_source_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM legacy_source_grants g WHERE g.id=NEW.first_grant_id AND g.owner_id=NEW.owner_id
 AND g.source_instance=NEW.source_instance AND g.source_owner=NEW.source_owner AND g.physical_identity_hash=NEW.physical_identity_hash
 AND g.platform_instance=NEW.platform_instance AND g.state='active')
 THEN RAISE EXCEPTION 'source ownership claim requires its active verified-source grant' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_source_claim BEFORE INSERT ON legacy_source_owner_claims FOR EACH ROW EXECUTE FUNCTION guard_legacy_source_claim();
CREATE TABLE legacy_source_manifests (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES users(id), grant_id uuid NOT NULL REFERENCES legacy_source_grants(id),
 grant_revision bigint NOT NULL, manifest_sha256 text NOT NULL UNIQUE, manifest jsonb NOT NULL,
 raw bytea NOT NULL CHECK(octet_length(raw)<=67108864), financial_raw bytea, fee_payload jsonb,
 predecessor_hash text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(owner_id,id), CHECK(encode(sha256(raw),'hex')=manifest->>'rawSha256'),
 CHECK(financial_raw IS NULL OR encode(sha256(financial_raw),'hex')=manifest->>'financialSha256')
);
CREATE TABLE legacy_source_heads (
 owner_id text PRIMARY KEY REFERENCES users(id), manifest_id uuid NOT NULL REFERENCES legacy_source_manifests(id),
 manifest_sha256 text NOT NULL, revision bigint NOT NULL CHECK(revision>0)
);
CREATE TABLE legacy_source_view_bindings (
 owner_id text NOT NULL,manifest_id uuid NOT NULL,view_kind text NOT NULL CHECK(view_kind IN ('financial','fees')),
 view_sha256 text NOT NULL,PRIMARY KEY(owner_id,manifest_id,view_kind),
 FOREIGN KEY(owner_id,manifest_id) REFERENCES legacy_source_manifests(owner_id,id)
);
CREATE TABLE legacy_source_operations (
 owner_id text NOT NULL REFERENCES users(id), request_id uuid NOT NULL, fingerprint text NOT NULL,
 state text NOT NULL CHECK(state IN ('reading','completed','failed')),
 result jsonb NOT NULL CHECK((result->>'financialApplied')::boolean IS FALSE),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(owner_id,request_id),
 CHECK(state<>'reading' OR (result->>'operationType'='source_export' AND jsonb_typeof(result->'reservationBytes')='number' AND (result->>'reservationBytes')::bigint>0 AND result->>'platformInstance' IS NOT NULL))
);
CREATE TABLE legacy_source_export_policy (
 singleton boolean PRIMARY KEY CHECK(singleton),
 owner_pending integer NOT NULL CHECK(owner_pending BETWEEN 1 AND 2),
 instance_pending integer NOT NULL CHECK(instance_pending BETWEEN 1 AND 4),
 owner_hourly integer NOT NULL CHECK(owner_hourly BETWEEN 1 AND 100),
 instance_hourly integer NOT NULL CHECK(instance_hourly BETWEEN 1 AND 400),
 owner_bytes bigint NOT NULL CHECK(owner_bytes>=16777216),
 instance_bytes bigint NOT NULL CHECK(instance_bytes>=owner_bytes),
 reservation_bytes bigint NOT NULL CHECK(reservation_bytes BETWEEN 16777216 AND owner_bytes)
);
INSERT INTO legacy_source_export_policy VALUES(true,1,2,12,24,268435456,1073741824,67108864);
CREATE TABLE legacy_source_export_windows (
 scope text NOT NULL,bucket timestamptz NOT NULL,attempts integer NOT NULL CHECK(attempts>0),PRIMARY KEY(scope,bucket)
);
ALTER TABLE financial_import_sources ADD COLUMN source_manifest_id uuid REFERENCES legacy_source_manifests(id);
ALTER TABLE fee_legacy_inventory_snapshots ADD COLUMN source_manifest_id uuid REFERENCES legacy_source_manifests(id);
CREATE FUNCTION guard_legacy_source_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE permission legacy_source_grants;
BEGIN
 SELECT * INTO permission FROM legacy_source_grants WHERE id=NEW.grant_id FOR SHARE;
 IF NOT FOUND OR permission.owner_id<>NEW.owner_id OR permission.state<>'active' OR permission.revision<>NEW.grant_revision
 OR permission.platform_instance<>(SELECT instance_id FROM alcor_instance WHERE singleton)
 OR permission.source_instance<>NEW.manifest->'source'->>'instance'
 OR permission.source_owner<>NEW.manifest->'source'->>'owner'
 OR permission.binding_hash IS DISTINCT FROM NEW.manifest->>'sourceBindingHash'
 THEN RAISE EXCEPTION 'source authority is not active for this instance and owner' USING ERRCODE='23514'; END IF;
 IF (NEW.manifest->'coverage'->>'ownerVerified')::boolean AND (NEW.manifest->'coverage'->>'datasetIdentityVerified')::boolean AND NOT EXISTS(SELECT 1 FROM legacy_source_owner_claims c
 WHERE c.source_instance=permission.source_instance AND c.source_owner=permission.source_owner AND c.owner_id=permission.owner_id
 AND c.physical_identity_hash=permission.physical_identity_hash)
 THEN RAISE EXCEPTION 'verified source manifest requires its immutable owner claim' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_source_manifest BEFORE INSERT ON legacy_source_manifests FOR EACH ROW EXECUTE FUNCTION guard_legacy_source_manifest();
CREATE TRIGGER legacy_source_manifest_immutable BEFORE UPDATE OR DELETE ON legacy_source_manifests FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER legacy_source_binding_immutable BEFORE UPDATE OR DELETE ON legacy_source_view_bindings FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE FUNCTION guard_legacy_source_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original legacy_source_manifests;
BEGIN
 SELECT * INTO original FROM legacy_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.manifest_id;
 IF NOT FOUND OR NEW.view_sha256 IS DISTINCT FROM (original.manifest->>(CASE NEW.view_kind WHEN 'fees' THEN 'feeInventorySha256' ELSE 'financialSha256' END))
 THEN RAISE EXCEPTION 'source view digest must match its immutable manifest' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_source_binding BEFORE INSERT ON legacy_source_view_bindings FOR EACH ROW EXECUTE FUNCTION guard_legacy_source_binding();
CREATE FUNCTION guard_legacy_source_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original legacy_source_manifests;
BEGIN
 SELECT * INTO original FROM legacy_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.manifest_id;
 IF NOT FOUND OR original.manifest_sha256<>NEW.manifest_sha256 THEN RAISE EXCEPTION 'source head must match its original manifest' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.revision<>1 OR original.predecessor_hash IS NOT NULL THEN RAISE EXCEPTION 'first source head must have no predecessor' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.owner_id<>OLD.owner_id OR NEW.revision<>OLD.revision+1 OR original.predecessor_hash IS DISTINCT FROM OLD.manifest_sha256 THEN RAISE EXCEPTION 'source head requires exact predecessor CAS' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_source_head BEFORE INSERT OR UPDATE ON legacy_source_heads FOR EACH ROW EXECUTE FUNCTION guard_legacy_source_head();
CREATE FUNCTION guard_legacy_source_grant_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'source consent history is retained' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'state'-'revision'-'approved_at'-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'revision'-'approved_at'-'revoked_at')
 OR NEW.revision<>OLD.revision+1 OR NOT ((OLD.state='pending_owner' AND NEW.state IN ('active','revoked')) OR (OLD.state='active' AND NEW.state='revoked'))
 THEN RAISE EXCEPTION 'source scope cannot change under an existing owner consent' USING ERRCODE='23514'; END IF;
 IF NEW.state='active' AND (NEW.platform_instance<>(SELECT instance_id FROM alcor_instance WHERE singleton)
 OR EXISTS(SELECT 1 FROM legacy_source_owner_claims c WHERE (c.source_instance=NEW.source_instance AND c.source_owner=NEW.source_owner
 OR c.physical_identity_hash=NEW.physical_identity_hash AND c.source_owner=NEW.source_owner)
 AND (c.owner_id<>NEW.owner_id OR c.source_instance<>NEW.source_instance OR c.physical_identity_hash<>NEW.physical_identity_hash)))
 THEN RAISE EXCEPTION 'revoking source access never transfers existing source ownership' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_source_grant_change BEFORE UPDATE OR DELETE ON legacy_source_grants FOR EACH ROW EXECUTE FUNCTION guard_legacy_source_grant_change();
CREATE FUNCTION guard_legacy_source_receipt_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'source receipts are retained' USING ERRCODE='23514'; END IF;
 IF OLD.state<>'reading' OR NEW.state NOT IN ('completed','failed')
 OR (to_jsonb(NEW)-'state'-'result') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'result')
 OR NEW.result->>'state' IS DISTINCT FROM NEW.state OR NEW.result->>'requestId' IS DISTINCT FROM NEW.request_id::text
 THEN RAISE EXCEPTION 'completed source receipts are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_legacy_source_receipt_change BEFORE UPDATE OR DELETE ON legacy_source_operations FOR EACH ROW EXECUTE FUNCTION guard_legacy_source_receipt_change();
CREATE FUNCTION guard_bound_financial_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original legacy_source_manifests;
BEGIN
 SELECT * INTO original FROM legacy_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.source_manifest_id;
 IF NOT FOUND OR original.financial_raw IS NULL OR NEW.raw<>original.financial_raw
 OR NEW.sha256<>original.manifest->>'financialSha256'
 OR NEW.source_instance<>original.manifest->'source'->>'instance'
 OR NEW.source_owner<>original.manifest->'source'->>'owner'
 OR NEW.source_version<>original.manifest->>'rawSha256'
 THEN RAISE EXCEPTION 'financial source must use the authorized original manifest bytes' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_bound_financial_source BEFORE INSERT ON financial_import_sources FOR EACH ROW EXECUTE FUNCTION guard_bound_financial_source();
CREATE FUNCTION guard_authorized_financial_import_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE permitted uuid;
BEGIN
 IF NEW.result->>'financialApplied'='true' THEN
  SELECT g.id INTO permitted FROM financial_import_sources s
  JOIN legacy_source_manifests m ON m.id=s.source_manifest_id AND m.owner_id=s.owner_id
  JOIN legacy_source_grants g ON g.id=m.grant_id AND g.owner_id=m.owner_id
  JOIN legacy_source_owner_claims c ON c.source_instance=g.source_instance AND c.source_owner=g.source_owner
    AND c.owner_id=g.owner_id AND c.physical_identity_hash=g.physical_identity_hash
  WHERE s.owner_id=NEW.owner_id AND s.id::text=NEW.result->>'sourceId' AND g.state='active' AND g.revision=m.grant_revision
    AND g.platform_instance=(SELECT instance_id FROM alcor_instance WHERE singleton)
    AND (m.manifest->'coverage'->>'complete')::boolean AND m.manifest->'normalizationBlockers'='[]'::jsonb
  FOR SHARE OF g;
  IF NOT FOUND THEN RAISE EXCEPTION 'financial import requires an active grant and immutable source owner claim' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_authorized_financial_import_receipt BEFORE INSERT ON financial_import_operations FOR EACH ROW EXECUTE FUNCTION guard_authorized_financial_import_receipt();
CREATE FUNCTION guard_bound_fee_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original legacy_source_manifests;
BEGIN
 SELECT * INTO original FROM legacy_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.source_manifest_id;
 IF NOT FOUND OR original.fee_payload IS NULL OR NEW.payload<>original.fee_payload
 OR NEW.source_digest<>original.manifest->>'feeInventorySha256'
 OR NEW.source_instance<>original.manifest->'source'->>'instance'
 OR NEW.source_owner<>original.manifest->'source'->>'owner'
 OR NEW.complete<>(original.manifest->'coverage'->>'complete')::boolean
 THEN RAISE EXCEPTION 'fee inventory must use the same authorized source manifest' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_bound_fee_source BEFORE INSERT ON fee_legacy_inventory_snapshots FOR EACH ROW EXECUTE FUNCTION guard_bound_fee_source();
-- Existing unbound inventory remains preserved evidence. It cannot authorize a
-- new financial fee correction after source-authority enforcement is installed.
CREATE FUNCTION guard_fee_repair_bound_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE permitted uuid;
BEGIN
 SELECT g.id INTO permitted FROM fee_legacy_inventory_heads f
 JOIN legacy_source_heads h ON h.owner_id=f.owner_id
 JOIN legacy_source_view_bindings b ON b.owner_id=h.owner_id AND b.manifest_id=h.manifest_id
   AND b.view_kind='fees' AND b.view_sha256=f.source_digest
 JOIN legacy_source_manifests m ON m.owner_id=h.owner_id AND m.id=h.manifest_id
 JOIN legacy_source_grants g ON g.id=m.grant_id AND g.owner_id=m.owner_id
 WHERE f.owner_id=NEW.owner_id AND g.state='active' AND g.revision=m.grant_revision
   AND g.platform_instance=(SELECT instance_id FROM alcor_instance WHERE singleton)
   AND (m.manifest->'coverage'->>'complete')::boolean
 FOR SHARE OF g;
 IF NOT FOUND THEN RAISE EXCEPTION 'financial fee correction requires the active shared source manifest' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_fee_repair_bound_manifest BEFORE INSERT ON trade_fee_corrections FOR EACH ROW EXECUTE FUNCTION guard_fee_repair_bound_manifest();
