-- Explicit owner statements of actual paid fees never inherit rate authority.
CREATE TABLE actual_fee_confirmations (
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,trade_id uuid NOT NULL,
 manifest_id uuid NOT NULL,baseline_id uuid NOT NULL,actual_fee numeric NOT NULL,
 currency text NOT NULL,authority text NOT NULL CHECK(authority='owner_recorded'),
 evidence jsonb NOT NULL,evidence_raw bytea NOT NULL,evidence_sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner_id,request_id,trade_id),UNIQUE(owner_id,trade_id),
 FOREIGN KEY(owner_id,request_id) REFERENCES trade_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,trade_id) REFERENCES trade_ledger(owner_id,id),
 FOREIGN KEY(owner_id,manifest_id) REFERENCES legacy_source_manifests(owner_id,id),
 FOREIGN KEY(owner_id,baseline_id) REFERENCES legacy_fee_baseline_bindings(owner_id,id),
 CHECK(actual_fee>=0 AND actual_fee<1e20 AND scale(actual_fee)<=18),
 CHECK(evidence=convert_from(evidence_raw,'UTF8')::jsonb AND evidence_sha256=encode(sha256(evidence_raw),'hex'))
);
CREATE FUNCTION guard_actual_fee_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE baseline legacy_fee_baseline_bindings;original legacy_source_manifests;fill trade_ledger;
BEGIN
 SELECT * INTO baseline FROM legacy_fee_baseline_bindings WHERE owner_id=NEW.owner_id AND id=NEW.baseline_id;
 SELECT * INTO original FROM legacy_source_manifests WHERE owner_id=NEW.owner_id AND id=NEW.manifest_id;
 SELECT * INTO fill FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.trade_id;
 IF baseline.id IS NULL OR original.id IS NULL OR fill.id IS NULL
 OR baseline.trade_id<>fill.id OR baseline.first_manifest_id<>original.id
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
CREATE TRIGGER guard_actual_fee_confirmation BEFORE INSERT ON actual_fee_confirmations FOR EACH ROW EXECUTE FUNCTION guard_actual_fee_confirmation();
CREATE TRIGGER actual_fee_confirmation_immutable BEFORE UPDATE OR DELETE ON actual_fee_confirmations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE FUNCTION check_actual_fee_confirmation_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM trade_fee_corrections c JOIN trade_operations o ON o.owner_id=c.owner_id AND o.request_id=c.request_id
   WHERE c.owner_id=NEW.owner_id AND c.trade_id=NEW.trade_id AND c.request_id=NEW.request_id
   AND c.old_fees=0 AND c.new_fees=NEW.actual_fee AND c.detail->>'kind'='actual_fee_confirmation'
   AND c.detail->>'authority'='owner_recorded' AND c.detail->>'evidenceSha256'=NEW.evidence_sha256
   AND o.result->>'kind'='actual_fee_confirmation' AND o.result->>'state'='completed'
   AND o.result->>'financialApplied'='true' AND o.result->>'actualFeeKnown'='true')
 THEN RAISE EXCEPTION 'actual fee evidence requires its same atomic cash position and final UUID receipt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER check_actual_fee_confirmation_posting AFTER INSERT ON actual_fee_confirmations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_actual_fee_confirmation_posting();
CREATE OR REPLACE FUNCTION check_fee_repair_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original trade_ledger;
BEGIN
    SELECT * INTO original FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.trade_id;
    -- An explicit actual statement has its own immutable, deferred evidence.
    -- The old source-inventory branch below remains byte-for-byte unchanged.
    IF NEW.detail->>'kind'='actual_fee_confirmation' THEN
        IF NOT EXISTS(SELECT 1 FROM actual_fee_confirmations a WHERE a.owner_id=NEW.owner_id
            AND a.trade_id=NEW.trade_id AND a.request_id=NEW.request_id AND NEW.old_fees=0
            AND a.actual_fee=NEW.new_fees AND a.authority='owner_recorded'
            AND a.evidence_sha256=NEW.detail->>'evidenceSha256'
            AND a.evidence=NEW.detail->'evidence' AND NEW.detail->>'authority'='owner_recorded')
        THEN RAISE EXCEPTION 'actual fee correction requires its independently bound actual statement' USING ERRCODE='23514'; END IF;
        IF NOT EXISTS(SELECT 1 FROM cash_ledger_entries e WHERE e.owner_id=NEW.owner_id AND e.fee_repair_request_id=NEW.request_id AND e.kind='fee_correction')
        OR NOT EXISTS(SELECT 1 FROM trade_fee_projections p WHERE p.owner_id=NEW.owner_id AND p.request_id=NEW.request_id AND p.record_id=original.record_id)
        THEN RAISE EXCEPTION 'actual confirmation requires original cash attribution and position projection' USING ERRCODE='23514'; END IF;
        RETURN NEW;
    END IF;
    IF NOT FOUND OR original.fees<>NEW.old_fees OR original.source NOT IN ('legacy_import_zero','unverified_legacy') OR original.side NOT IN ('buy','sell') THEN
        RAISE EXCEPTION 'explicit actual fees are protected' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(
        SELECT 1 FROM trade_fee_import_evidence e
        JOIN fee_legacy_inventory_heads h ON h.owner_id=e.owner_id
        JOIN fee_legacy_inventory_snapshots s ON s.owner_id=h.owner_id AND s.source_digest=h.source_digest
        JOIN fee_legacy_inventory_orders i ON i.owner_id=h.owner_id AND i.source_digest=h.source_digest AND i.trade_id=e.trade_id
        WHERE e.owner_id=NEW.owner_id AND e.trade_id=NEW.trade_id AND s.complete
          AND i.original_broker_id IS NOT NULL AND i.mapped_broker_id=original.account_id
          AND e.detail->>'feeAuthority'=original.source
          AND i.payload->'input'->>'fees' IS NOT NULL
          AND (i.payload->'input'->>'fees')::numeric=original.fees
          AND i.payload->'input'->>'currency'=original.currency
          AND i.payload->'input'->>'settlementCurrency'=original.settlement_currency
          AND i.payload->'input'->>'accountKind'=original.account_kind
          AND e.detail->'sourceCashAttribution'->>'scope'='broker'
          AND e.detail->'sourceCashAttribution'->>'alreadyReflected'='true'
          AND e.detail->'sourceCashAttribution'->>'brokerAccountId'=i.original_broker_id
          AND e.detail->'sourceCashAttribution'->>'currency'=original.settlement_currency
    ) THEN RAISE EXCEPTION 'historical fee correction requires original cash evidence' USING ERRCODE='23514'; END IF;
    IF original.source='unverified_legacy' AND NEW.detail->'confirmation'->>'legacyImportConfirmed' IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'legacy omission requires per-order owner review' USING ERRCODE='23514';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM cash_ledger_entries e WHERE e.owner_id=NEW.owner_id AND e.fee_repair_request_id=NEW.request_id AND e.kind='fee_correction') OR NOT EXISTS(SELECT 1 FROM trade_fee_projections p WHERE p.owner_id=NEW.owner_id AND p.request_id=NEW.request_id AND p.record_id=original.record_id) THEN
        RAISE EXCEPTION 'fee correction requires cash and position projection' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END $$;
