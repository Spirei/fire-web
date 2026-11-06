-- Isolated candidate evidence only: never a second financial ledger.
CREATE TABLE fee_legacy_inventory_snapshots(
 owner_id text NOT NULL REFERENCES users(id),source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 source_instance text NOT NULL,source_owner text NOT NULL,complete boolean NOT NULL,order_count int NOT NULL CHECK(order_count BETWEEN 0 AND 10000),
 payload jsonb NOT NULL,received_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,source_digest));
CREATE TABLE fee_legacy_inventory_heads(owner_id text PRIMARY KEY REFERENCES users(id),source_digest text NOT NULL,revision bigint NOT NULL CHECK(revision>0),FOREIGN KEY(owner_id,source_digest) REFERENCES fee_legacy_inventory_snapshots(owner_id,source_digest));
CREATE TABLE fee_legacy_inventory_orders(
 owner_id text NOT NULL,source_digest text NOT NULL,original_order_id text NOT NULL,original_record_id text NOT NULL,
 original_broker_id text,mapped_broker_id text,trade_id uuid,fee_authority text NOT NULL CHECK(fee_authority IN ('legacy_import_zero','unverified_legacy','owner_recorded','broker_reported')),
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),payload jsonb NOT NULL,
 PRIMARY KEY(owner_id,source_digest,original_order_id),UNIQUE(owner_id,source_digest,trade_id),
 FOREIGN KEY(owner_id,source_digest) REFERENCES fee_legacy_inventory_snapshots(owner_id,source_digest),
 FOREIGN KEY(owner_id,mapped_broker_id) REFERENCES broker_accounts(owner_id,id),FOREIGN KEY(owner_id,trade_id) REFERENCES trade_ledger(owner_id,id),
 CHECK(original_broker_id IS NOT NULL OR (mapped_broker_id IS NULL AND trade_id IS NULL)),CHECK(trade_id IS NULL OR mapped_broker_id IS NOT NULL));
CREATE TABLE fee_legacy_inventory_receipts(owner_id text NOT NULL REFERENCES users(id),request_id uuid NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL,PRIMARY KEY(owner_id,request_id));
CREATE TABLE fee_legacy_attribution_previews(token_hash text PRIMARY KEY,owner_id text NOT NULL,session_hash text NOT NULL,payload_hash text NOT NULL,source_revision bigint NOT NULL,broker_revision bigint NOT NULL,record_revision bigint NOT NULL,expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',consumed_at timestamptz);
CREATE TABLE fee_legacy_attributions(owner_id text NOT NULL,source_digest text NOT NULL,original_order_id text NOT NULL,account_id text NOT NULL,record_id text NOT NULL,request_id uuid NOT NULL,evidence jsonb NOT NULL,confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(owner_id,source_digest,original_order_id),FOREIGN KEY(owner_id,source_digest,original_order_id) REFERENCES fee_legacy_inventory_orders(owner_id,source_digest,original_order_id),FOREIGN KEY(owner_id,account_id) REFERENCES broker_accounts(owner_id,id),FOREIGN KEY(owner_id,record_id) REFERENCES portfolio_records(owner_id,id));
CREATE TRIGGER fee_inventory_snapshot_immutable BEFORE UPDATE OR DELETE ON fee_legacy_inventory_snapshots FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER fee_inventory_order_immutable BEFORE UPDATE OR DELETE ON fee_legacy_inventory_orders FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER fee_inventory_receipt_immutable BEFORE UPDATE OR DELETE ON fee_legacy_inventory_receipts FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();
CREATE TRIGGER fee_inventory_attribution_immutable BEFORE UPDATE OR DELETE ON fee_legacy_attributions FOR EACH ROW EXECUTE FUNCTION immutable_trade_ledger();

-- The DB guard also requires immutable original-account/cash evidence. An owner
-- confirmation or a record's current broker is not a substitute for that source.
CREATE OR REPLACE FUNCTION check_fee_repair_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original trade_ledger;
BEGIN
    SELECT * INTO original FROM trade_ledger WHERE owner_id=NEW.owner_id AND id=NEW.trade_id;
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
