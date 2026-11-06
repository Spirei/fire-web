-- Pure registered-book verification has no fee-rate/estimate precondition.
CREATE TABLE registered_fee_baseline_previews (
 token_hash text PRIMARY KEY,owner_id text NOT NULL REFERENCES users(id),session_hash text NOT NULL,
 fingerprint text NOT NULL,dependencies jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',consumed_at timestamptz
);
CREATE TABLE registered_fee_baseline_operations (
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id),
 CHECK((result->>'financialApplied'='false' AND result->>'kind'='registered_fee_baseline') IS TRUE)
);
CREATE TABLE registered_fee_baseline_versions (
 owner_id text NOT NULL,request_id uuid NOT NULL,manifest_id uuid NOT NULL,account_id text NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),previous_request_id uuid,result jsonb NOT NULL,
 PRIMARY KEY(owner_id,request_id),UNIQUE(owner_id,account_id,revision),
 FOREIGN KEY(owner_id,request_id) REFERENCES registered_fee_baseline_operations(owner_id,request_id),
 FOREIGN KEY(owner_id,manifest_id) REFERENCES legacy_source_manifests(owner_id,id),
 FOREIGN KEY(owner_id,previous_request_id) REFERENCES registered_fee_baseline_versions(owner_id,request_id),
 CHECK((result->>'financialApplied'='false' AND result->>'actualFeeKnown'='false'
  AND result->>'authority'='verified_registered_book' AND result->'estimatedFees'='null'::jsonb
  AND result->>'state'='completed' AND jsonb_typeof(result->'bindings')='array' AND jsonb_array_length(result->'bindings')>0) IS TRUE)
);
CREATE TABLE registered_fee_baseline_heads (
 owner_id text NOT NULL REFERENCES users(id),account_id text NOT NULL,revision bigint NOT NULL,request_id uuid NOT NULL,
 PRIMARY KEY(owner_id,account_id),FOREIGN KEY(owner_id,request_id) REFERENCES registered_fee_baseline_versions(owner_id,request_id)
);
-- Keep the original 0044 binding immutable. Each re-verification is appended
-- against its actual current manifest and full raw/canonical prefix.
CREATE TABLE registered_fee_baseline_verifications (
 owner_id text NOT NULL,id uuid NOT NULL,request_id uuid NOT NULL,baseline_id uuid NOT NULL,
 first_manifest_id uuid NOT NULL,source_instance text NOT NULL,source_owner text NOT NULL,original_order_id text NOT NULL,
 trade_id uuid NOT NULL,cash_entry_id uuid NOT NULL,record_id text NOT NULL,account_id text NOT NULL,
 registered_fee numeric NOT NULL CHECK(registered_fee=0),actual_fee_known boolean NOT NULL CHECK(NOT actual_fee_known),
 original_row jsonb NOT NULL,canonical_snapshot jsonb NOT NULL,prefix_proof jsonb NOT NULL,
 PRIMARY KEY(owner_id,id),UNIQUE(owner_id,request_id,baseline_id),
 FOREIGN KEY(owner_id,baseline_id) REFERENCES legacy_fee_baseline_bindings(owner_id,id),
 FOREIGN KEY(owner_id,request_id) REFERENCES registered_fee_baseline_versions(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER guard_registered_fee_verification BEFORE INSERT ON registered_fee_baseline_verifications FOR EACH ROW EXECUTE FUNCTION guard_registered_fee_baseline();
CREATE FUNCTION guard_registered_fee_verification_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM legacy_fee_baseline_bindings b WHERE b.owner_id=NEW.owner_id AND b.id=NEW.baseline_id
  AND b.source_instance=NEW.source_instance AND b.source_owner=NEW.source_owner AND b.original_order_id=NEW.original_order_id
  AND b.trade_id=NEW.trade_id AND b.cash_entry_id=NEW.cash_entry_id AND b.record_id=NEW.record_id AND b.account_id=NEW.account_id)
 OR EXISTS(SELECT 1 FROM actual_fee_confirmations a WHERE a.owner_id=NEW.owner_id AND a.trade_id=NEW.trade_id)
 THEN RAISE EXCEPTION 'registered verification cannot replace original identity or known actual fees' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_registered_fee_verification_identity BEFORE INSERT ON registered_fee_baseline_verifications FOR EACH ROW EXECUTE FUNCTION guard_registered_fee_verification_identity();
CREATE FUNCTION guard_registered_fee_baseline_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous registered_fee_baseline_heads;original legacy_source_manifests;item jsonb;
BEGIN
 IF (NEW.result->>'requestId' IS DISTINCT FROM NEW.request_id::text) OR (NEW.result->>'manifestId' IS DISTINCT FROM NEW.manifest_id::text)
 OR (NEW.result->>'brokerAccountId' IS DISTINCT FROM NEW.account_id) OR (NEW.result->>'targetUserId' IS DISTINCT FROM NEW.owner_id)
 OR ((NEW.result->>'revision')::bigint IS DISTINCT FROM NEW.revision)
 THEN RAISE EXCEPTION 'registered baseline metadata identity must match its version' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM registered_fee_baseline_operations o WHERE o.owner_id=NEW.owner_id AND o.request_id=NEW.request_id AND o.result=NEW.result AND o.result->>'state'='completed') THEN RAISE EXCEPTION 'registered baseline version requires its exact final metadata receipt' USING ERRCODE='23514'; END IF;
 SELECT * INTO previous FROM registered_fee_baseline_heads WHERE owner_id=NEW.owner_id AND account_id=NEW.account_id FOR UPDATE;
 IF NEW.revision<>coalesce(previous.revision,0)+1 OR NEW.previous_request_id IS DISTINCT FROM previous.request_id
 THEN RAISE EXCEPTION 'registered baseline requires exact predecessor CAS' USING ERRCODE='23514'; END IF;
 SELECT * INTO original FROM legacy_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.manifest_id;
 IF NOT EXISTS(SELECT 1 FROM legacy_source_grants g JOIN legacy_source_heads h ON h.owner_id=g.owner_id AND h.manifest_id=original.id
  WHERE g.id=original.grant_id AND g.owner_id=NEW.owner_id AND g.state='active' AND g.revision=original.grant_revision
  AND g.platform_instance=(SELECT instance_id FROM alcor_instance WHERE singleton) FOR SHARE OF g,h)
 THEN RAISE EXCEPTION 'new registered baseline requires its current authorized source head' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(NEW.result->'bindings') LOOP
  IF NOT EXISTS(SELECT 1 FROM registered_fee_baseline_verifications v WHERE v.owner_id=NEW.owner_id AND v.request_id=NEW.request_id
   AND v.baseline_id::text=item->>'baselineId' AND v.trade_id::text=item->>'tradeId'
   AND v.original_order_id=item->>'originalOrderId' AND v.first_manifest_id=NEW.manifest_id AND v.account_id=NEW.account_id)
  THEN RAISE EXCEPTION 'every baseline version must bind its full verified original prefix' USING ERRCODE='23514'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_registered_fee_baseline_version BEFORE INSERT ON registered_fee_baseline_versions FOR EACH ROW EXECUTE FUNCTION guard_registered_fee_baseline_version();
CREATE FUNCTION guard_registered_fee_baseline_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM registered_fee_baseline_versions v WHERE v.owner_id=NEW.owner_id AND v.request_id=NEW.request_id AND v.account_id=NEW.account_id AND v.revision=NEW.revision)
 OR (TG_OP='INSERT' AND NEW.revision<>1) OR (TG_OP='UPDATE' AND (NEW.owner_id<>OLD.owner_id OR NEW.account_id<>OLD.account_id OR NEW.revision<>OLD.revision+1))
 THEN RAISE EXCEPTION 'registered baseline head must match its exact completed version' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_registered_fee_baseline_head BEFORE INSERT OR UPDATE ON registered_fee_baseline_heads FOR EACH ROW EXECUTE FUNCTION guard_registered_fee_baseline_head();
CREATE FUNCTION registered_baseline_authorized_for_manifest(owner_arg text,baseline_arg uuid,manifest_arg uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM legacy_fee_baseline_bindings b WHERE b.owner_id=owner_arg AND b.id=baseline_arg AND (b.first_manifest_id=manifest_arg OR EXISTS(
 SELECT 1 FROM registered_fee_baseline_verifications p JOIN registered_fee_baseline_versions v ON v.owner_id=p.owner_id AND v.request_id=p.request_id
 JOIN registered_fee_baseline_operations o ON o.owner_id=v.owner_id AND o.request_id=v.request_id
 WHERE p.owner_id=b.owner_id AND p.baseline_id=b.id AND p.first_manifest_id=manifest_arg AND v.manifest_id=manifest_arg
 AND o.result->>'state'='completed' AND o.result->>'financialApplied'='false')))
$$;
CREATE TRIGGER registered_fee_baseline_operation_immutable BEFORE UPDATE OR DELETE ON registered_fee_baseline_operations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER registered_fee_baseline_version_immutable BEFORE UPDATE OR DELETE ON registered_fee_baseline_versions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER registered_fee_baseline_verification_immutable BEFORE UPDATE OR DELETE ON registered_fee_baseline_verifications FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

-- Re-verification preserves the original binding and grants no new financial authority.
CREATE OR REPLACE FUNCTION guard_actual_fee_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE baseline legacy_fee_baseline_bindings;original legacy_source_manifests;fill trade_ledger;
BEGIN
 SELECT * INTO baseline FROM legacy_fee_baseline_bindings WHERE owner_id=NEW.owner_id AND id=NEW.baseline_id;
 SELECT * INTO original FROM legacy_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.manifest_id;
 SELECT * INTO fill FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.trade_id;
 IF baseline.id IS NULL OR original.id IS NULL OR fill.id IS NULL
 OR baseline.trade_id<>fill.id OR NOT registered_baseline_authorized_for_manifest(NEW.owner_id,baseline.id,original.id)
 OR baseline.canonical_snapshot IS DISTINCT FROM legacy_fee_registered_target_snapshot(NEW.owner_id,NEW.trade_id)
 OR fill.source NOT IN ('legacy_import_zero','unverified_legacy') OR fill.fees<>0 OR fill.side NOT IN ('buy','sell')
 OR fill.currency<>NEW.currency OR fill.settlement_currency<>NEW.currency OR fill.settlement_amount IS NOT NULL
 OR original.manifest->'orderFacts'->baseline.original_order_id->>'actualFeeKnown' IS DISTINCT FROM 'false'
 OR original.manifest->'orderFacts'->baseline.original_order_id->>'registeredFee' IS NULL
 OR (original.manifest->'orderFacts'->baseline.original_order_id->>'registeredFee')::numeric<>0
 THEN RAISE EXCEPTION 'actual fee confirmation must retain its exact original registered baseline' USING ERRCODE='23514'; END IF;
 IF NEW.evidence->>'kind' IS DISTINCT FROM 'owner_statement' OR NEW.evidence->>'authority' IS DISTINCT FROM 'owner_recorded'
 OR NEW.evidence->>'targetUserId' IS DISTINCT FROM NEW.owner_id
 OR NEW.evidence->>'manifestSha256' IS DISTINCT FROM original.manifest_sha256
 OR NEW.evidence->>'originalOrderId' IS DISTINCT FROM baseline.original_order_id
 OR NEW.evidence->>'tradeId' IS DISTINCT FROM NEW.trade_id::text
 OR NEW.evidence->>'brokerAccountId' IS DISTINCT FROM fill.account_id
 OR NEW.evidence->>'currency' IS DISTINCT FROM NEW.currency
 OR NEW.evidence->>'actualFee' IS NULL OR (NEW.evidence->>'actualFee')::numeric IS DISTINCT FROM NEW.actual_fee
 OR NEW.evidence->>'actualPaidConfirmed' IS DISTINCT FROM 'true'
 OR NEW.evidence->>'historicalCashAttributionConfirmed' IS DISTINCT FROM 'true'
 OR NEW.evidence->>'statement' IS NULL OR length(btrim(NEW.evidence->>'statement')) NOT BETWEEN 1 AND 4096
 THEN RAISE EXCEPTION 'owner actual fees require a bound owner statement; a broker label never grants authority' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM legacy_source_grants g JOIN legacy_source_owner_claims c ON c.owner_id=g.owner_id
   AND c.source_instance=g.source_instance AND c.source_owner=g.source_owner AND c.physical_identity_hash=g.physical_identity_hash
   JOIN legacy_source_heads h ON h.owner_id=g.owner_id AND h.manifest_id=original.id
   WHERE g.id=original.grant_id AND g.owner_id=NEW.owner_id AND g.state='active' AND g.revision=original.grant_revision
   AND g.platform_instance=(SELECT instance_id FROM alcor_instance WHERE singleton)
   AND (original.manifest->'coverage'->>'complete')::boolean FOR SHARE OF g,h)
 THEN RAISE EXCEPTION 'new actual fee confirmation requires its current authorized original owner' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION check_registered_fee_baseline_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.result->>'state'='completed' AND NOT EXISTS(SELECT 1 FROM registered_fee_baseline_versions v WHERE v.owner_id=NEW.owner_id AND v.request_id=NEW.request_id AND v.result=NEW.result)
 THEN RAISE EXCEPTION 'completed registered baseline receipt requires its atomic verified metadata version' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER check_registered_fee_baseline_receipt AFTER INSERT ON registered_fee_baseline_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_registered_fee_baseline_receipt();
