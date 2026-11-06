-- One global old policy may be assigned to exactly one explicit ledger kind.
CREATE TABLE financing_source_policy_claims(
 owner_id text NOT NULL REFERENCES users(id),physical_identity_hash text NOT NULL,source_owner text NOT NULL,source_instance text NOT NULL,
 account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),first_request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(physical_identity_hash,source_owner),
 FOREIGN KEY(source_instance,source_owner) REFERENCES legacy_source_owner_claims(source_instance,source_owner),
 FOREIGN KEY(owner_id,first_request_id) REFERENCES trade_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION guard_financing_source_policy_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM legacy_source_owner_claims c WHERE c.owner_id=NEW.owner_id AND c.source_instance=NEW.source_instance AND c.source_owner=NEW.source_owner AND c.physical_identity_hash=NEW.physical_identity_hash)
 THEN RAISE EXCEPTION 'source policy assignment requires exact conserved source-owner claim' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_financing_source_policy_claim BEFORE INSERT ON financing_source_policy_claims FOR EACH ROW EXECUTE FUNCTION guard_financing_source_policy_claim();
CREATE TRIGGER immutable_financing_source_policy_claim BEFORE UPDATE OR DELETE ON financing_source_policy_claims FOR EACH ROW EXECUTE FUNCTION immutable_financial_import_evidence();
CREATE TABLE financing_source_policy_mappings(
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,manifest_id uuid NOT NULL,manifest_sha256 text NOT NULL,
 account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),policy jsonb NOT NULL,policy_raw bytea NOT NULL,policy_sha256 text NOT NULL,
 source_head_revision bigint NOT NULL CHECK(source_head_revision>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id),FOREIGN KEY(owner_id,manifest_id) REFERENCES legacy_source_manifests(owner_id,id),
 FOREIGN KEY(owner_id,request_id) REFERENCES trade_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 CHECK(policy=convert_from(policy_raw,'UTF8')::jsonb AND policy_sha256=encode(sha256(policy_raw),'hex'))
);
CREATE TABLE financing_source_policy_heads(
 owner_id text NOT NULL REFERENCES users(id),account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),request_id uuid NOT NULL,
 PRIMARY KEY(owner_id,account_kind),FOREIGN KEY(owner_id,request_id) REFERENCES financing_source_policy_mappings(owner_id,request_id)
);
CREATE FUNCTION guard_financing_source_policy_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original legacy_source_manifests;permission legacy_source_grants;
BEGIN
 SELECT * INTO original FROM legacy_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.manifest_id;
 SELECT * INTO permission FROM legacy_source_grants WHERE id=original.grant_id;
 IF original.manifest_sha256 IS DISTINCT FROM NEW.manifest_sha256 OR permission.owner_id IS DISTINCT FROM NEW.owner_id OR permission.state IS DISTINCT FROM 'active' OR permission.revision IS DISTINCT FROM original.grant_revision
 OR NOT EXISTS(SELECT 1 FROM alcor_instance i WHERE i.instance_id=permission.platform_instance)
 OR NOT EXISTS(SELECT 1 FROM legacy_source_heads h WHERE h.owner_id=NEW.owner_id AND h.manifest_id=NEW.manifest_id AND h.revision=NEW.source_head_revision)
 OR NOT EXISTS(SELECT 1 FROM financing_source_policy_claims c WHERE c.owner_id=NEW.owner_id AND c.physical_identity_hash=permission.physical_identity_hash AND c.source_owner=permission.source_owner AND c.account_kind=NEW.account_kind)
 OR NOT (convert_from(original.raw,'UTF8')::jsonb->'tables' ? 'account_financing_policy')
 THEN RAISE EXCEPTION 'source policy mapping requires the current consented exact archive and one ledger-kind assignment' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_financing_source_policy_mapping BEFORE INSERT ON financing_source_policy_mappings FOR EACH ROW EXECUTE FUNCTION guard_financing_source_policy_mapping();
CREATE TRIGGER immutable_financing_source_policy_mapping BEFORE UPDATE OR DELETE ON financing_source_policy_mappings FOR EACH ROW EXECUTE FUNCTION immutable_financial_import_evidence();
CREATE FUNCTION guard_financing_source_policy_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM financing_source_policy_mappings m WHERE m.owner_id=NEW.owner_id AND m.account_kind=NEW.account_kind AND m.request_id=NEW.request_id)
 THEN RAISE EXCEPTION 'source policy head must retain exact owner and ledger-kind mapping' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_financing_source_policy_head BEFORE INSERT OR UPDATE ON financing_source_policy_heads FOR EACH ROW EXECUTE FUNCTION guard_financing_source_policy_head();
CREATE TRIGGER retain_financing_source_policy_head BEFORE DELETE ON financing_source_policy_heads FOR EACH ROW EXECUTE FUNCTION immutable_financial_import_evidence();
CREATE FUNCTION check_financing_source_policy_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM trade_operations o WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.request_id AND o.result->>'state'='completed' AND o.result->>'kind'='financing_policy' AND o.result->'policy'=NEW.policy AND o.result->'sourcePolicy'->>'manifestId'=NEW.manifest_id::text AND o.result->'sourcePolicy'->>'manifestSha256'=NEW.manifest_sha256 AND o.result->>'sourcePolicyKindConfirmed'='true')
 OR NOT EXISTS(SELECT 1 FROM financing_source_policy_heads h WHERE h.owner_id=NEW.owner_id AND h.account_kind=NEW.account_kind AND h.request_id=NEW.request_id)
 THEN RAISE EXCEPTION 'source policy mapping, head and original UUID receipt must commit atomically' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER check_financing_source_policy_receipt AFTER INSERT ON financing_source_policy_mappings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_financing_source_policy_receipt();

CREATE OR REPLACE FUNCTION guard_financing_policy_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous financing_policy_heads;item text;
BEGIN
 SELECT * INTO previous FROM financing_policy_heads WHERE owner_id=NEW.owner_id AND account_kind=NEW.account_kind FOR UPDATE;
 IF NEW.revision<>coalesce(previous.revision,0)+1 OR NEW.previous_id IS DISTINCT FROM previous.request_id
 OR NEW.policy<>'null'::jsonb AND (NEW.policy->>'currency' NOT IN ('USD','EUR','HKD','MOP','CNY','JPY','KRW','SGD','GBP','AUD','CAD','TWD','CHF','INR','BRL')
 OR NEW.policy->>'currency' IS NULL OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(NEW.policy) key) IS DISTINCT FROM ARRAY['currency','initialMargin','limit','maintenanceMargin']::text[])
 THEN RAISE EXCEPTION 'financing policy needs an exact owner-kind predecessor and supported declared currency' USING ERRCODE='23514'; END IF;
 FOREACH item IN ARRAY ARRAY['limit','initialMargin','maintenanceMargin'] LOOP
  IF NEW.policy->item IS DISTINCT FROM 'null'::jsonb AND ((NEW.policy->>item)::numeric NOT BETWEEN 0 AND 9007199254740991 OR scale((NEW.policy->>item)::numeric)>18)
  THEN RAISE EXCEPTION 'financing amount exceeds exact declared range' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF (NEW.policy->>'initialMargin' IS NULL)<>(NEW.policy->>'maintenanceMargin' IS NULL)
 OR NEW.policy->>'maintenanceMargin' IS NOT NULL AND ((NEW.policy->>'maintenanceMargin')::numeric<=0 OR (NEW.policy->>'initialMargin')::numeric<(NEW.policy->>'maintenanceMargin')::numeric)
 THEN RAISE EXCEPTION 'margin fields are paired amounts, not inferred ratios' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION check_financing_policy_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM trade_operations o WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.request_id AND o.result->>'state'='completed' AND o.result->>'kind'='financing_policy' AND o.result->>'accountKind'=NEW.account_kind AND (o.result->>'policyRevision')::bigint=NEW.revision)
 OR NOT EXISTS(SELECT 1 FROM financing_policy_heads h WHERE h.owner_id=NEW.owner_id AND h.account_kind=NEW.account_kind AND h.request_id=NEW.request_id AND h.revision=NEW.revision)
 OR NEW.policy='null'::jsonb AND NOT EXISTS(SELECT 1 FROM financing_source_policy_mappings m WHERE m.owner_id=NEW.owner_id AND m.request_id=NEW.request_id AND m.account_kind=NEW.account_kind AND m.policy='null'::jsonb)
 THEN RAISE EXCEPTION 'financing policy head and completed original UUID must commit atomically' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE TABLE financing_source_policy_request_archives(
 owner_id text NOT NULL REFERENCES users(id),original_request_id uuid NOT NULL,account_kind text NOT NULL CHECK(account_kind IN ('real','simulated')),
 payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),result_raw bytea NOT NULL,result_sha256 text NOT NULL,manifest_id uuid NOT NULL,mapping_request_id uuid NOT NULL,
 PRIMARY KEY(owner_id,original_request_id),FOREIGN KEY(owner_id,original_request_id) REFERENCES trade_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,manifest_id) REFERENCES legacy_source_manifests(owner_id,id),FOREIGN KEY(owner_id,mapping_request_id) REFERENCES financing_source_policy_mappings(owner_id,request_id),
 CHECK(result_sha256=encode(sha256(result_raw),'hex') AND octet_length(result_raw)<=8192)
);
CREATE TRIGGER immutable_financing_source_policy_request_archive BEFORE UPDATE OR DELETE ON financing_source_policy_request_archives FOR EACH ROW EXECUTE FUNCTION immutable_financial_import_evidence();
CREATE FUNCTION guard_financing_source_policy_request_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM financing_source_policy_mappings p JOIN legacy_source_manifests m ON m.owner_id=p.owner_id AND m.id=p.manifest_id CROSS JOIN LATERAL jsonb_array_elements(convert_from(m.raw,'UTF8')::jsonb->'tables'->'account_financing_requests'->'rows') original WHERE p.owner_id=NEW.owner_id AND p.request_id=NEW.mapping_request_id AND p.manifest_id=NEW.manifest_id AND p.account_kind=NEW.account_kind AND (original->'request_id'->>'text')::uuid=NEW.original_request_id AND original->'payload'->>'text'=NEW.payload_hash AND convert_to(original->'result'->>'text','UTF8')=NEW.result_raw)
 OR NOT EXISTS(SELECT 1 FROM trade_operations o WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.original_request_id AND o.result->>'sourcePolicyArchive'='true' AND o.result->>'sourceOriginalResultSha256'=NEW.result_sha256 AND o.result->>'sourceOriginalPayloadHash'=NEW.payload_hash)
 THEN RAISE EXCEPTION 'archived policy UUID must retain exact original source row and own immutable receipt' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_financing_source_policy_request_archive BEFORE INSERT ON financing_source_policy_request_archives FOR EACH ROW EXECUTE FUNCTION guard_financing_source_policy_request_archive();
CREATE FUNCTION guard_archived_source_policy_uuid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM trade_operations o WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.request_id AND o.result->>'sourcePolicyArchive'='true')
 THEN RAISE EXCEPTION 'original UUID belongs to an archived source financing policy' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_archived_source_policy_uuid BEFORE INSERT ON cash_ledger_entries FOR EACH ROW EXECUTE FUNCTION guard_archived_source_policy_uuid();
