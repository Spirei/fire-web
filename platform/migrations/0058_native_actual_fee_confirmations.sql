-- New platform calculated fees need a distinct actual statement, never legacy-zero proof bypass.
CREATE FUNCTION native_fee_registration_snapshot(owner_arg text,trade_arg uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('tradeId',t.id,'requestId',t.request_id,'recordId',t.record_id,
  'brokerAccountId',t.account_id,'providerId',a.provider_id,'accountKind',t.account_kind,
  'currency',t.currency,'registeredFee',t.fees::text,'input',t.input_payload,
  'registrationReceipt',o.result,'feeDetail',d.detail,
  'originalCash',jsonb_build_object('id',e.id,'amount',e.amount::text,'currency',e.currency,'requestId',e.request_id,'kind',e.kind,'accountId',e.account_id,'sourceTradeId',e.source_trade_id))
 FROM trade_ledger t JOIN broker_accounts a ON a.owner_id=t.owner_id AND a.id=t.account_id
 JOIN trade_fee_details d ON d.owner_id=t.owner_id AND d.trade_id=t.id
 JOIN trade_operations o ON o.owner_id=t.owner_id AND o.request_id=t.request_id
 JOIN cash_ledger_entries e ON e.owner_id=t.owner_id AND e.source_trade_id=t.id
 WHERE t.owner_id=owner_arg AND t.id=trade_arg AND t.source='owner_recorded' AND t.side IN ('buy','sell')
 AND a.holding_source='manual' AND a.account_kind=t.account_kind
 AND t.currency=t.settlement_currency AND t.settlement_amount IS NULL
 AND t.input_payload->'feeInput'->>'source'='rule_calculated'
 AND t.input_payload->'feeInput'->>'brokerAccountId'=t.account_id
 AND t.input_payload->'feeInput'->>'providerId'=a.provider_id
 AND d.detail->>'source'='rule_calculated' AND d.detail->>'brokerAccountId'=t.account_id
 AND d.detail->>'providerId'=a.provider_id AND d.detail->>'currency'=t.currency
 AND (d.detail->>'total')::numeric=t.fees
 AND o.result->>'state'='completed' AND o.result->>'tradeId'=t.id::text
 AND o.result->>'requestId'=t.request_id::text AND o.result->>'recordId'=t.record_id
 AND o.result->>'accountId'=t.account_id AND o.result->>'source'='owner_recorded'
 AND o.result->>'brokerExecution'='false' AND o.result->'feeDetail'=d.detail
 AND e.account_id=t.account_id AND e.account_kind=t.account_kind AND e.currency=t.currency
 AND e.amount=t.cash_delta AND e.request_id=t.request_id AND e.kind='trade_'||t.side AND e.affects_owner
 AND o.result->>'cashEntryId'=e.id::text
 AND NOT EXISTS(SELECT 1 FROM financial_import_links l WHERE l.owner_id=t.owner_id AND ((l.object_kind='order' AND l.target_id=t.id::text) OR (l.object_kind='cash' AND l.target_id=e.id::text)))
 AND NOT EXISTS(SELECT 1 FROM trade_fee_import_evidence b WHERE b.owner_id=t.owner_id AND b.trade_id=t.id)
 AND NOT EXISTS(SELECT 1 FROM legacy_fee_baseline_bindings b WHERE b.owner_id=t.owner_id AND b.trade_id=t.id)
 AND NOT EXISTS(SELECT 1 FROM fee_legacy_inventory_orders b WHERE b.owner_id=t.owner_id AND b.trade_id=t.id)
$$;
CREATE TABLE native_actual_fee_confirmations (
 owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,trade_id uuid NOT NULL,
 registered_fee numeric NOT NULL,actual_fee numeric NOT NULL,currency text NOT NULL,
 authority text NOT NULL CHECK(authority='owner_recorded'),registration_snapshot jsonb NOT NULL,registration_sha256 text NOT NULL,
 evidence jsonb NOT NULL,evidence_raw bytea NOT NULL,evidence_sha256 text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,request_id,trade_id),UNIQUE(owner_id,trade_id),
 FOREIGN KEY(owner_id,request_id) REFERENCES trade_operations(owner_id,request_id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(owner_id,trade_id) REFERENCES trade_ledger(owner_id,id),
 CHECK(registered_fee>=0 AND registered_fee<1e20 AND scale(registered_fee)<=18 AND actual_fee>=0 AND actual_fee<1e20 AND scale(actual_fee)<=18),
 CHECK(registration_sha256=encode(sha256(convert_to(registration_snapshot::text,'UTF8')),'hex')),
 CHECK(evidence=convert_from(evidence_raw,'UTF8')::jsonb AND evidence_sha256=encode(sha256(evidence_raw),'hex'))
);
CREATE FUNCTION guard_native_actual_fee_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original jsonb;
BEGIN
 original:=native_fee_registration_snapshot(NEW.owner_id,NEW.trade_id);
 IF original IS NULL OR original IS DISTINCT FROM NEW.registration_snapshot
 OR (original->>'registeredFee')::numeric IS DISTINCT FROM NEW.registered_fee OR original->>'currency' IS DISTINCT FROM NEW.currency
 OR NEW.evidence->>'kind' IS DISTINCT FROM 'owner_statement' OR NEW.evidence->>'authority' IS DISTINCT FROM 'owner_recorded'
 OR NEW.evidence->>'targetUserId' IS DISTINCT FROM NEW.owner_id OR NEW.evidence->>'tradeId' IS DISTINCT FROM NEW.trade_id::text
 OR NEW.evidence->>'registrationRequestId' IS DISTINCT FROM original->>'requestId'
 OR NEW.evidence->>'registrationSha256' IS DISTINCT FROM NEW.registration_sha256
 OR NEW.evidence->>'brokerAccountId' IS DISTINCT FROM original->>'brokerAccountId'
 OR NEW.evidence->>'providerId' IS DISTINCT FROM original->>'providerId'
 OR NEW.evidence->>'currency' IS DISTINCT FROM NEW.currency
 OR (NEW.evidence->>'actualFee')::numeric IS DISTINCT FROM NEW.actual_fee
 OR NEW.evidence->>'actualPaidConfirmed' IS DISTINCT FROM 'true'
 OR NEW.evidence->>'historicalCashAttributionConfirmed' IS DISTINCT FROM 'true'
 OR NEW.evidence->>'statement' IS NULL OR length(btrim(NEW.evidence->>'statement')) NOT BETWEEN 1 AND 4096
 THEN RAISE EXCEPTION 'native actual fees require original completed native registration and bound owner statement; imported and broker claims are excluded' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_native_actual_fee_confirmation BEFORE INSERT ON native_actual_fee_confirmations FOR EACH ROW EXECUTE FUNCTION guard_native_actual_fee_confirmation();
CREATE TRIGGER immutable_native_actual_fee_confirmation BEFORE UPDATE OR DELETE ON native_actual_fee_confirmations FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE FUNCTION check_native_actual_fee_confirmation_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM trade_fee_corrections c JOIN trade_operations o ON o.owner_id=c.owner_id AND o.request_id=c.request_id
  WHERE c.owner_id=NEW.owner_id AND c.trade_id=NEW.trade_id AND c.request_id=NEW.request_id
  AND c.old_fees=NEW.registered_fee AND c.new_fees=NEW.actual_fee AND c.detail->>'kind'='native_actual_fee_confirmation'
  AND c.detail->>'authority'='owner_recorded' AND c.detail->>'evidenceSha256'=NEW.evidence_sha256
  AND o.result->>'kind'='native_actual_fee_confirmation' AND o.result->>'state'='completed'
  AND o.result->>'financialApplied'='true' AND o.result->>'actualFeeKnown'='true')
 THEN RAISE EXCEPTION 'native actual fee evidence requires same original UUID final posting receipt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER check_native_actual_fee_confirmation_posting AFTER INSERT ON native_actual_fee_confirmations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_native_actual_fee_confirmation_posting();
ALTER TABLE trade_fee_corrections DROP CONSTRAINT trade_fee_corrections_check;
ALTER TABLE trade_fee_corrections ADD CHECK(old_fees>=0 AND old_fees<1e20 AND scale(old_fees)<=18 AND new_fees>=0 AND new_fees<1e20 AND scale(new_fees)<=18 AND (old_fees=0 OR detail->>'kind'='native_actual_fee_confirmation'));
ALTER TABLE cash_ledger_entries DROP CONSTRAINT cash_posting_sign;
ALTER TABLE cash_ledger_entries ADD CONSTRAINT cash_posting_sign CHECK((kind IN ('opening','external_deposit','allocation') AND amount>=0) OR (kind IN ('external_withdrawal','trade_buy') AND amount<=0) OR kind IN ('reconcile_balance','trade_sell','trade_dividend','fee_correction'));
-- Exact cash delta remains guarded by check_fee_repair_cash; only verified native confirmations may refund registered estimates.
CREATE FUNCTION check_native_actual_fee_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind='fee_correction' AND NEW.amount>0 AND (NOT EXISTS(SELECT 1 FROM native_actual_fee_confirmations n WHERE n.owner_id=NEW.owner_id AND n.request_id=NEW.fee_repair_request_id)
 OR EXISTS(SELECT 1 FROM trade_fee_corrections c WHERE c.owner_id=NEW.owner_id AND c.request_id=NEW.fee_repair_request_id AND c.detail->>'kind' IS DISTINCT FROM 'native_actual_fee_confirmation'))
 THEN RAISE EXCEPTION 'fee refund requires independently confirmed native actual fee difference' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER check_native_actual_fee_refund AFTER INSERT ON cash_ledger_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_native_actual_fee_refund();
CREATE OR REPLACE FUNCTION check_fee_repair_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original trade_ledger;
BEGIN
    SELECT * INTO original FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.trade_id;

    IF NEW.detail->>'kind'='native_actual_fee_confirmation' THEN
        IF original.id IS NULL OR original.fees<>NEW.old_fees OR NOT EXISTS(
            SELECT 1 FROM native_actual_fee_confirmations a WHERE a.owner_id=NEW.owner_id
            AND a.trade_id=NEW.trade_id AND a.request_id=NEW.request_id AND a.registered_fee=NEW.old_fees
            AND a.actual_fee=NEW.new_fees AND a.evidence_sha256=NEW.detail->>'evidenceSha256'
            AND a.evidence=NEW.detail->'evidence' AND NEW.detail->>'authority'='owner_recorded')
        THEN RAISE EXCEPTION 'native actual fee correction requires its exact original registration and owner statement' USING ERRCODE='23514'; END IF;
        IF NOT EXISTS(SELECT 1 FROM cash_ledger_entries e WHERE e.owner_id=NEW.owner_id AND e.fee_repair_request_id=NEW.request_id AND e.kind='fee_correction')
        OR NOT EXISTS(SELECT 1 FROM trade_fee_projections p WHERE p.owner_id=NEW.owner_id AND p.request_id=NEW.request_id AND p.record_id=original.record_id)
        THEN RAISE EXCEPTION 'native actual fee confirmation requires same atomic cash and cost projection' USING ERRCODE='23514'; END IF;
        RETURN NEW;
    END IF;
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

-- Native evidence is independent; every legacy branch retains its original current-manifest requirement.
CREATE OR REPLACE FUNCTION guard_fee_repair_bound_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE permitted uuid;
BEGIN

 IF NEW.detail->>'kind'='native_actual_fee_confirmation' THEN
  IF NOT EXISTS(SELECT 1 FROM native_actual_fee_confirmations a WHERE a.owner_id=NEW.owner_id AND a.trade_id=NEW.trade_id AND a.request_id=NEW.request_id
   AND a.registration_snapshot=native_fee_registration_snapshot(NEW.owner_id,NEW.trade_id)
   AND a.registered_fee=NEW.old_fees AND a.actual_fee=NEW.new_fees
   AND a.evidence_sha256=NEW.detail->>'evidenceSha256' AND a.evidence=NEW.detail->'evidence')
  THEN RAISE EXCEPTION 'native actual correction must independently bind original completed native evidence' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
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
